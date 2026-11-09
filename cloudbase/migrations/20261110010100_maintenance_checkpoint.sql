-- 跨日断点与失败归档的保留期：不遗留旧队列、不把失败备份标成完整，不删除最后一份健康备份。
ALTER TABLE maintenance_backup_jobs ADD COLUMN marker_written boolean NOT NULL DEFAULT false;
UPDATE maintenance_backup_jobs j SET marker_written=true WHERE status='complete' AND EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id='xiamu-backups' AND o.name='daily/'||j.day||'/complete.json');
CREATE OR REPLACE FUNCTION api_maintenance_backup(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
DECLARE v_job maintenance_backup_jobs;v_id uuid;v_nonce uuid;v_task maintenance_backup_tasks;v_tasks jsonb:='[]';v_payload text;v_item jsonb;v_parts jsonb;v_hash text;v_day date:=(p_data->>'day')::date;
BEGIN
 PERFORM maintenance_guard();
 IF p_action='marker' THEN
  SELECT * INTO v_job FROM maintenance_backup_jobs WHERE id=(p_data->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'complete' OR v_job.manifest_sha IS DISTINCT FROM p_data->>'manifestSha' THEN PERFORM stock_error('P0409','备份清单未完成或摘要不一致');END IF;
  UPDATE maintenance_backup_jobs SET marker_written=true WHERE id=v_job.id;RETURN '{}'::jsonb;
 END IF;
 IF p_action='resume' THEN
  UPDATE maintenance_backup_jobs SET status='running',failures=0,last_error='',lease=NULL,lease_until=NULL WHERE day=v_day AND status='failed';RETURN jsonb_build_object('resumed',FOUND);
 END IF;
 IF p_action='take' THEN
  -- 跨越每日切点仍有未完成任务时，先完成旧快照和完成标记，再创建当天快照。
  SELECT id INTO v_id FROM maintenance_backup_jobs WHERE day<=v_day AND (status='running' OR (status='complete' AND NOT marker_written)) ORDER BY day LIMIT 1;
  IF v_id IS NULL THEN v_id:=maintenance_backup_snapshot(v_day);END IF;SELECT * INTO v_job FROM maintenance_backup_jobs WHERE id=v_id FOR UPDATE;
  IF v_job.status='complete' THEN RETURN jsonb_build_object('status','complete','jobId',v_id,'day',v_job.day,'manifest',v_job.manifest,'manifestSha',v_job.manifest_sha);END IF;
  IF v_job.status IN('failed','purged') THEN RETURN jsonb_build_object('status','failed','jobId',v_id);END IF;
  IF v_job.lease_until>now() THEN RETURN jsonb_build_object('status','busy');END IF;
  IF NOT EXISTS(SELECT 1 FROM maintenance_backup_tasks WHERE job_id=v_id AND status='pending') THEN
   SELECT coalesce(jsonb_agg(result ORDER BY object_key),'[]') INTO v_parts FROM maintenance_backup_tasks WHERE job_id=v_id AND kind<>'manifest';
   UPDATE maintenance_backup_jobs SET manifest=manifest||jsonb_build_object('parts',v_parts) WHERE id=v_id RETURNING * INTO v_job;
   INSERT INTO maintenance_backup_tasks(job_id,kind,object_key) VALUES(v_id,'manifest','daily/'||v_job.day||'/'||v_id||'/manifest.json') ON CONFLICT DO NOTHING;
  END IF;
  v_nonce:=gen_random_uuid();UPDATE maintenance_backup_jobs SET lease=v_nonce,lease_until=now()+interval '30 seconds' WHERE id=v_id;
  FOR v_task IN SELECT * FROM maintenance_backup_tasks WHERE job_id=v_id AND status='pending' ORDER BY CASE kind WHEN 'data' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,object_key LIMIT 3 LOOP
   v_payload:=NULL;
   IF v_task.kind='data' THEN SELECT jsonb_build_object('table',v_task.table_name,'rows',jsonb_agg(data ORDER BY seq))::text INTO v_payload FROM maintenance_backup_rows WHERE job_id=v_id AND table_name=v_task.table_name AND seq BETWEEN v_task.first_seq AND v_task.last_seq;END IF;
   IF v_task.kind='manifest' THEN v_payload:=v_job.manifest::text;END IF;
   v_tasks:=v_tasks||jsonb_build_array(jsonb_build_object('id',v_task.id,'kind',v_task.kind,'key',v_task.object_key,'table',v_task.table_name,'rows',v_task.last_seq-v_task.first_seq+1,'source',v_task.source_name,'mime',v_task.mime,'size',v_task.expected_size,'sha256',v_task.expected_sha,'payload',v_payload));
  END LOOP;
  RETURN jsonb_build_object('status','running','jobId',v_id,'day',v_job.day,'lease',v_nonce,'tasks',v_tasks);
 ELSIF p_action IN('ack','fail') THEN
  SELECT * INTO v_job FROM maintenance_backup_jobs WHERE id=(p_data->>'jobId')::uuid FOR UPDATE;
  IF NOT FOUND OR v_job.lease IS DISTINCT FROM (p_data->>'lease')::uuid OR v_job.lease_until<=now() THEN PERFORM stock_error('P0409','备份租约已变更');END IF;
  IF p_action='fail' THEN
   UPDATE maintenance_backup_jobs SET lease=NULL,lease_until=NULL,failures=failures+1,last_error=left(coalesce(p_data->>'message','备份失败'),500),status=CASE WHEN failures>=4 THEN 'failed' ELSE status END WHERE id=v_job.id;
   INSERT INTO maintenance_events(kind,object_id,detail) VALUES('backup_error',v_job.id::text,jsonb_build_object('message',left(p_data->>'message',500)));RETURN jsonb_build_object('status','retry');
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_data->'results') LOOP
   SELECT * INTO v_task FROM maintenance_backup_tasks WHERE id=(v_item->>'id')::uuid AND job_id=v_job.id FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0400','备份任务无效');END IF;
   IF v_task.kind IN('data','manifest') THEN
    IF v_task.kind='manifest' THEN v_payload:=v_job.manifest::text;ELSE SELECT jsonb_build_object('table',v_task.table_name,'rows',jsonb_agg(data ORDER BY seq))::text INTO v_payload FROM maintenance_backup_rows WHERE job_id=v_job.id AND table_name=v_task.table_name AND seq BETWEEN v_task.first_seq AND v_task.last_seq;END IF;
    v_hash:=encode(sha256(convert_to(v_payload,'UTF8')),'hex');IF v_hash IS DISTINCT FROM v_item->>'sha256' THEN PERFORM stock_error('P0400','备份内容摘要不一致');END IF;
   ELSIF (v_item->>'bytes')::bigint IS DISTINCT FROM v_task.expected_size THEN PERFORM stock_error('P0400','备份媒体大小不一致');END IF;
   UPDATE maintenance_backup_tasks SET status='complete',result=(v_item-'id')||jsonb_build_object('key',v_task.object_key,'kind',v_task.kind,'table',v_task.table_name,'source',v_task.source_name,'expectedSha',v_task.expected_sha) WHERE id=v_task.id;
   IF v_task.kind='manifest' THEN
    UPDATE maintenance_backup_jobs SET status='complete',completed_at=now(),manifest_sha=v_hash WHERE id=v_job.id;
    DELETE FROM maintenance_backup_rows WHERE job_id=v_job.id;
    INSERT INTO maintenance_events(kind,object_id,detail) VALUES('backup_complete',v_job.id::text,jsonb_build_object('manifestSha',v_hash,'totals',v_job.manifest->'totals'));
   END IF;
  END LOOP;
  UPDATE maintenance_backup_jobs SET lease=NULL,lease_until=NULL WHERE id=v_job.id;RETURN jsonb_build_object('status','acknowledged');
 END IF;
 PERFORM stock_error('P0404','备份操作不存在');
END $$;
CREATE OR REPLACE FUNCTION maintenance_gc_eligible(p_kind text,p_record text,p_bucket text,p_key text) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_upload file_uploads;v_report report_exports;v_job maintenance_backup_jobs;
BEGIN
 PERFORM maintenance_guard();
 IF EXISTS(SELECT 1 FROM maintenance_protections WHERE kind=p_kind AND record_id=p_record) THEN RETURN false;END IF;
 IF p_kind='upload' THEN
  SELECT * INTO v_upload FROM file_uploads WHERE id=p_record::uuid;
  IF NOT FOUND OR v_upload.expires_at>now()-interval '24 hours' OR v_upload.lease_until>now() THEN RETURN false;END IF;
  IF p_bucket NOT IN('xiamu-staging','xiamu-sealed','xiamu-public','xiamu-internal') OR NOT(p_key=p_record OR (p_key LIKE p_record||'-%' AND p_key ~ ('^'||p_record||'-[a-f0-9-]{36}$'))) THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM files WHERE stored_name=p_bucket||'/'||p_key) THEN RETURN false;END IF;
  RETURN true;
 ELSIF p_kind='report' THEN
  SELECT * INTO v_report FROM report_exports WHERE id=p_record::uuid;
  RETURN FOUND AND v_report.expires_at<now()-interval '24 hours' AND p_bucket='xiamu-reports' AND p_key ~ ('^reports/'||p_record||'/[a-f0-9]{64}\.csv$');
 ELSIF p_kind='backup' THEN
  SELECT * INTO v_job FROM maintenance_backup_jobs WHERE id=p_record::uuid;
  RETURN FOUND AND v_job.status IN('complete','failed') AND coalesce(v_job.completed_at,v_job.snapshot_at)<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs WHERE status='complete' AND completed_at>coalesce(v_job.completed_at,v_job.snapshot_at)) AND p_bucket='xiamu-backups' AND (p_key LIKE 'daily/'||v_job.day||'/'||p_record||'/%' OR p_key='daily/'||v_job.day||'/complete.json');
 END IF;RETURN false;
