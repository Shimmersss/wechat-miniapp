-- 云内分段恢复校验：避免大文件经本机网关下载，仍逐字节验证完整SHA256，不以复制成功代替校验。
CREATE TABLE maintenance_restore_media(run_id uuid NOT NULL REFERENCES maintenance_restore_runs(id),object_key text NOT NULL,target_key text NOT NULL,byte_size integer NOT NULL,expected_sha text NOT NULL,offset_bytes integer NOT NULL DEFAULT 0,hash_state text,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','verified')),lease uuid,lease_until timestamptz,actual_sha text,PRIMARY KEY(run_id,object_key));
ALTER TABLE maintenance_restore_media ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON maintenance_restore_media FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON maintenance_restore_media TO service_role;
CREATE FUNCTION api_maintenance_restore_media(p_action text,p_run uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v_run maintenance_restore_runs;v_row maintenance_restore_media;v_nonce uuid;v_count int;v_bytes bigint;v_total int;
BEGIN
 PERFORM maintenance_guard();
 SELECT * INTO v_run FROM maintenance_restore_runs WHERE id=p_run FOR UPDATE;
 IF NOT FOUND OR v_run.status<>'verified' THEN PERFORM stock_error('P0409','先完成数据库恢复核对');END IF;
 IF p_action='take' THEN
  INSERT INTO maintenance_restore_media(run_id,object_key,target_key,byte_size,expected_sha)
  SELECT p_run,value->>'key','restore/'||p_run||'/media/'||reverse(split_part(reverse(value->>'key'),'/',1)),(value->>'bytes')::int,value->>'expectedSha' FROM jsonb_array_elements(v_run.manifest->'parts') WHERE value->>'kind'='media' ON CONFLICT DO NOTHING;
  SELECT * INTO v_row FROM maintenance_restore_media WHERE run_id=p_run AND status='pending' AND (lease_until IS NULL OR lease_until<=now()) ORDER BY byte_size,object_key LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
   SELECT count(*) FILTER(WHERE status='verified'),coalesce(sum(byte_size) FILTER(WHERE status='verified'),0),count(*) INTO v_count,v_bytes,v_total FROM maintenance_restore_media WHERE run_id=p_run;
   IF v_count=v_total THEN
    IF NOT coalesce((v_run.result->>'mediaVerified')::boolean,false) THEN
     UPDATE maintenance_restore_runs SET result=result||jsonb_build_object('mediaVerified',true,'mediaFiles',v_count,'mediaBytes',v_bytes) WHERE id=p_run;
     INSERT INTO maintenance_events(kind,object_id,detail) VALUES('restore_media_verified',p_run::text,jsonb_build_object('files',v_count,'bytes',v_bytes,'method','cloud-full-sha256'));
    END IF;
    RETURN jsonb_build_object('complete',true,'files',v_count,'bytes',v_bytes);
   END IF;RETURN jsonb_build_object('busy',true);
  END IF;
  v_nonce:=gen_random_uuid();UPDATE maintenance_restore_media SET lease=v_nonce,lease_until=now()+interval '30 seconds' WHERE run_id=p_run AND object_key=v_row.object_key;
  RETURN jsonb_build_object('complete',false,'key',v_row.object_key,'target',v_row.target_key,'size',v_row.byte_size,'sha256',v_row.expected_sha,'offset',v_row.offset_bytes,'hashState',v_row.hash_state,'lease',v_nonce);
 ELSIF p_action IN('progress','fail') THEN
  SELECT * INTO v_row FROM maintenance_restore_media WHERE run_id=p_run AND object_key=p_data->>'key' FOR UPDATE;
  IF NOT FOUND OR v_row.lease IS DISTINCT FROM (p_data->>'lease')::uuid OR v_row.lease_until<=now() THEN PERFORM stock_error('P0409','恢复媒体校验租约已变更');END IF;
  IF p_action='fail' THEN UPDATE maintenance_restore_media SET lease=NULL,lease_until=NULL WHERE run_id=p_run AND object_key=v_row.object_key;RETURN '{}'::jsonb;END IF;
  IF (p_data->>'from')::int IS DISTINCT FROM v_row.offset_bytes OR (p_data->>'offset')::int IS DISTINCT FROM least(v_row.byte_size,v_row.offset_bytes+524288) OR length(p_data->>'hashState') NOT BETWEEN 1 AND 4096 THEN PERFORM stock_error('P0400','恢复媒体校验游标无效');END IF;
  IF (p_data->>'offset')::int=v_row.byte_size AND p_data->>'sha256' IS DISTINCT FROM v_row.expected_sha THEN PERFORM stock_error('P0400','恢复媒体完整摘要不一致');END IF;
  UPDATE maintenance_restore_media SET offset_bytes=(p_data->>'offset')::int,hash_state=p_data->>'hashState',actual_sha=p_data->>'sha256',status=CASE WHEN (p_data->>'offset')::int=byte_size THEN 'verified' ELSE status END,lease=NULL,lease_until=NULL WHERE run_id=p_run AND object_key=v_row.object_key;
  RETURN '{}'::jsonb;
 END IF;PERFORM stock_error('P0404','媒体恢复操作不存在');
END $$;
REVOKE ALL ON FUNCTION api_maintenance_restore_media(text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_maintenance_restore_media(text,uuid,jsonb) TO service_role;
