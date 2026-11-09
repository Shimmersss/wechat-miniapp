-- 已登记文件是备份事实来源；恢复时不恢复短期上传会话，后续备份仍须收录全部正式媒体。
CREATE OR REPLACE FUNCTION maintenance_backup_snapshot(p_day date) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET timezone='UTC' AS $$
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
 SELECT v_job,'media','daily/'||p_day||'/'||v_job||'/media/'||(r.data->>'id'),r.data->>'stored_name',r.data->>'mime',(r.data->>'byte_size')::bigint,r.data->>'sha256' FROM maintenance_backup_rows r WHERE r.job_id=v_job AND r.table_name='files' AND r.data->>'stored_name' ~ '^xiamu-(public|internal)/[a-f0-9-]{36}(-[a-f0-9-]{36})?$' AND r.data->>'sha256' ~ '^[a-f0-9]{64}$';
 SELECT coalesce(jsonb_agg(jsonb_build_object('fileId',r.data->'id','storedName',r.data->'stored_name','reason','未登记为已完成的云上传，二进制留待数据迁移阶段核对')),'[]') INTO v_external FROM maintenance_backup_rows r WHERE r.job_id=v_job AND r.table_name='files' AND NOT (coalesce(r.data->>'stored_name','') ~ '^xiamu-(public|internal)/[a-f0-9-]{36}(-[a-f0-9-]{36})?$' AND coalesce(r.data->>'sha256','') ~ '^[a-f0-9]{64}$');
 SELECT jsonb_build_object('units',(SELECT count(*) FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='units'),'unitCost',(SELECT coalesce(sum((data->>'cost')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='units'),'salesAmount',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='sales_orders'),'refundAmount',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='sales_refunds'),'agentEarnings',(SELECT coalesce(sum((data->>'amount')::numeric),0)::text FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='agent_earnings'),'files',(SELECT count(*) FROM maintenance_backup_rows WHERE job_id=v_job AND table_name='files')) INTO v_totals;
 UPDATE maintenance_backup_jobs SET manifest=jsonb_build_object('format','xiamu-backup-v1','jobId',v_job,'day',p_day,'snapshotAt',snapshot_at,'tables',v_tables,'totals',v_totals,'externalFiles',v_external,'excludedEphemeralTables',jsonb_build_array('sessions','sms_challenges','sms_send_budget','agent_request_limits','file_uploads')) WHERE id=v_job;
 INSERT INTO maintenance_events(kind,object_id,detail) VALUES('backup_snapshot',v_job::text,jsonb_build_object('tables',jsonb_array_length(v_tables),'totals',v_totals));RETURN v_job;
END $$;
REVOKE ALL ON FUNCTION maintenance_backup_snapshot(date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION maintenance_backup_snapshot(date) TO service_role;