END $$;
CREATE OR REPLACE FUNCTION api_maintenance_gc(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_candidate record;v_object record;v_task maintenance_gc_tasks;v_nonce uuid;v_tasks jsonb:='[]';v_prefix text;v_kind text;v_id text;v_pending int;
BEGIN
 PERFORM maintenance_guard();
 IF p_action='take' THEN
  -- 候选记录有独立完成游标；已无对象的旧记录不会反复占住前50条导致后面的垃圾饥饿。
  FOR v_candidate IN
   SELECT 'upload'::text kind,u.id::text id FROM file_uploads u WHERE u.expires_at<now()-interval '24 hours' AND (u.lease_until IS NULL OR u.lease_until<=now()) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='upload' AND p.record_id=u.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans s WHERE s.kind='upload' AND s.record_id=u.id::text AND s.completed_at IS NOT NULL) ORDER BY u.expires_at LIMIT 50
  LOOP
   INSERT INTO maintenance_gc_scans(kind,record_id) VALUES(v_candidate.kind,v_candidate.id) ON CONFLICT DO NOTHING;
   FOR v_object IN SELECT o.bucket_id,o.name FROM storage.objects o WHERE o.bucket_id IN('xiamu-staging','xiamu-sealed','xiamu-public','xiamu-internal') AND o.name>=v_candidate.id AND o.name<v_candidate.id||'~' LOOP
    IF maintenance_gc_eligible('upload',v_candidate.id,v_object.bucket_id,v_object.name) THEN INSERT INTO maintenance_gc_tasks(kind,record_id,bucket,object_key) VALUES('upload',v_candidate.id,v_object.bucket_id,v_object.name) ON CONFLICT DO NOTHING;END IF;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE kind='upload' AND record_id=v_candidate.id AND status='pending') THEN UPDATE maintenance_gc_scans SET completed_at=now() WHERE kind='upload' AND record_id=v_candidate.id;END IF;
  END LOOP;
  FOR v_candidate IN SELECT 'report'::text kind,r.id::text id FROM report_exports r WHERE r.expires_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='report' AND p.record_id=r.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans s WHERE s.kind='report' AND s.record_id=r.id::text AND s.completed_at IS NOT NULL) ORDER BY r.expires_at LIMIT 50 LOOP
   INSERT INTO maintenance_gc_scans(kind,record_id) VALUES('report',v_candidate.id) ON CONFLICT DO NOTHING;
   v_prefix:='reports/'||v_candidate.id||'/';
   FOR v_object IN SELECT bucket_id,name FROM storage.objects WHERE bucket_id='xiamu-reports' AND name>=v_prefix AND name<v_prefix||'~' LOOP
    IF maintenance_gc_eligible('report',v_candidate.id,v_object.bucket_id,v_object.name) THEN INSERT INTO maintenance_gc_tasks(kind,record_id,bucket,object_key) VALUES('report',v_candidate.id,v_object.bucket_id,v_object.name) ON CONFLICT DO NOTHING;END IF;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE kind='report' AND record_id=v_candidate.id AND status='pending') THEN UPDATE maintenance_gc_scans SET completed_at=now() WHERE kind='report' AND record_id=v_candidate.id;END IF;
  END LOOP;
  FOR v_candidate IN SELECT 'backup'::text kind,j.id::text id,j.day FROM maintenance_backup_jobs j WHERE j.status IN('complete','failed') AND coalesce(j.completed_at,j.snapshot_at)<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs newer WHERE newer.status='complete' AND newer.completed_at>coalesce(j.completed_at,j.snapshot_at)) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='backup' AND p.record_id=j.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans s WHERE s.kind='backup' AND s.record_id=j.id::text AND s.completed_at IS NOT NULL) ORDER BY j.completed_at LIMIT 10 LOOP
   INSERT INTO maintenance_gc_scans(kind,record_id) VALUES('backup',v_candidate.id) ON CONFLICT DO NOTHING;
   v_prefix:='daily/'||v_candidate.day||'/'||v_candidate.id||'/';
   FOR v_object IN SELECT bucket_id,name FROM storage.objects WHERE bucket_id='xiamu-backups' AND ((name>=v_prefix AND name<v_prefix||'~') OR name='daily/'||v_candidate.day||'/complete.json') LOOP
    IF maintenance_gc_eligible('backup',v_candidate.id,v_object.bucket_id,v_object.name) THEN INSERT INTO maintenance_gc_tasks(kind,record_id,bucket,object_key) VALUES('backup',v_candidate.id,v_object.bucket_id,v_object.name) ON CONFLICT DO NOTHING;END IF;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE kind='backup' AND record_id=v_candidate.id AND status='pending') THEN UPDATE maintenance_gc_scans SET completed_at=now() WHERE kind='backup' AND record_id=v_candidate.id;END IF;
  END LOOP;
  FOR v_task IN SELECT * FROM maintenance_gc_tasks WHERE status='pending' AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id LIMIT 3 FOR UPDATE SKIP LOCKED LOOP
   IF NOT maintenance_gc_eligible(v_task.kind,v_task.record_id,v_task.bucket,v_task.object_key) THEN UPDATE maintenance_gc_tasks SET status='skipped',completed_at=now() WHERE id=v_task.id;CONTINUE;END IF;
   v_nonce:=gen_random_uuid();UPDATE maintenance_gc_tasks SET lease=v_nonce,lease_until=now()+interval '30 seconds' WHERE id=v_task.id;
   v_tasks:=v_tasks||jsonb_build_array(jsonb_build_object('id',v_task.id,'lease',v_nonce,'bucket',v_task.bucket,'key',v_task.object_key));
  END LOOP;
  RETURN jsonb_build_object('tasks',v_tasks,'more',EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE status='pending') OR
   EXISTS(SELECT 1 FROM file_uploads u WHERE u.expires_at<now()-interval '24 hours' AND (u.lease_until IS NULL OR u.lease_until<=now()) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='upload' AND p.record_id=u.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans z WHERE z.kind='upload' AND z.record_id=u.id::text AND z.completed_at IS NOT NULL)) OR
   EXISTS(SELECT 1 FROM report_exports r WHERE r.expires_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='report' AND p.record_id=r.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans z WHERE z.kind='report' AND z.record_id=r.id::text AND z.completed_at IS NOT NULL)) OR
   EXISTS(SELECT 1 FROM maintenance_backup_jobs j WHERE status IN('complete','failed') AND coalesce(completed_at,snapshot_at)<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs newer WHERE newer.status='complete' AND newer.completed_at>coalesce(j.completed_at,j.snapshot_at)) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='backup' AND p.record_id=j.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans z WHERE z.kind='backup' AND z.record_id=j.id::text AND z.completed_at IS NOT NULL)));
 ELSIF p_action IN('authorize','ack','fail') THEN
  SELECT * INTO v_task FROM maintenance_gc_tasks WHERE id=(p_data->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_task.lease IS DISTINCT FROM (p_data->>'lease')::uuid OR v_task.lease_until<=now() OR v_task.status<>'pending' THEN PERFORM stock_error('P0409','清理租约已变更');END IF;
  IF p_action='authorize' THEN RETURN jsonb_build_object('allowed',maintenance_gc_eligible(v_task.kind,v_task.record_id,v_task.bucket,v_task.object_key));END IF;
  IF p_action='fail' THEN UPDATE maintenance_gc_tasks SET lease=NULL,lease_until=NULL,last_error=left(p_data->>'message',500) WHERE id=v_task.id;RETURN '{}'::jsonb;END IF;
  UPDATE maintenance_gc_tasks SET status=CASE WHEN p_data->>'skipped'='true' THEN 'skipped' ELSE 'complete' END,completed_at=now(),lease=NULL,lease_until=NULL WHERE id=v_task.id;
  INSERT INTO maintenance_events(kind,object_id,detail) VALUES(CASE WHEN p_data->>'skipped'='true' THEN 'gc_skipped' ELSE 'gc_deleted' END,v_task.id::text,jsonb_build_object('kind',v_task.kind,'record',v_task.record_id,'bucket',v_task.bucket,'key',v_task.object_key,'reason','过期24小时且无登记引用，或备份超过30天且有较新完整备份；保护记录除外'));
  IF NOT EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE kind=v_task.kind AND record_id=v_task.record_id AND status='pending') THEN
   UPDATE maintenance_gc_scans SET completed_at=now() WHERE kind=v_task.kind AND record_id=v_task.record_id;
   IF v_task.kind='backup' AND NOT EXISTS(SELECT 1 FROM maintenance_protections WHERE kind='backup' AND record_id=v_task.record_id) THEN UPDATE maintenance_backup_jobs SET status='purged' WHERE id=v_task.record_id::uuid;DELETE FROM maintenance_backup_rows WHERE job_id=v_task.record_id::uuid;END IF;
  END IF;RETURN '{}'::jsonb;
 END IF;PERFORM stock_error('P0404','清理操作不存在');
END $$;
REVOKE ALL ON FUNCTION api_maintenance_backup(text,jsonb),maintenance_gc_eligible(text,text,text,text),api_maintenance_gc(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_maintenance_backup(text,jsonb),maintenance_gc_eligible(text,text,text,text),api_maintenance_gc(text,jsonb) TO service_role;
