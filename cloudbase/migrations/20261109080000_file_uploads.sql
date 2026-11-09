-- 云存储上传：受限暂存地址 → 服务端验证真实内容 → 私有正式对象 → PG登记与审计。
CREATE TABLE file_uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id uuid NOT NULL REFERENCES users(id),
 scope text NOT NULL CHECK(scope IN ('public','internal')),
 expected_size integer NOT NULL CHECK(expected_size BETWEEN 1 AND 33554432),
 request_key varchar(80) NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verifying','ready','failed')),
 lease uuid, lease_until timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 last_error varchar(500) NOT NULL DEFAULT '',
 UNIQUE(owner_id,request_key)
);
CREATE INDEX file_uploads_owner_time ON file_uploads(owner_id,created_at);
ALTER TABLE file_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON file_uploads FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON file_uploads TO service_role;
-- 三个桶全部私有；anon/authenticated不建业务桶策略，只由函数服务密钥签名访问。
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES
 ('xiamu-staging','小程序上传暂存',false,33554432,NULL),
 ('xiamu-public','设备公开媒体',false,33554432,ARRAY['image/jpeg','image/png','image/webp','video/mp4']),
 ('xiamu-internal','内部业务凭证',false,33554432,ARRAY['image/jpeg','image/png','image/webp']);

CREATE FUNCTION file_can_read(fid uuid,u jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE f files; loan_linked boolean; sales_linked boolean; perms jsonb:=coalesce(u->'permissions','[]');
BEGIN
 SELECT * INTO f FROM files WHERE id=fid;
 IF NOT FOUND THEN RETURN false; END IF;
 IF f.scope='public' THEN RETURN true; END IF;
 IF u->>'staffNo' IS NULL THEN RETURN false; END IF;
 loan_linked:=EXISTS(SELECT 1 FROM loan_files WHERE file_id=fid);
 IF loan_linked AND NOT perms ? 'loan:manage' THEN RETURN false; END IF;
 sales_linked:=EXISTS(SELECT 1 FROM sales_files WHERE file_id=fid);
 IF sales_linked AND NOT (perms ?| ARRAY['sales:create','sales:refund','stats:view']) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid AND purpose='expense') THEN RETURN perms ? 'repair:cash' AND stock_can(u,'cost'); END IF;
 IF EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid) THEN
  RETURN EXISTS(SELECT 1 FROM repair_files rf JOIN repair_orders ro ON ro.id=rf.order_id WHERE rf.file_id=fid AND
   ((rf.purpose='payment' AND perms ? 'repair:cash') OR (rf.purpose<>'payment' AND
    ((perms ? 'repair:handle' AND (perms ? 'repair:assign' OR ro.engineer_id=(u->>'id')::uuid)) OR (perms ? 'repair:cash' AND rf.purpose='pickup')))));
 END IF;
 IF loan_linked OR sales_linked THEN RETURN true; END IF;
 RETURN f.owner_id=(u->>'id')::uuid OR u->>'role' IN ('boss','manager','purchaser');
END $$;
CREATE FUNCTION api_file_read(p_id uuid,p_user jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE f files;
BEGIN
 SELECT * INTO f FROM files WHERE id=p_id; IF NOT FOUND THEN PERFORM stock_error('P0404','文件不存在'); END IF;
 IF NOT file_can_read(f.id,p_user) THEN
  IF p_user->>'id' IS NULL THEN PERFORM stock_error('P0401','请先登录'); ELSE PERFORM stock_error('P0403','无权限查看凭证'); END IF;
 END IF;
 RETURN to_jsonb(f);
END $$;
CREATE FUNCTION api_files_authorized(p_ids jsonb,p_user jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]') FROM files f WHERE f.id IN(SELECT value::uuid FROM jsonb_array_elements_text(p_ids)) AND file_can_read(f.id,p_user)
$$;
CREATE FUNCTION api_file_upload(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
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
   IF actual_mime NOT IN ('image/jpeg','image/png','image/webp','video/mp4') OR actual_mime IS NULL OR (upload.scope='internal' AND actual_mime='video/mp4') OR size_v IS DISTINCT FROM upload.expected_size OR actual_sha IS NULL OR actual_sha !~ '^[a-f0-9]{64}$' THEN PERFORM stock_error('P0400','文件核验信息无效'); END IF;
   INSERT INTO files(id,scope,stored_name,mime,byte_size,sha256,owner_id) VALUES(upload.id,upload.scope,'xiamu-'||upload.scope||'/'||upload.id::text,actual_mime,size_v,actual_sha,upload.owner_id) RETURNING * INTO file_row;
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
REVOKE ALL ON FUNCTION file_can_read(uuid,jsonb),api_file_read(uuid,jsonb),api_files_authorized(jsonb,jsonb),api_file_upload(text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION file_can_read(uuid,jsonb),api_file_read(uuid,jsonb),api_files_authorized(jsonb,jsonb),api_file_upload(text,uuid,jsonb,jsonb,text) TO service_role;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY xiamu_server_only ON storage.objects AS RESTRICTIVE TO anon,authenticated
 USING (bucket_id NOT IN ('xiamu-staging','xiamu-public','xiamu-internal'))
 WITH CHECK (bucket_id NOT IN ('xiamu-staging','xiamu-public','xiamu-internal'));
