-- 公开商品返回实际云存储媒体元信息，内部凭证不进入公开查询。
CREATE OR REPLACE FUNCTION api_shop_units(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_flag text := p ->> 'flag';
  v_aud text := p ->> 'audience';
  v_peer boolean := (p ->> 'audience') = 'peer';
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_flag NOT IN ('showInShop', 'sharePeer') OR v_aud NOT IN ('customer', 'peer') THEN
    RAISE EXCEPTION '渠道参数无效' USING ERRCODE = 'P0400';
  END IF;

  WITH base AS (
    SELECT u.*, m.name, m.brand, m.category_id,
           CASE WHEN v_peer THEN u.wholesale ELSE u.retail END AS price
    FROM units u JOIN models m ON m.id = u.model_id
    WHERE u.status = 'in_stock'
      AND (u.share_flags ->> v_flag)::boolean IS TRUE
      AND (p ->> 'brand' IS NULL OR p ->> 'brand' = 'all' OR m.brand = p ->> 'brand')
      AND (p ->> 'category' IS NULL OR m.category_id = p ->> 'category')
      AND (p ->> 'modelId' IS NULL OR u.model_id = p ->> 'modelId')
      AND (p ->> 'condition' IS NULL OR u.condition_type = p ->> 'condition')
      -- MySQL 原实现默认不区分大小写，这里用 ILIKE 保持一致
      AND (p ->> 'keyword' IS NULL
           OR m.name ILIKE '%' || (p ->> 'keyword') || '%'
           OR u.attributes ->> 'storage' ILIKE '%' || (p ->> 'keyword') || '%'
           OR u.attributes ->> 'color' ILIKE '%' || (p ->> 'keyword') || '%')
  ), filtered AS (
    SELECT * FROM base b
    WHERE (p ->> 'priceMin' IS NULL OR b.price >= (p ->> 'priceMin')::numeric)
      AND (p ->> 'priceMax' IS NULL OR b.price <= (p ->> 'priceMax')::numeric)
      AND (p ->> 'grade' IS NULL OR (shop_field_public(b.template_snapshot, 'grade', v_aud)
           AND b.attributes ->> 'grade' = p ->> 'grade'))
      AND (p ->> 'batteryMin' IS NULL OR (shop_field_public(b.template_snapshot, 'battery', v_aud)
           AND replace(b.attributes ->> 'battery', '%', '') ~ '^[0-9]+([.][0-9]+)?$'
           AND replace(b.attributes ->> 'battery', '%', '')::numeric >= (p ->> 'batteryMin')::numeric))
  ), ordered AS (
    SELECT f.*, row_number() OVER (ORDER BY
      CASE WHEN p ->> 'sort' = 'price_asc' THEN f.price END ASC,
      CASE WHEN p ->> 'sort' = 'price_desc' THEN f.price END DESC,
      f.created_at DESC, f.id) AS ord
    FROM filtered f
  ), x AS (
    SELECT * FROM ordered ORDER BY ord
    LIMIT (p ->> 'limit')::int OFFSET (p ->> 'offset')::int
  )
  SELECT (SELECT count(*) FROM filtered),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', x.id, 'model_id', x.model_id, 'name', x.name, 'brand', x.brand,
           'category_id', x.category_id, 'condition_type', x.condition_type,
           'attributes', x.attributes, 'template_snapshot', x.template_snapshot,
           'price', x.price,
           'attached', COALESCE((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position)
             FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=x.id AND f.scope='public'
             AND (uf.field_key='publicImages' OR shop_field_public(x.template_snapshot,uf.field_key,v_aud))), '[]'::jsonb),
           'desc', CASE WHEN v_peer THEN x.peer_desc ELSE x.customer_desc END,
           'imei_masked', left(x.imei1, 2) || '****' || right(x.imei1, 4))
         ORDER BY x.ord), '[]'::jsonb)
  INTO v_total, v_rows
  FROM x;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$$;

