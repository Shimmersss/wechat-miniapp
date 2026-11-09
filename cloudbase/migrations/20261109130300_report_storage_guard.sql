-- 即使环境另有宽松存储策略，报表对象仍仅允许服务端签名访问。
CREATE POLICY xiamu_reports_server_only ON storage.objects AS RESTRICTIVE TO anon,authenticated USING(bucket_id<>'xiamu-reports') WITH CHECK(bucket_id<>'xiamu-reports');
