-- TODO(confirm): 未填预计日期的维修暂按开单超过7天计算超期。
CREATE OR REPLACE FUNCTION api_reports(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE a text:=p_action;d jsonb:=p_data;u jsonb:=p_user;perms jsonb:=coalesce(p_user->'permissions','[]');actor uuid:=(p_user->>'id')::uuid;started timestamptz:=(p_data->>'start')::timestamptz;ended timestamptz:=(p_data->>'end')::timestamptz;result jsonb;inventory jsonb;todos jsonb:='[]';repair_v jsonb;counts jsonb;repair_scope boolean:=perms ?| ARRAY['repair:assign','repair:quote','repair:cash'];
BEGIN
 IF actor IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;IF u->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','仅员工可操作'); END IF;
 IF a LIKE 'audit.%' THEN
  IF NOT perms ? 'audit:view' THEN PERFORM stock_error('P0403','无审计查看权限'); END IF;
  IF a='audit.filters' THEN RETURN jsonb_build_object('actions',coalesce((SELECT jsonb_agg(f.action ORDER BY f.n DESC) FROM(SELECT action,count(*) n FROM audit_logs WHERE created_at>=now()-interval '180 days' GROUP BY action ORDER BY n DESC LIMIT 100)f),'[]'),'actors',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.user_id,'name',s.name) ORDER BY s.name) FROM staff s WHERE s.user_id IS NOT NULL),'[]')); END IF;
  IF a='audit.list' THEN
   WITH matches AS(SELECT al.* FROM audit_logs al WHERE (nullif(d->>'actorId','') IS NULL OR al.actor_id=(d->>'actorId')::uuid) AND (nullif(d->>'action','') IS NULL OR al.action=d->>'action') AND (nullif(d->>'objectId','') IS NULL OR al.object_id=d->>'objectId') AND (nullif(d->>'fromTime','') IS NULL OR al.created_at>=(d->>'fromTime')::timestamptz) AND (nullif(d->>'toTime','') IS NULL OR al.created_at<(d->>'toTime')::timestamptz)),paged AS(SELECT * FROM matches ORDER BY id DESC LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
   SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(to_jsonb(pg)||jsonb_build_object('id',pg.id::text,'actor_name',coalesce(st.name,usr.nickname),'actor_role',st.role_key) ORDER BY pg.id DESC),'[]')) INTO result FROM paged pg LEFT JOIN users usr ON usr.id=pg.actor_id LEFT JOIN staff st ON st.user_id=pg.actor_id;RETURN result;
  END IF;
 END IF;
 IF a='agent-earnings' THEN IF NOT perms ?| ARRAY['agent:review','agent:settle'] THEN PERFORM stock_error('P0403','无代理对账权限'); END IF;RETURN report_agent_earnings(started,ended); END IF;
 IF NOT perms ?| ARRAY['dashboard:view','stats:view'] THEN PERFORM stock_error('P0403','无经营统计权限'); END IF;
 IF a='overview' THEN RETURN report_overview(started,ended); END IF;
 IF a='visits' THEN RETURN report_visits(started,ended); END IF;
 IF a='trend' THEN
  WITH daily AS(SELECT (e.event_time AT TIME ZONE 'Asia/Shanghai')::date AS day,sum(e.amount) amount,sum(e.cost) cost,sum(e.sold) sold,sum(e.returned) returned,sum(e.refund) refund FROM report_sales_events(started,ended)e GROUP BY day),days AS(SELECT g::date AS day FROM generate_series((started AT TIME ZONE 'Asia/Shanghai')::date,(ended AT TIME ZONE 'Asia/Shanghai')::date-1,interval '1 day')g)
  SELECT coalesce(jsonb_agg(jsonb_build_object('day',days.day,'amount',coalesce(dy.amount,0),'cost',coalesce(dy.cost,0),'sold',coalesce(dy.sold,0),'returned',coalesce(dy.returned,0),'refund',coalesce(dy.refund,0)) ORDER BY days.day),'[]') INTO result FROM days LEFT JOIN daily dy ON dy.day=days.day;RETURN result;
 END IF;
 IF a='visit-trend' THEN
  WITH daily AS(SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(DISTINCT visitor_hash) FILTER(WHERE type='pv') uv,count(*) FILTER(WHERE type='pv') pv FROM visit_events WHERE created_at>=started AND created_at<ended GROUP BY day),days AS(SELECT g::date AS day FROM generate_series((started AT TIME ZONE 'Asia/Shanghai')::date,(ended AT TIME ZONE 'Asia/Shanghai')::date-1,interval '1 day')g)
  SELECT coalesce(jsonb_agg(jsonb_build_object('day',days.day,'uv',coalesce(dy.uv,0),'pv',coalesce(dy.pv,0)) ORDER BY days.day),'[]') INTO result FROM days LEFT JOIN daily dy ON dy.day=days.day;RETURN result;
 END IF;
 IF a='breakdown' THEN
  WITH grouped AS(SELECT CASE d->>'dimension' WHEN 'staff' THEN e.seller_id::text WHEN 'store' THEN e.store ELSE e.model_id END key,max(e.model_name) model_name,sum(e.amount) amount,sum(e.cost) cost,sum(e.sold) sold,sum(e.returned) returned,sum(e.refund) refund FROM report_sales_events(started,ended)e GROUP BY key)
  SELECT coalesce(jsonb_agg(to_jsonb(gr)||jsonb_build_object('label',CASE d->>'dimension' WHEN 'staff' THEN coalesce((SELECT coalesce(st.name,usr.nickname) FROM users usr LEFT JOIN staff st ON st.user_id=usr.id WHERE usr.id=gr.key::uuid),'未知员工') WHEN 'store' THEN coalesce(nullif(gr.key,''),'未指定门店') ELSE gr.model_name END) ORDER BY gr.amount DESC),'[]') INTO result FROM grouped gr;RETURN result;
 END IF;
 IF a='ageing' THEN
  IF NOT perms ? 'inventory:view' THEN PERFORM stock_error('P0403','无库存查看权限'); END IF;
  WITH matches AS(SELECT un.id,un.created_at FROM units un WHERE un.status='in_stock' AND un.created_at<=now()-((d->>'days')::int*interval '1 day')),paged AS(SELECT * FROM matches ORDER BY created_at,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(stock_raw(pg.id) ORDER BY pg.created_at,pg.id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a='dashboard' THEN
  IF NOT perms ? 'dashboard:view' THEN PERFORM stock_error('P0403','无工作台权限'); END IF;
  SELECT jsonb_build_object('inStock',count(*) FILTER(WHERE un.status='in_stock'),'repairing',count(*) FILTER(WHERE un.status='repairing'),'loanedOut',count(*) FILTER(WHERE un.status='loaned_out'),'recheck',count(*) FILTER(WHERE un.status='recheck'),'todayInbound',count(*) FILTER(WHERE un.ownership='own' AND un.created_at>=started AND un.created_at<ended),'stockCost',coalesce(sum(un.cost) FILTER(WHERE un.status='in_stock'),0),'inTransit',(SELECT coalesce(sum(pl.quantity-pl.received_count),0) FROM purchase_lines pl JOIN purchase_orders po ON po.id=pl.purchase_id WHERE po.status='in_transit'),'pendingAcceptance',(SELECT coalesce(sum(pl.quantity-pl.received_count),0) FROM purchase_lines pl JOIN purchase_orders po ON po.id=pl.purchase_id WHERE po.status IN ('arrived','accepting','exception'))) INTO inventory FROM units un;
  SELECT jsonb_build_object('ageing',(SELECT count(*) FROM units WHERE status='in_stock' AND created_at<=now()-interval '31 days'),'customerRequests',(SELECT count(*) FROM customer_request_states WHERE status='new'),'agentApplications',(SELECT count(*) FROM agents WHERE status='pending'),'agentOrders',(SELECT count(*) FROM agent_order_states WHERE status='locked'),'agentEarnings',(SELECT count(*) FROM agent_earning_states WHERE status='pending'),'loanOverdue',(SELECT count(*) FROM loan_orders lo JOIN loan_states ls ON ls.order_id=lo.id WHERE ls.status='active' AND lo.due_date<(now() AT TIME ZONE 'Asia/Shanghai')::date),'loanRecheck',(SELECT count(*) FROM loan_item_states WHERE status='returned_recheck'),'repairOverdue',(SELECT count(*) FROM repair_orders ro WHERE ro.status NOT IN ('completed','cancelled') AND coalesce(ro.expected_date,(ro.created_at AT TIME ZONE 'Asia/Shanghai')::date+7)<(now() AT TIME ZONE 'Asia/Shanghai')::date AND (repair_scope OR ro.engineer_id=actor)),'repairActive',(SELECT count(*) FROM repair_orders ro WHERE ro.status NOT IN ('completed','cancelled') AND (repair_scope OR ro.engineer_id=actor))) INTO counts;
  IF perms ?| ARRAY['repair:handle','repair:quote','repair:cash','stats:view'] THEN repair_v:=api_repairs('stats',NULL,d,u,p_request_id,'capitalize'); END IF;
  RETURN jsonb_build_object('sales',report_overview(started,ended),'inventory',inventory,'visits',report_visits(started,ended),'counts',counts,'repair',repair_v);
 END IF;
 PERFORM stock_error('P0404','接口尚未迁移');
END $$;