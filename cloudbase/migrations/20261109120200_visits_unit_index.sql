-- 访问上报按设备主键查询，避免逐事件转换整列导致顺序扫描；业务规则不变。
CREATE OR REPLACE FUNCTION api_visits(p_data jsonb,p_user jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE ctx jsonb; entry jsonb; n int:=0; added int;
BEGIN
 IF p_data->>'shareId' IS NOT NULL THEN
  BEGIN
   IF (p_data->>'shareId') !~ '^[A-Za-z0-9_-]{16}$' THEN PERFORM stock_error('P0404','分享不存在'); END IF;
   ctx:=agent_share_resolve(p_data->>'shareId',p_user);
  EXCEPTION WHEN SQLSTATE 'P0403' OR SQLSTATE 'P0404' OR SQLSTATE 'P0410' OR SQLSTATE 'P0503' THEN ctx:=NULL;
  END;
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_data->'events') LOOP
  IF entry->>'unitId' IS NOT NULL THEN
   -- 先单独校验规范UUID文本：保持旧文本匹配对非规范写法的忽略行为，避免非法值强转报错。
   IF (entry->>'unitId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN CONTINUE; END IF;
   -- 只转换参数，保留主键列为uuid，允许使用units_pkey。
   IF NOT EXISTS(SELECT 1 FROM units WHERE id=(entry->>'unitId')::uuid) THEN CONTINUE; END IF;
  END IF;
  INSERT INTO visit_events(visitor_hash,event_id,type,name,route,unit_id,source,share_hash,share_id,share_owner_id) VALUES(p_data->>'visitorHash',entry->>'eventId',entry->>'type',entry->>'name',entry->>'route',entry->>'unitId',coalesce(ctx->'link'->>'channel',CASE WHEN p_data->>'shareId' IS NULL THEN 'natural' ELSE 'unverified' END),p_data->>'shareHash',ctx->'link'->>'id',(ctx->'link'->>'owner_id')::uuid) ON CONFLICT(visitor_hash,event_id) DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT;n:=n+added;
 END LOOP;
 RETURN jsonb_build_object('accepted',n,'ignored',(p_data->>'total')::int-n);
END $$;
REVOKE ALL ON FUNCTION api_visits(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_visits(jsonb,jsonb) TO service_role;
