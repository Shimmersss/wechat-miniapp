-- 每日一致数据快照、私有文件副本、30天保留、可核验恢复，以及带保护清单的过期对象清理。
CREATE TABLE maintenance_settings(id int PRIMARY KEY CHECK(id=1),created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO maintenance_settings VALUES(1,now());
CREATE TABLE maintenance_protections(kind text NOT NULL CHECK(kind IN('upload','report','backup')),record_id text NOT NULL,reason text NOT NULL CHECK(length(trim(reason))>0),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(kind,record_id));
-- 当前环境均为迁移验证数据：先保护已有验收对象，不能把验证证据当垃圾删掉。
INSERT INTO maintenance_protections(kind,record_id,reason) SELECT 'upload',id::text,'上线前已有上传，保留迁移验收证据；人工甄别后另行处理' FROM file_uploads;
INSERT INTO maintenance_protections(kind,record_id,reason) SELECT 'report',id::text,'上线前已有报表，保留迁移验收证据；人工甄别后另行处理' FROM report_exports;
CREATE TABLE maintenance_backup_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),day date NOT NULL UNIQUE,status text NOT NULL DEFAULT 'running' CHECK(status IN('running','complete','failed','purged')),snapshot_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,manifest jsonb NOT NULL DEFAULT '{}',manifest_sha text,lease uuid,lease_until timestamptz,last_error text NOT NULL DEFAULT '',failures int NOT NULL DEFAULT 0);
CREATE TABLE maintenance_backup_rows(job_id uuid NOT NULL REFERENCES maintenance_backup_jobs(id),table_name text NOT NULL,seq bigint NOT NULL,data jsonb NOT NULL,PRIMARY KEY(job_id,table_name,seq));
CREATE TABLE maintenance_backup_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES maintenance_backup_jobs(id),kind text NOT NULL CHECK(kind IN('data','media','manifest')),table_name text,first_seq bigint,last_seq bigint,object_key text NOT NULL,source_name text,mime text,expected_size bigint,expected_sha text,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','complete')),result jsonb,UNIQUE(job_id,object_key));
CREATE TABLE maintenance_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,kind text NOT NULL,object_id text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE maintenance_gc_tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN('upload','report','backup')),record_id text NOT NULL,bucket text NOT NULL,object_key text NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','complete','skipped')),lease uuid,lease_until timestamptz,last_error text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,UNIQUE(bucket,object_key));
CREATE TABLE maintenance_gc_scans(kind text NOT NULL,record_id text NOT NULL,completed_at timestamptz,PRIMARY KEY(kind,record_id));
CREATE TABLE maintenance_restore_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),manifest jsonb NOT NULL,status text NOT NULL DEFAULT 'loading',created_at timestamptz NOT NULL DEFAULT now(),verified_at timestamptz,result jsonb);
CREATE TABLE maintenance_restore_chunks(run_id uuid NOT NULL REFERENCES maintenance_restore_runs(id),object_key text NOT NULL,sha256 text NOT NULL,PRIMARY KEY(run_id,object_key));
CREATE SCHEMA xiamu_restore;
REVOKE ALL ON SCHEMA xiamu_restore FROM PUBLIC,anon,authenticated;
GRANT USAGE,CREATE ON SCHEMA xiamu_restore TO service_role;
DO $$ DECLARE v_name text;BEGIN FOREACH v_name IN ARRAY ARRAY['maintenance_settings','maintenance_protections','maintenance_backup_jobs','maintenance_backup_rows','maintenance_backup_tasks','maintenance_events','maintenance_gc_tasks','maintenance_gc_scans','maintenance_restore_runs','maintenance_restore_chunks'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',v_name);EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,anon,authenticated',v_name);EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',v_name);END LOOP;END $$;
REVOKE UPDATE,DELETE ON maintenance_events,maintenance_protections FROM service_role;
GRANT USAGE,SELECT ON SEQUENCE maintenance_events_id_seq TO service_role;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('xiamu-backups','业务备份与恢复',false,33554432,NULL);
CREATE POLICY xiamu_backups_server_only ON storage.objects AS RESTRICTIVE TO anon,authenticated USING(bucket_id<>'xiamu-backups') WITH CHECK(bucket_id<>'xiamu-backups');
CREATE FUNCTION maintenance_guard() RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN PERFORM id FROM maintenance_settings WHERE id=1;END $$;
CREATE FUNCTION maintenance_table_info() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE v_result jsonb;
BEGIN
 PERFORM maintenance_guard();
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'generated',a.attgenerated,'identity',a.attidentity,'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'pk',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num WHERE i.indrelid=c.oid AND i.indisprimary),
 'foreignKeys',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',fk.conname,'columns',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(fk.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.num),'target',ref.relname,'targetColumns',(SELECT jsonb_agg(a.attname ORDER BY k.ord) FROM unnest(fk.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=fk.confrelid AND a.attnum=k.num)) ORDER BY fk.conname),'[]') FROM pg_constraint fk JOIN pg_class ref ON ref.oid=fk.confrelid WHERE fk.conrelid=c.oid AND fk.contype='f')) ORDER BY c.relname),'[]') INTO v_result FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND (c.relname NOT LIKE 'maintenance\_%' ESCAPE '\' OR c.relname IN('maintenance_events','maintenance_protections')) AND c.relname NOT IN('sessions','sms_challenges','sms_send_budget','agent_request_limits','file_uploads');
 RETURN v_result;
