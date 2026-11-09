-- 保留分享首页的品牌显示名，收益汇总沿用旧端按种类/状态分组的金额范围校验。
CREATE OR REPLACE FUNCTION agent_public_unit(uid uuid,channel_v text,price_v numeric) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('id',un.id,'model_id',un.model_id,'name',m.name,'brand',m.brand,'brand_label',m.brand_label,'category_id',m.category_id,'condition_type',un.condition_type,
 'attributes',coalesce((SELECT jsonb_object_agg(f->>'key',un.attributes->(f->>'key')) FROM jsonb_array_elements(un.template_snapshot->'fields') f WHERE shop_field_public(un.template_snapshot,f->>'key',CASE WHEN channel_v='peer' THEN 'peer' ELSE 'customer' END) AND f->>'key'<>ALL(ARRAY['cost','supplier','internalNote','fullImei','wholesalePrice','profit','agentBase','imei1','imei2','receipt','retail','wholesale'])),'{}'),
 'template_snapshot',un.template_snapshot,'imei_masked',left(un.imei1,2)||'****'||right(un.imei1,4),'desc',CASE WHEN channel_v='peer' THEN un.peer_desc ELSE un.customer_desc END,'price',price_v,
 'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position) FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=un.id AND f.scope='public' AND (uf.field_key='publicImages' OR shop_field_public(un.template_snapshot,uf.field_key,CASE WHEN channel_v='peer' THEN 'peer' ELSE 'customer' END))),'[]')) FROM units un JOIN models m ON m.id=un.model_id WHERE un.id=uid
$$;
CREATE OR REPLACE FUNCTION agent_earning_totals(who uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 WITH grouped AS(SELECT e.kind,s.status,stock_money(to_jsonb(sum(e.amount))) amount FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id WHERE (who IS NULL OR e.agent_id=who) AND s.status IN ('pending','settled') GROUP BY e.kind,s.status)
 SELECT jsonb_build_object('pendingAmount',coalesce(sum(CASE WHEN status='pending' THEN amount*CASE WHEN kind='reversal' THEN -1 ELSE 1 END ELSE 0 END),0),'settledAmount',coalesce(sum(CASE WHEN status='settled' THEN amount*CASE WHEN kind='reversal' THEN -1 ELSE 1 END ELSE 0 END),0)) FROM grouped
$$;
REVOKE ALL ON FUNCTION agent_public_unit(uuid,text,numeric),agent_earning_totals(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION agent_public_unit(uuid,text,numeric),agent_earning_totals(uuid) TO service_role;
