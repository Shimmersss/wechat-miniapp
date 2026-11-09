-- 分段核验：冻结对象不可由客户端改写，SHA256状态只在服务端保存，全部核验完才登记。
ALTER TABLE file_uploads ADD COLUMN sealed_key text, ADD COLUMN verified_bytes integer NOT NULL DEFAULT 0,
 ADD COLUMN hash_state text, ADD COLUMN detected_mime text, ADD COLUMN verified_sha char(64);
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('xiamu-sealed','上传内容校验区',false,33554432,NULL);
CREATE POLICY xiamu_sealed_server_only ON storage.objects AS RESTRICTIVE TO anon,authenticated
 USING(bucket_id<>'xiamu-sealed') WITH CHECK(bucket_id<>'xiamu-sealed');
CREATE OR REPLACE FUNCTION api_file_upload(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE upload file_uploads; file_row files; key_v text; scope_v text; size_v int; perms jsonb:=coalesce(p_user->'permissions','[]'); actual_mime text; actual_sha text;
BEGIN
 IF p_user->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','仅员工可上传文件'); END IF;
 IF NOT perms ?| ARRAY['inbound:do','acceptance:do','purchase:manage','repair:handle','repair:cash','loan:manage','sales:create','sales:refund'] THEN PERFORM stock_error('P0403','无权限上传文件'); END IF;
 IF p_action='intent' THEN
  scope_v:=p_data->>'scope'; size_v:=(p_data->>'size')::int; key_v:=stock_text(p_data->'requestKey','提交标识',80);
  IF scope_v NOT IN ('public','internal') OR scope_v IS NULL OR size_v IS NULL OR size_v NOT BETWEEN 1 AND 33554432 THEN PERFORM stock_error('P0400','请指定有效范围及1～32MB文件'); END IF;
  IF scope_v='public' AND NOT perms ?| ARRAY['inbound:do','acceptance:do','purchase:manage'] THEN PERFORM stock_error('P0403','无权限上传公开设备媒体'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upload:'||(p_user->>'id'),0));
  SELECT * INTO upload FROM file_uploads WHERE owner_id=(p_user->>'id')::uuid AND request_key=key_v;
  IF FOUND THEN
   IF upload.scope<>scope_v OR upload.expected_size<>size_v THEN PERFORM stock_error('P0409','提交标识已用于其他上传'); END IF;
  ELSE
   IF (SELECT count(*) FROM file_uploads WHERE owner_id=(p_user->>'id')::uuid AND created_at>now()-interval '1 minute')>=30 THEN PERFORM stock_error('P0429','上传频繁，请稍后再试'); END IF;
   INSERT INTO file_uploads(owner_id,scope,expected_size,request_key) VALUES((p_user->>'id')::uuid,scope_v,size_v,key_v) RETURNING * INTO upload;
  END IF;
 ELSE
  SELECT * INTO upload FROM file_uploads WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM stock_error('P0404','上传记录不存在'); END IF;
  IF upload.owner_id<>(p_user->>'id')::uuid THEN PERFORM stock_error('P0403','无权操作他人的上传'); END IF;
  IF upload.scope='public' AND NOT perms ?| ARRAY['inbound:do','acceptance:do','purchase:manage'] THEN PERFORM stock_error('P0403','无权限上传公开设备媒体'); END IF;
  IF upload.status='ready' THEN SELECT * INTO file_row FROM files WHERE id=upload.id; RETURN jsonb_build_object('upload',to_jsonb(upload),'file',to_jsonb(file_row)); END IF;
  IF upload.status='failed' OR upload.expires_at<=now() THEN PERFORM stock_error('P0409','上传已失效，请重新上传'); END IF;
  CASE p_action
  WHEN 'begin' THEN
   IF upload.status='verifying' AND upload.lease_until>now() THEN PERFORM stock_error('P0409','文件正在核验，请稍后重试'); END IF;
   UPDATE file_uploads SET status='verifying',lease=gen_random_uuid(),lease_until=now()+interval '30 seconds' WHERE id=p_id RETURNING * INTO upload;
  WHEN 'commit' THEN
   IF upload.status<>'verifying' OR upload.lease IS DISTINCT FROM (p_data->>'lease')::uuid OR upload.lease_until<=now() THEN PERFORM stock_error('P0409','核验状态已变更，请重试'); END IF;
   actual_mime:=p_data->>'mime'; actual_sha:=p_data->>'sha256'; size_v:=(p_data->>'size')::int;
   IF actual_mime NOT IN ('image/jpeg','image/png','image/webp','video/mp4') OR actual_mime IS NULL OR (upload.scope='internal' AND actual_mime='video/mp4') OR size_v IS DISTINCT FROM upload.expected_size OR actual_sha IS NULL OR actual_sha !~ '^[a-f0-9]{64}$' OR upload.verified_bytes<>upload.expected_size OR actual_sha IS DISTINCT FROM upload.verified_sha OR actual_mime IS DISTINCT FROM upload.detected_mime OR upload.sealed_key IS NULL THEN PERFORM stock_error('P0400','文件核验信息无效'); END IF;
   INSERT INTO files(id,scope,stored_name,mime,byte_size,sha256,owner_id) VALUES(upload.id,upload.scope,'xiamu-'||upload.scope||'/'||upload.sealed_key,actual_mime,size_v,actual_sha,upload.owner_id) RETURNING * INTO file_row;
   PERFORM stock_audit(p_user,p_request_id,'上传文件',upload.id::text,NULL,jsonb_build_object('scope',upload.scope,'mime',actual_mime,'size',size_v));
   UPDATE file_uploads SET status='ready',lease=NULL,lease_until=NULL WHERE id=p_id RETURNING * INTO upload;
  WHEN 'fail' THEN
   UPDATE file_uploads SET status=CASE WHEN p_data->>'permanent'='true' THEN 'failed' ELSE 'pending' END,lease=NULL,lease_until=NULL,last_error=left(coalesce(p_data->>'message','核验失败'),500) WHERE id=p_id AND lease=(p_data->>'lease')::uuid RETURNING * INTO upload;
  ELSE PERFORM stock_error('P0400','上传操作无效'); END CASE;
 END IF;
 IF upload.status='ready' THEN SELECT * INTO file_row FROM files WHERE id=upload.id; END IF;
 RETURN jsonb_build_object('upload',to_jsonb(upload),'file',to_jsonb(file_row));
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','文件已登记，请刷新后重试');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN PERFORM stock_error('P0400','上传参数无效');
END $$;
CREATE FUNCTION api_file_progress(p_id uuid,p_lease uuid,p_data jsonb,p_user jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE v file_uploads; next_offset integer; key_v text;
BEGIN
 SELECT * INTO v FROM file_uploads WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR v.owner_id<>(p_user->>'id')::uuid OR p_user->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','无权核验该上传'); END IF;
 IF v.status<>'verifying' OR v.lease IS DISTINCT FROM p_lease OR v.lease_until<=now() THEN PERFORM stock_error('P0409','核验状态已变更，请重试'); END IF;
 IF p_data->>'stage'='seal' THEN
  key_v:=p_data->>'sealedKey';
  IF v.sealed_key IS NOT NULL OR key_v IS DISTINCT FROM (p_id::text||'-'||p_lease::text) THEN PERFORM stock_error('P0409','校验快照已建立'); END IF;
  UPDATE file_uploads SET sealed_key=key_v WHERE id=p_id RETURNING * INTO v;
 ELSE
  next_offset:=(p_data->>'offset')::int;
  IF (p_data->>'from')::int IS DISTINCT FROM v.verified_bytes OR next_offset<=v.verified_bytes OR next_offset>v.expected_size OR next_offset-v.verified_bytes>524288 OR v.sealed_key IS NULL OR length(coalesce(p_data->>'hashState','')) NOT BETWEEN 1 AND 2048 OR p_data->>'mime' NOT IN ('image/jpeg','image/png','image/webp','video/mp4') OR (v.scope='internal' AND p_data->>'mime'='video/mp4') THEN PERFORM stock_error('P0400','分段核验状态无效'); END IF;
  IF next_offset=v.expected_size AND coalesce(p_data->>'sha256','') !~ '^[a-f0-9]{64}$' THEN PERFORM stock_error('P0400','完整摘要无效'); END IF;
  UPDATE file_uploads SET verified_bytes=next_offset,hash_state=p_data->>'hashState',detected_mime=p_data->>'mime',verified_sha=p_data->>'sha256',status=CASE WHEN next_offset=v.expected_size THEN 'verifying' ELSE 'pending' END,lease=CASE WHEN next_offset=v.expected_size THEN lease END,lease_until=CASE WHEN next_offset=v.expected_size THEN lease_until END WHERE id=p_id RETURNING * INTO v;
 END IF;
 RETURN to_jsonb(v);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN PERFORM stock_error('P0400','分段核验参数无效');
END $$;
REVOKE ALL ON FUNCTION api_file_progress(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_file_progress(uuid,uuid,jsonb,jsonb) TO service_role;