END $$;
CREATE FUNCTION maintenance_backup_snapshot(p_day date) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
DECLARE v_job uuid;v_tables jsonb;v_table jsonb;v_name text;v_order text;v_union text:='';v_count bigint;v_sha text;v_totals jsonb;v_external jsonb;
BEGIN
 PERFORM maintenance_guard();PERFORM pg_advisory_xact_lock(hashtextextended('backup:'||p_day::text,0));
 SELECT id INTO v_job FROM maintenance_backup_jobs WHERE day=p_day;IF FOUND THEN RETURN v_job;END IF;
 v_tables:=maintenance_table_info();IF jsonb_array_length(v_tables)=0 THEN PERFORM stock_error('P0503','没有可备份业务表');END IF;
 INSERT INTO maintenance_backup_jobs(day) VALUES(p_day) RETURNING id INTO v_job;
 FOR v_table IN SELECT value FROM jsonb_array_elements(v_tables) LOOP
  v_name:=v_table->>'name';SELECT string_agg(format('%I',value),',') INTO v_order FROM jsonb_array_elements_text(v_table->'pk');IF v_order IS NULL THEN PERFORM stock_error('P0503','备份表缺少稳定主键');END IF;
  EXECUTE format('LOCK TABLE public.%I IN ACCESS SHARE MODE',v_name);
  v_union:=v_union||CASE WHEN v_union='' THEN '' ELSE ' UNION ALL ' END||format('SELECT %L::uuid,%L,row_number() OVER(ORDER BY %s),to_jsonb(t) FROM public.%I t',v_job,v_name,v_order,v_name);
 END LOOP;
 -- 只有这一条INSERT SELECT读取全部业务数据：同一条SQL的MVCC快照，不分页读活表。
 EXECUTE 'INSERT INTO maintenance_backup_rows(job_id,table_name,seq,data) '||v_union;
 FOR v_table IN SELECT value FROM jsonb_array_elements(v_tables) LOOP
  v_name:=v_table->>'name';SELECT count(*),encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(data::text,'UTF8')),'hex'),'' ORDER BY seq),''),'UTF8')),'hex') INTO v_count,v_sha FROM maintenance_backup_rows WHERE job_id=v_job AND table_name=v_name;
  v_tables:=jsonb_set(v_tables,ARRAY[(SELECT (n-1)::text FROM jsonb_array_elements(v_tables) WITH ORDINALITY a(val,n) WHERE val->>'name'=v_name)],v_table||jsonb_build_object('rows',v_count,'sha256',v_sha));
  INSERT INTO maintenance_backup_tasks(job_id,kind,table_name,first_seq,last_seq,object_key)
  SELECT v_job,'data',v_name,min(seq),max(seq),'daily/'||p_day||'/'||v_job||'/tables/'||v_name||'/'||min(seq)||'.json.gz' FROM(SELECT seq,floor((sum(octet_length(data::text)) OVER(ORDER BY seq)-octet_length(data::text))/262144.0) batch FROM maintenance_backup_rows WHERE job_id=v_job AND table_name=v_name)q GROUP BY batch;
 END LOOP;
 INSERT INTO maintenance_backup_tasks(job_id,kind,object_key,source_name,mime,expected_size,expected_sha)
 SELECT v_job,'media','daily/'||p_day||'/'||v_job||'/media/'||(r.data->>'id'),r.data->>'stored_name',r.data->>'mime',(r.data->>'byte_size')::bigint,r.data->>'sha256' FROM maintenance_backup_rows r JOIN file_uploads fu ON fu.id=(r.data->>'id')::uuid AND fu.status='ready' WHERE r.job_id=v_job AND r.table_name='files';
 SELECT coalesce(jsonb_agg(jsonb_build_object('fileId',r.data->'id','storedName',r.data->'stored_name','reason','未登记为已完成的云上传，二进制留待数据迁移阶段核对')),'[]') INTO v_external FROM maintenance_backup_rows r WHERE r.job_id=v_job AND r.table_name='files' AND NOT EXISTS(SELECT 1 FROM file_uploads fu WHERE fu.id=(r.data->>'id')::uuid AND fu.status='ready');
 SELECT jsonb_build_object('units',(SELECT count(*) FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='units'),'unitCost',(SELECT coalesce(sum((data->>'cost')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='units'),'salesAmount',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='sales_orders'),'refundAmount',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='sales_refunds'),'agentEarnings',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='agent_earnings'),'files',(SELECT count(*) FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='files')) INTO v_totals;
 UPDATE maintenance_backup_jobs SET manifest=jsonb_build_object('format','xiamu-backup-v1','jobId',v_job,'day',p_day,'snapshotAt',snapshot_at,'tables',v_tables,'totals',v_totals,'externalFiles',v_external,'excludedEphemeralTables',jsonb_build_array('sessions','sms_challenges','sms_send_budget','agent_request_limits','file_uploads')) WHERE id=v_job;
 INSERT INTO maintenance_events(kind,object_id,detail) VALUES('backup_snapshot',v_job::text,jsonb_build_object('tables',jsonb_array_length(v_tables),'totals',v_totals));RETURN v_job;
