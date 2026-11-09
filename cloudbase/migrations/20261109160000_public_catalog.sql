-- 对应 server/src/catalog.js 的公开分类目录；只返回公开型号名称，不带库存或内部字段。
CREATE FUNCTION api_shop_catalog() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('categories',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label) ORDER BY created_at,id),'[]') FROM categories),
 'models',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'category_id',category_id,'brand',brand,'brand_label',brand_label,'series',series,'name',name) ORDER BY brand_label,series,name),'[]') FROM models))
$$;
REVOKE ALL ON FUNCTION api_shop_catalog() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_shop_catalog() TO service_role;
