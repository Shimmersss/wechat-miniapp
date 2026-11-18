-- 记录上传用途及公开视频封面，保留已有文件和旧版调用契约。
ALTER TABLE files
  ADD COLUMN upload_purpose varchar(60),
  ADD COLUMN poster_id uuid REFERENCES files(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT files_poster_on_public_video CHECK (poster_id IS NULL OR (scope='public' AND mime='video/mp4' AND poster_id<>id));
ALTER TABLE file_uploads
  ADD COLUMN upload_purpose varchar(60),
  ADD COLUMN media_kind text CHECK (media_kind IN ('image','video')),
  ADD COLUMN poster_id uuid REFERENCES files(id);

CREATE OR REPLACE FUNCTION api_file_upload(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE upload file_uploads; file_row files; key_v text; scope_v text; size_v int; perms jsonb:=coalesce(p_user->'permissions','[]'); actual_mime text; actual_sha text; purpose_v text; media_v text; poster_v uuid;
BEGIN
 IF p_user->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','仅员工可上传文件'); END IF;
 IF NOT perms ?| ARRAY['inbound:do','acceptance:do','purchase:manage','repair:handle','repair:cash','loan:manage','sales:create','sales:refund'] THEN PERFORM stock_error('P0403','无权限上传文件'); END IF;
 IF p_action='intent' THEN
  scope_v:=p_data->>'scope'; size_v:=(p_data->>'size')::int; key_v:=stock_text(p_data->'requestKey','提交标识',80);
  IF scope_v NOT IN ('public','internal') OR scope_v IS NULL OR size_v IS NULL OR size_v NOT BETWEEN 1 AND 33554432 THEN PERFORM stock_error('P0400','请指定有效范围及1～32MB文件'); END IF;
  IF scope_v='public' AND NOT perms ?| ARRAY['inbound:do','acceptance:do','purchase:manage'] THEN PERFORM stock_error('P0403','无权限上传公开设备媒体'); END IF;
  purpose_v:=coalesce(p_data->>'bizType','');
  media_v:=nullif(p_data->>'mediaType','');
  poster_v:=nullif(p_data->>'posterId','')::uuid;
  IF length(purpose_v)>60 OR (media_v IS NOT NULL AND media_v NOT IN ('image','video')) THEN
   PERFORM stock_error('P0400','上传用途无效');
  END IF;
  IF media_v='video' AND (scope_v<>'public' OR purpose_v<>'unit') THEN
   PERFORM stock_error('P0400','仅公开设备媒体支持视频');
  END IF;
  IF (media_v='image' OR scope_v='internal' OR purpose_v='unit_poster') AND size_v>5242880
     OR media_v='video' AND size_v>26214400 THEN
   PERFORM stock_error('P0413','文件大小超出上传限制');
  END IF;
  IF purpose_v='unit_poster' AND (scope_v<>'public' OR media_v IS DISTINCT FROM 'image') THEN
   PERFORM stock_error('P0400','视频封面须为公开图片');
  END IF;
  IF poster_v IS NOT NULL AND (media_v IS DISTINCT FROM 'video' OR NOT EXISTS (
    SELECT 1 FROM files f WHERE f.id=poster_v AND f.owner_id=(p_user->>'id')::uuid
      AND f.scope='public' AND f.mime LIKE 'image/%' AND f.upload_purpose='unit_poster'
  )) THEN PERFORM stock_error('P0400','视频封面无效'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('upload:'||(p_user->>'id'),0));
  SELECT * INTO upload FROM file_uploads WHERE owner_id=(p_user->>'id')::uuid AND request_key=key_v;
  IF FOUND THEN
   IF upload.scope<>scope_v OR upload.expected_size<>size_v
      OR coalesce(upload.upload_purpose,'')<>purpose_v OR upload.media_kind IS DISTINCT FROM media_v
      OR upload.poster_id IS DISTINCT FROM poster_v THEN PERFORM stock_error('P0409','提交标识已用于其他上传'); END IF;
  ELSE
   IF (SELECT count(*) FROM file_uploads WHERE owner_id=(p_user->>'id')::uuid AND created_at>now()-interval '1 minute')>=30 THEN PERFORM stock_error('P0429','上传频繁，请稍后再试'); END IF;
   INSERT INTO file_uploads(owner_id,scope,expected_size,request_key,upload_purpose,media_kind,poster_id) VALUES((p_user->>'id')::uuid,scope_v,size_v,key_v,purpose_v,media_v,poster_v) RETURNING * INTO upload;
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
   IF (actual_mime LIKE 'image/%' AND size_v>5242880)
      OR (actual_mime='video/mp4' AND size_v>26214400) THEN
    PERFORM stock_error('P0413','文件大小超出上传限制');
   END IF;
   IF (upload.media_kind='video' AND actual_mime<>'video/mp4')
      OR (upload.media_kind='image' AND actual_mime NOT LIKE 'image/%') THEN
    PERFORM stock_error('P0400','文件内容与选择的类型不一致');
   END IF;
   INSERT INTO files(id,scope,stored_name,mime,byte_size,sha256,owner_id,upload_purpose,poster_id)
     VALUES(upload.id,upload.scope,'xiamu-'||upload.scope||'/'||upload.sealed_key,actual_mime,size_v,actual_sha,upload.owner_id,upload.upload_purpose,upload.poster_id) RETURNING * INTO file_row;
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
