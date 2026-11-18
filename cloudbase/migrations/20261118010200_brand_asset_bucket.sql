-- 只公开首页品牌插画，业务上传桶的权限保持私有。
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('xiamu-brand-assets','首页品牌配图',true,1048576,ARRAY['image/png']);
CREATE POLICY xiamu_brand_assets_no_client_insert ON storage.objects AS RESTRICTIVE
  FOR INSERT TO anon, authenticated WITH CHECK (bucket_id<>'xiamu-brand-assets');
CREATE POLICY xiamu_brand_assets_no_client_update ON storage.objects AS RESTRICTIVE
  FOR UPDATE TO anon, authenticated USING (bucket_id<>'xiamu-brand-assets') WITH CHECK (bucket_id<>'xiamu-brand-assets');
CREATE POLICY xiamu_brand_assets_no_client_delete ON storage.objects AS RESTRICTIVE
  FOR DELETE TO anon, authenticated USING (bucket_id<>'xiamu-brand-assets');