END $$;
CREATE FUNCTION api_maintenance_backup(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
DECLARE v_job maintenance_backup_jobs;v_id uuid;v_nonce uuid;v_task maintenance_backup_tasks;v_tasks jsonb:='[]';v_payload text;v_item jsonb;v_parts jsonb;v_hash text;v_day date:=(p_data->>'day')::date;
BEGIN
 PERFORM maintenance_guard();
 IF p_action='take' THEN
  v_id:=maintenance_backup_snapshot(v_day);SELECT * INTO v_job FROM maintenance_backup_jobs WHERE id=v_id FOR UPDATE;
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
GRANT SELECT ON storage.objects TO service_role;
CREATE FUNCTION maintenance_gc_eligible(p_kind text,p_record text,p_bucket text,p_key text) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
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
  RETURN FOUND AND v_job.status='complete' AND v_job.completed_at<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs WHERE status='complete' AND completed_at>v_job.completed_at) AND p_bucket='xiamu-backups' AND (p_key LIKE 'daily/'||v_job.day||'/'||p_record||'/%' OR p_key='daily/'||v_job.day||'/complete.json');
 END IF;RETURN false;
END $$;
CREATE FUNCTION api_maintenance_gc(p_action text,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
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
  FOR v_candidate IN SELECT 'backup'::text kind,j.id::text id,j.day FROM maintenance_backup_jobs j WHERE j.status='complete' AND j.completed_at<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs newer WHERE newer.status='complete' AND newer.completed_at>j.completed_at) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='backup' AND p.record_id=j.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans s WHERE s.kind='backup' AND s.record_id=j.id::text AND s.completed_at IS NOT NULL) ORDER BY j.completed_at LIMIT 10 LOOP
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
   EXISTS(SELECT 1 FROM maintenance_backup_jobs j WHERE status='complete' AND completed_at<now()-interval '30 days' AND EXISTS(SELECT 1 FROM maintenance_backup_jobs newer WHERE newer.status='complete' AND newer.completed_at>j.completed_at) AND NOT EXISTS(SELECT 1 FROM maintenance_protections p WHERE p.kind='backup' AND p.record_id=j.id::text) AND NOT EXISTS(SELECT 1 FROM maintenance_gc_scans z WHERE z.kind='backup' AND z.record_id=j.id::text AND z.completed_at IS NOT NULL)));
 ELSIF p_action IN('authorize','ack','fail') THEN
  SELECT * INTO v_task FROM maintenance_gc_tasks WHERE id=(p_data->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR v_task.lease IS DISTINCT FROM (p_data->>'lease')::uuid OR v_task.lease_until<=now() OR v_task.status<>'pending' THEN PERFORM stock_error('P0409','清理租约已变更');END IF;
  IF p_action='authorize' THEN RETURN jsonb_build_object('allowed',maintenance_gc_eligible(v_task.kind,v_task.record_id,v_task.bucket,v_task.object_key));END IF;
  IF p_action='fail' THEN UPDATE maintenance_gc_tasks SET lease=NULL,lease_until=NULL,last_error=left(p_data->>'message',500) WHERE id=v_task.id;RETURN '{}'::jsonb;END IF;
  UPDATE maintenance_gc_tasks SET status=CASE WHEN p_data->>'skipped'='true' THEN 'skipped' ELSE 'complete' END,completed_at=now(),lease=NULL,lease_until=NULL WHERE id=v_task.id;
  INSERT INTO maintenance_events(kind,object_id,detail) VALUES(CASE WHEN p_data->>'skipped'='true' THEN 'gc_skipped' ELSE 'gc_deleted' END,v_task.id::text,jsonb_build_object('kind',v_task.kind,'record',v_task.record_id,'bucket',v_task.bucket,'key',v_task.object_key,'reason','过期24小时且无登记引用，或备份超过30天且有较新完整备份；保护记录除外'));
  IF NOT EXISTS(SELECT 1 FROM maintenance_gc_tasks WHERE kind=v_task.kind AND record_id=v_task.record_id AND status='pending') THEN
   UPDATE maintenance_gc_scans SET completed_at=now() WHERE kind=v_task.kind AND record_id=v_task.record_id;
   IF v_task.kind='backup' AND NOT EXISTS(SELECT 1 FROM maintenance_protections WHERE kind='backup' AND record_id=v_task.record_id) THEN UPDATE maintenance_backup_jobs SET status='purged' WHERE id=v_task.record_id::uuid;END IF;
  END IF;RETURN '{}'::jsonb;
 END IF;PERFORM stock_error('P0404','清理操作不存在');
END $$;
CREATE FUNCTION api_maintenance_restore(p_action text,p_run uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
DECLARE v_run maintenance_restore_runs;v_manifest jsonb;v_current jsonb;v_table jsonb;v_live jsonb;v_col jsonb;v_fk jsonb;v_part jsonb;v_name text;v_target text;v_prefix text;v_cols text;v_refcols text;v_sha text;v_count bigint;v_expected bigint;v_seq text;v_max bigint;v_report jsonb:='[]';v_totals jsonb;v_rows jsonb;v_sum text;
BEGIN
 PERFORM maintenance_guard();
 IF p_action='begin' THEN
  v_manifest:=p_data->'manifest';IF v_manifest->>'format'<>'xiamu-backup-v1' OR jsonb_typeof(v_manifest->'tables')<>'array' OR jsonb_typeof(v_manifest->'parts')<>'array' THEN PERFORM stock_error('P0400','备份清单无效');END IF;
  v_current:=maintenance_table_info();IF jsonb_array_length(v_current)<>jsonb_array_length(v_manifest->'tables') THEN PERFORM stock_error('P0409','备份与当前迁移版本不一致，请先重建匹配的表结构');END IF;
  INSERT INTO maintenance_restore_runs(manifest) VALUES(v_manifest) RETURNING * INTO v_run;
  v_prefix:='r'||substr(replace(v_run.id::text,'-',''),1,12)||'_';
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_manifest->'tables') LOOP
   v_name:=v_table->>'name';SELECT value INTO v_live FROM jsonb_array_elements(v_current) WHERE value->>'name'=v_name;
   IF v_live IS NULL OR v_live->'columns' IS DISTINCT FROM v_table->'columns' OR v_live->'pk' IS DISTINCT FROM v_table->'pk' OR v_live->'foreignKeys' IS DISTINCT FROM v_table->'foreignKeys' THEN PERFORM stock_error('P0409','备份表结构不匹配，拒绝静默丢字段');END IF;
   v_target:=v_prefix||v_name;EXECUTE format('CREATE TABLE xiamu_restore.%I (LIKE public.%I INCLUDING ALL)',v_target,v_name);
   EXECUTE format('ALTER TABLE xiamu_restore.%I ENABLE ROW LEVEL SECURITY',v_target);EXECUTE format('REVOKE ALL ON xiamu_restore.%I FROM PUBLIC,anon,authenticated',v_target);
   FOR v_col IN SELECT value FROM jsonb_array_elements(v_table->'columns') LOOP
    IF v_col->>'identity'='' AND v_col->>'default' LIKE 'nextval(%' THEN
     v_seq:=v_target||'_'||(v_col->>'name')||'_seq';EXECUTE format('CREATE SEQUENCE xiamu_restore.%I',v_seq);EXECUTE format('ALTER SEQUENCE xiamu_restore.%I OWNED BY xiamu_restore.%I.%I',v_seq,v_target,v_col->>'name');EXECUTE format('ALTER TABLE xiamu_restore.%I ALTER COLUMN %I SET DEFAULT nextval(%L::regclass)',v_target,v_col->>'name','xiamu_restore.'||v_seq);
    END IF;
   END LOOP;
  END LOOP;
  RETURN jsonb_build_object('id',v_run.id,'schema','xiamu_restore','prefix',v_prefix);
 END IF;
 SELECT * INTO v_run FROM maintenance_restore_runs WHERE id=p_run FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','恢复演练不存在');END IF;
 IF v_run.status='verified' THEN RETURN v_run.result;END IF;
 v_prefix:='r'||substr(replace(v_run.id::text,'-',''),1,12)||'_';
 IF p_action='chunk' THEN
  SELECT value INTO v_part FROM jsonb_array_elements(v_run.manifest->'parts') WHERE value->>'key'=p_data->>'key' AND value->>'kind'='data';
  v_sha:=encode(sha256(convert_to(p_data->>'payload','UTF8')),'hex');
  IF v_part IS NULL OR v_part->>'sha256' IS DISTINCT FROM v_sha THEN PERFORM stock_error('P0400','备份数据分片摘要不匹配');END IF;
  IF EXISTS(SELECT 1 FROM maintenance_restore_chunks WHERE run_id=p_run AND object_key=p_data->>'key') THEN RETURN jsonb_build_object('replayed',true);END IF;
  v_rows:=(p_data->>'payload')::jsonb;v_name:=v_part->>'table';IF v_rows->>'table' IS DISTINCT FROM v_name THEN PERFORM stock_error('P0400','备份分片表名不一致');END IF;
  SELECT value INTO v_table FROM jsonb_array_elements(v_run.manifest->'tables') WHERE value->>'name'=v_name;
  SELECT string_agg(format('%I',value->>'name'),',') INTO v_cols FROM jsonb_array_elements(v_table->'columns') WHERE value->>'generated'='';
  EXECUTE format('INSERT INTO xiamu_restore.%I(%s) OVERRIDING SYSTEM VALUE SELECT %s FROM jsonb_populate_recordset(NULL::xiamu_restore.%I,$1->''rows'')',v_prefix||v_name,v_cols,v_cols,v_prefix||v_name) USING v_rows;
  INSERT INTO maintenance_restore_chunks(run_id,object_key,sha256) VALUES(p_run,p_data->>'key',v_sha);RETURN jsonb_build_object('rows',jsonb_array_length(v_rows->'rows'));
 ELSIF p_action='verify' THEN
  IF (SELECT count(*) FROM maintenance_restore_chunks WHERE run_id=p_run)<>(SELECT count(*) FROM jsonb_array_elements(v_run.manifest->'parts') WHERE value->>'kind'='data') THEN PERFORM stock_error('P0409','备份分片尚未全部恢复');END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_run.manifest->'tables') LOOP
   v_name:=v_table->>'name';v_target:=v_prefix||v_name;
   SELECT string_agg(format('%I',value),',') INTO v_cols FROM jsonb_array_elements_text(v_table->'pk');
   EXECUTE format('SELECT count(*),encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex''),'''' ORDER BY %s),''''),''UTF8'')),''hex'') FROM xiamu_restore.%I t',v_cols,v_target) INTO v_count,v_sha;
   IF v_count<>(v_table->>'rows')::bigint OR v_sha IS DISTINCT FROM v_table->>'sha256' THEN PERFORM stock_error('P0400','恢复表行数或完整内容摘要不一致');END IF;
   v_report:=v_report||jsonb_build_array(jsonb_build_object('table',v_name,'rows',v_count,'sha256',v_sha));
   FOR v_fk IN SELECT value FROM jsonb_array_elements(v_table->'foreignKeys') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_run.manifest->'tables') WHERE value->>'name'=v_fk->>'target') THEN PERFORM stock_error('P0400','备份缺少外键依赖表');END IF;
    SELECT string_agg(format('%I',value),',') INTO v_cols FROM jsonb_array_elements_text(v_fk->'columns');SELECT string_agg(format('%I',value),',') INTO v_refcols FROM jsonb_array_elements_text(v_fk->'targetColumns');
    v_seq:='fk_'||substr(md5(v_name||(v_fk->>'name')),1,20);
    EXECUTE format('ALTER TABLE xiamu_restore.%I ADD CONSTRAINT %I FOREIGN KEY(%s) REFERENCES xiamu_restore.%I(%s) NOT VALID',v_target,v_seq,v_cols,v_prefix||(v_fk->>'target'),v_refcols);
    EXECUTE format('ALTER TABLE xiamu_restore.%I VALIDATE CONSTRAINT %I',v_target,v_seq);
   END LOOP;
   FOR v_col IN SELECT value FROM jsonb_array_elements(v_table->'columns') LOOP
    IF v_col->>'identity'<>'' OR v_col->>'default' LIKE 'nextval(%' THEN
     v_seq:=pg_get_serial_sequence(format('xiamu_restore.%I',v_target),v_col->>'name');
     IF v_seq IS NULL OR v_seq NOT LIKE 'xiamu_restore.%' THEN PERFORM stock_error('P0400','恢复序列未隔离，拒绝修改线上序列');END IF;
     EXECUTE format('SELECT coalesce(max(%I),0)+1 FROM xiamu_restore.%I',v_col->>'name',v_target) INTO v_max;PERFORM setval(v_seq::regclass,greatest(v_max,1),false);
    END IF;
   END LOOP;
  END LOOP;
  EXECUTE format('SELECT jsonb_build_object(''units'',(SELECT count(*) FROM xiamu_restore.%I),''unitCost'',(SELECT coalesce(sum(cost),0)::text FROM xiamu_restore.%I),''salesAmount'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''refundAmount'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''agentEarnings'',(SELECT coalesce(sum(amount),0)::text FROM xiamu_restore.%I),''files'',(SELECT count(*) FROM xiamu_restore.%I))',v_prefix||'units',v_prefix||'units',v_prefix||'sales_orders',v_prefix||'sales_refunds',v_prefix||'agent_earnings',v_prefix||'files') INTO v_totals;
  IF v_totals IS DISTINCT FROM v_run.manifest->'totals' THEN PERFORM stock_error('P0400','恢复后的库存/销售/退款/收益金额不一致');END IF;
  UPDATE maintenance_restore_runs SET status='verified',verified_at=now(),result=jsonb_build_object('id',p_run,'status','verified','tables',v_report,'totals',v_totals,'foreignKeysValidated',true,'sequencesIsolated',true) WHERE id=p_run RETURNING result INTO v_rows;
  INSERT INTO maintenance_events(kind,object_id,detail) VALUES('restore_verified',p_run::text,jsonb_build_object('totals',v_totals,'tables',jsonb_array_length(v_report)));RETURN v_rows;
 END IF;PERFORM stock_error('P0404','恢复操作不存在');
END $$;
REVOKE ALL ON FUNCTION maintenance_guard(),maintenance_table_info(),maintenance_backup_snapshot(date),api_maintenance_backup(text,jsonb),maintenance_gc_eligible(text,text,text,text),api_maintenance_gc(text,jsonb),api_maintenance_restore(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION maintenance_guard(),maintenance_table_info(),maintenance_backup_snapshot(date),api_maintenance_backup(text,jsonb),maintenance_gc_eligible(text,text,text,text),api_maintenance_gc(text,jsonb),api_maintenance_restore(text,uuid,jsonb) TO service_role;
