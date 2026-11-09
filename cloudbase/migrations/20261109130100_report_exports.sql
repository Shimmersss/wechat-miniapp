-- 导出固定快照与原因审计原子写入；内容和授权快照只追加，下载再次核对当前权限。
REVOKE UPDATE,DELETE,TRUNCATE ON report_exports FROM service_role;
CREATE FUNCTION api_report_export(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actor uuid:=(p_user->>'id')::uuid;perms jsonb:=coalesce(p_user->'permissions','[]');row_v report_exports;rows_v jsonb;cost_v boolean:=stock_can(p_user,'cost');profit_v boolean:=stock_can(p_user,'profit') AND perms ? 'profit:view';target uuid;started timestamptz:=(p_data->>'start')::timestamptz;ended timestamptz:=(p_data->>'end')::timestamptz;
BEGIN
 IF actor IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;
 IF p_user->>'staffNo' IS NULL OR NOT perms ? 'data:export' OR NOT perms ?| ARRAY['stats:view','dashboard:view'] THEN PERFORM stock_error('P0403','无报表导出权限'); END IF;
 IF p_action='create' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('export:'||actor::text||':'||(p_data->>'requestKey'),0));
  SELECT * INTO row_v FROM report_exports WHERE actor_id=actor AND request_key=p_data->>'requestKey';
  IF FOUND THEN
   IF row_v.request_hash<>p_data->>'signature' THEN PERFORM stock_error('P0409','导出标识已用于其他内容'); END IF;
   IF row_v.expires_at<=now() THEN PERFORM stock_error('P0410','下载已过期，请重新导出'); END IF;
  ELSE
   SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('time',to_char(e.event_time AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS'),'kind',e.kind,'no',e.no,'name',e.model_name,'spec',e.spec,'store',e.store,'qty',e.sold,'returned',e.returned,'amount',e.amount,'refund',e.refund,'cost',CASE WHEN cost_v THEN e.cost END,'profit',CASE WHEN profit_v THEN round(e.amount-e.cost,2) END)) ORDER BY e.event_time,e.no),'[]') INTO rows_v FROM(SELECT * FROM report_sales_events(started,ended) ORDER BY event_time,no LIMIT 10001)e;
   IF jsonb_array_length(rows_v)>10000 THEN PERFORM stock_error('P0400','明细超过10000行，请缩小日期范围后导出'); END IF;
   target:=gen_random_uuid();INSERT INTO report_exports(id,actor_id,request_key,request_hash,payload,expires_at) VALUES(target,actor,p_data->>'requestKey',p_data->>'signature',jsonb_build_object('from',started,'to',ended,'rows',rows_v,'costAccess',cost_v,'profitAccess',profit_v),now()+interval '15 minutes') RETURNING * INTO row_v;
   PERFORM stock_audit(p_user,p_request_id,'导出销售退款报表',target::text,NULL,jsonb_build_object('from',started,'to',ended,'rows',jsonb_array_length(rows_v),'costAccess',cost_v,'profitAccess',profit_v),p_data->>'reason');
  END IF;
 ELSIF p_action='get' THEN
  SELECT * INTO row_v FROM report_exports WHERE id=p_id AND actor_id=actor;
  IF NOT FOUND THEN PERFORM stock_error('P0404','导出记录不存在'); END IF;
  IF row_v.expires_at<=now() THEN PERFORM stock_error('P0410','下载已过期，请重新导出'); END IF;
 ELSE PERFORM stock_error('P0404','接口尚未迁移'); END IF;
 RETURN jsonb_build_object('id',row_v.id,'expiresAt',row_v.expires_at,'rows',jsonb_array_length(row_v.payload->'rows'))||CASE WHEN p_action='get' THEN jsonb_build_object('payload',row_v.payload) ELSE '{}' END;
END $$;
REVOKE ALL ON FUNCTION api_report_export(text,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION api_report_export(text,uuid,jsonb,jsonb,text) TO service_role;
