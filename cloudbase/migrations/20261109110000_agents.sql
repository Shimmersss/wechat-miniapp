-- 代理、分享及代理下单依赖。普通咨询/预约归因保持未迁移，不伪造成交。
REVOKE UPDATE,DELETE,TRUNCATE ON agent_orders,agent_earnings,customer_requests,customer_request_events,sales_attributions,share_items FROM service_role;
CREATE TABLE agent_request_limits(actor_key text NOT NULL,kind text NOT NULL,window_start timestamptz NOT NULL,attempts int NOT NULL,PRIMARY KEY(actor_key,kind));
ALTER TABLE agent_request_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_request_limits FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON agent_request_limits TO service_role;
CREATE INDEX agent_orders_expiry ON agent_orders(lock_expires_at,request_id);
CREATE INDEX agent_orders_agent ON agent_orders(agent_id,created_at DESC);
CREATE INDEX agent_earnings_agent ON agent_earnings(agent_id,created_at DESC);
CREATE INDEX agent_earning_states_status ON agent_earning_states(status,earning_id);
CREATE INDEX share_links_owner_time ON share_links(owner_id,created_at);
CREATE FUNCTION agent_rate_limit(p_actor text,p_kind text,p_max int) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE count_v int;
BEGIN
 INSERT INTO agent_request_limits(actor_key,kind,window_start,attempts) VALUES(p_actor,p_kind,clock_timestamp(),1)
 ON CONFLICT(actor_key,kind) DO UPDATE SET attempts=CASE WHEN agent_request_limits.window_start<=clock_timestamp()-interval '1 minute' THEN 1 ELSE agent_request_limits.attempts+1 END,window_start=CASE WHEN agent_request_limits.window_start<=clock_timestamp()-interval '1 minute' THEN clock_timestamp() ELSE agent_request_limits.window_start END RETURNING attempts INTO count_v;
 RETURN count_v<=p_max;
END $$;
CREATE FUNCTION agent_person(who uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(g)||jsonb_build_object('inviter_name',i.name) FROM agents g LEFT JOIN agents i ON i.user_id=g.inviter_id WHERE g.user_id=who
$$;
CREATE FUNCTION agent_active(u jsonb) RETURNS agents LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE g agents;
BEGIN
 IF u->>'id' IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;
 SELECT * INTO g FROM agents WHERE user_id=(u->>'id')::uuid;
 IF g.user_id IS NULL OR g.status<>'active' OR u->>'role'<>'agent' OR u->>'staffNo' IS NOT NULL THEN PERFORM stock_error('P0403','仅已审核通过的代理可使用'); END IF;RETURN g;
END $$;
CREATE FUNCTION agent_public_unit(uid uuid,channel_v text,price_v numeric) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('id',un.id,'model_id',un.model_id,'name',m.name,'brand',m.brand,'category_id',m.category_id,'condition_type',un.condition_type,
 'attributes',coalesce((SELECT jsonb_object_agg(f->>'key',un.attributes->(f->>'key')) FROM jsonb_array_elements(un.template_snapshot->'fields') f WHERE shop_field_public(un.template_snapshot,f->>'key',CASE WHEN channel_v='peer' THEN 'peer' ELSE 'customer' END) AND f->>'key'<>ALL(ARRAY['cost','supplier','internalNote','fullImei','wholesalePrice','profit','agentBase','imei1','imei2','receipt','retail','wholesale'])),'{}'),
 'template_snapshot',un.template_snapshot,'imei_masked',left(un.imei1,2)||'****'||right(un.imei1,4),'desc',CASE WHEN channel_v='peer' THEN un.peer_desc ELSE un.customer_desc END,'price',price_v,
 'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position) FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=un.id AND f.scope='public' AND (uf.field_key='publicImages' OR shop_field_public(un.template_snapshot,uf.field_key,CASE WHEN channel_v='peer' THEN 'peer' ELSE 'customer' END))),'[]')) FROM units un JOIN models m ON m.id=un.model_id WHERE un.id=uid
$$;
CREATE FUNCTION agent_share_resolve(sid text,u jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE link share_links; owner users; st staff; r roles; un units; item share_items; rows_v jsonb:='[]'; peer_ok boolean;
BEGIN
 SELECT * INTO link FROM share_links WHERE id=sid;
 IF NOT FOUND OR NOT link.active THEN PERFORM stock_error('P0404','分享不存在或已撤销'); END IF;
 IF link.expires_at<=now() THEN PERFORM stock_error('P0410','分享已过期'); END IF;
 SELECT * INTO owner FROM users WHERE id=link.owner_id;
 IF owner.id IS NULL OR owner.status<>'active' THEN PERFORM stock_error('P0410','分享人账号已停用'); END IF;
 IF link.owner_kind='staff' THEN
  SELECT * INTO st FROM staff WHERE user_id=owner.id;SELECT * INTO r FROM roles WHERE role_key=st.role_key;
  IF st.status IS DISTINCT FROM 'active' OR NOT r.permissions ? 'share:do' THEN PERFORM stock_error('P0410','分享授权已变更'); END IF;
 END IF;
 IF link.channel='agent' AND (owner.role<>'agent' OR owner.agent_status IS DISTINCT FROM 'active' OR NOT EXISTS(SELECT 1 FROM agents WHERE user_id=owner.id AND status='active')) THEN PERFORM stock_error('P0410','代理资格已变更，分享失效'); END IF;
 IF link.channel='peer' THEN
  IF NOT (owner.role='peer' OR (st.status='active' AND r.permissions ? 'share:do' AND (r.visible_fields IS NULL OR r.visible_fields ? 'wholesalePrice'))) THEN PERFORM stock_error('P0410','同行分享授权已变更'); END IF;
  peer_ok:=u->>'role'='peer' OR (u->>'staffNo' IS NOT NULL AND coalesce(u->'permissions','[]') ? 'share:do' AND stock_can(u,'wholesalePrice'));
  IF NOT coalesce(peer_ok,false) THEN PERFORM stock_error('P0403','此分享仅供已授权同行查看'); END IF;
 END IF;
 FOR item IN SELECT * FROM share_items WHERE share_id=sid ORDER BY unit_id LOOP
  SELECT * INTO un FROM units WHERE id=item.unit_id;
  IF un.status<>'in_stock' OR (un.share_flags->>CASE link.channel WHEN 'agent' THEN 'shareAgent' WHEN 'peer' THEN 'sharePeer' ELSE 'showInShop' END) IS DISTINCT FROM 'true' THEN PERFORM stock_error('P0410','分享中的设备已下架或不可售'); END IF;
  IF un.price_version<>item.price_version THEN PERFORM stock_error('P0410','商品价格已变化，请重新分享'); END IF;
  rows_v:=rows_v||jsonb_build_array(agent_public_unit(un.id,link.channel,item.price));
 END LOOP;
 IF jsonb_array_length(rows_v)=0 THEN PERFORM stock_error('P0404','分享暂无商品'); END IF;
 RETURN jsonb_build_object('link',to_jsonb(link),'units',rows_v);
END $$;
CREATE FUNCTION agent_order_raw(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(a)||jsonb_build_object('lock_status',s.status,'sale_order_id',s.sale_order_id,'release_reason',s.release_reason,'customer_name',c.name,'customer_phone',c.phone,'unit_snapshot',c.unit_snapshot,'request_status',cs.status,'agent_name',g.name)
 FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id JOIN customer_requests c ON c.id=a.request_id JOIN customer_request_states cs ON cs.request_id=a.request_id JOIN agents g ON g.user_id=a.agent_id WHERE a.request_id=rid
$$;
CREATE FUNCTION agent_request_raw(rid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(c)||jsonb_build_object('status',s.status,'version',s.version,'updated_at',s.updated_at,'sale_order_id',(SELECT order_id FROM sales_attributions WHERE customer_request_id=c.id),'share_owner_name',(SELECT nickname FROM users WHERE id=c.share_owner_id),'agent_order',agent_order_raw(c.id),
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('nickname',usr.nickname) ORDER BY e.version,e.id) FROM customer_request_events e JOIN users usr ON usr.id=e.actor_id WHERE e.request_id=c.id),'[]')) FROM customer_requests c JOIN customer_request_states s ON s.request_id=c.id WHERE c.id=rid
$$;
CREATE FUNCTION agent_unlock(rid uuid,why text,actor uuid DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE s agent_order_states; a agent_orders; un units; who uuid;
BEGIN
 SELECT * INTO s FROM agent_order_states WHERE request_id=rid FOR UPDATE;
 IF NOT FOUND OR s.status<>'locked' THEN RETURN false; END IF;
 SELECT * INTO a FROM agent_orders WHERE request_id=rid;SELECT * INTO un FROM units WHERE id=a.unit_id FOR UPDATE;
 DELETE FROM agent_unit_locks WHERE unit_id=a.unit_id AND request_id=rid;
 UPDATE agent_order_states SET status='released',release_reason=why,updated_at=now() WHERE request_id=rid;
 IF un.status='locked' THEN
  UPDATE units SET status='in_stock' WHERE id=un.id;
  SELECT coalesce(actor,owner_id) INTO who FROM customer_requests WHERE id=rid;
  INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(un.id,'locked','in_stock','agent_order',rid::text,who,why);
 END IF;RETURN true;
END $$;
CREATE FUNCTION agent_release_expired() RETURNS int LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE rid uuid; n int:=0;
BEGIN
 FOR rid IN SELECT a.request_id FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id WHERE s.status='locked' AND a.lock_expires_at<=now() ORDER BY a.unit_id LIMIT 100 FOR UPDATE OF s SKIP LOCKED LOOP
  IF agent_unlock(rid,'下单锁定到期自动释放') THEN n:=n+1; END IF;
 END LOOP;RETURN n;
END $$;
CREATE FUNCTION agent_earning_totals(who uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('pendingAmount',coalesce(sum(CASE WHEN s.status='pending' THEN e.amount*CASE WHEN e.kind='reversal' THEN -1 ELSE 1 END ELSE 0 END),0),'settledAmount',coalesce(sum(CASE WHEN s.status='settled' THEN e.amount*CASE WHEN e.kind='reversal' THEN -1 ELSE 1 END ELSE 0 END),0)) FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id WHERE who IS NULL OR e.agent_id=who
$$;
CREATE FUNCTION api_agents(p_action text,p_id text,p_data jsonb,p_user jsonb,p_request_id text,p_config jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 d jsonb:=p_data; u jsonb:=p_user; actor uuid:=(p_user->>'id')::uuid; perms jsonb:=coalesce(p_user->'permissions','[]'); a text:=p_action; g agents; inviter agents; s agent_settings; un units; link share_links; item share_items;
 rid uuid; fid uuid; tid uuid; share_v text; invite_v text; v jsonb; x jsonb; result jsonb; rows_v jsonb:='[]'; owner_v uuid; cr customer_requests; cs customer_request_states; old_hash text; event_v customer_request_events;
 amount numeric(14,2); markup_v numeric(14,2); n bigint; today_v timestamptz:=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'; max_v numeric(14,2); state_v text; version_v int;
BEGIN
 IF a IN ('share.get','share.copy','share.poster') THEN RETURN agent_share_resolve(p_id,u); END IF;
 IF actor IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;
 IF a IN ('overview','orders','admin.orders') THEN PERFORM agent_release_expired(); END IF;
 IF a IN ('me','apply') THEN
  IF a='me' THEN IF u->>'staffNo' IS NOT NULL THEN RETURN NULL; END IF;RETURN agent_person(actor); END IF;
  IF u->>'staffNo' IS NOT NULL THEN PERFORM stock_error('P0403','员工账号不能申请代理'); END IF;
  PERFORM 1 FROM users WHERE id=actor FOR UPDATE;SELECT * INTO g FROM agents WHERE user_id=actor FOR UPDATE;
  IF g.status IN ('active','pending','disabled') THEN PERFORM stock_error('P0409',CASE g.status WHEN 'active' THEN '你已经是代理' WHEN 'pending' THEN '申请正在审核中' ELSE '代理资格已停用，请联系门店' END); END IF;
  IF nullif(d->>'inviteCode','') IS NOT NULL THEN SELECT * INTO inviter FROM agents WHERE invite_code=d->>'inviteCode' AND status='active';IF NOT FOUND OR inviter.user_id=actor THEN PERFORM stock_error('P0400','邀请码无效'); END IF; END IF;
  INSERT INTO agents(user_id,name,phone,region,inviter_id) VALUES(actor,d->>'name',d->>'phone',d->>'region',inviter.user_id)
  ON CONFLICT(user_id) DO UPDATE SET status='pending',name=excluded.name,phone=excluded.phone,region=excluded.region,inviter_id=excluded.inviter_id,review_remark='',reviewed_by=NULL,reviewed_at=NULL,applied_at=now(),version=agents.version+1;
  PERFORM stock_audit(u,p_request_id,'提交代理申请',actor::text,NULL,jsonb_build_object('region',d->'region','inviterId',inviter.user_id));RETURN agent_person(actor);
 END IF;
 IF a LIKE 'admin.%' AND a NOT IN ('admin.requests','admin.request.get','admin.request.status') THEN
  IF u->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','仅员工可操作'); END IF;
  IF a IN ('admin.settings','admin.agents.list','admin.earnings') THEN IF NOT perms ?| ARRAY['agent:review','agent:settle'] THEN PERFORM stock_error('P0403','无权限管理代理'); END IF;
  ELSIF a='admin.settle' THEN IF NOT perms ? 'agent:settle' THEN PERFORM stock_error('P0403','无收益转账权限'); END IF;
  ELSIF a='admin.orders' THEN IF NOT perms ?| ARRAY['agent:review','agent:settle','sales:create'] THEN PERFORM stock_error('P0403','无权限查看代理订单'); END IF;
  ELSIF NOT perms ? 'agent:review' THEN PERFORM stock_error('P0403','无代理审核权限'); END IF;
 END IF;
 IF a IN ('admin.settings','admin.settings.update') THEN
  IF (p_config->>'lockMinutes')::int NOT BETWEEN 5 AND 1440 THEN PERFORM stock_error('P0503','代理下单锁库时长配置无效'); END IF;
  SELECT * INTO s FROM agent_settings WHERE id=1 FOR UPDATE;
  IF a='admin.settings.update' THEN
   IF s.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','设置已被他人修改，请刷新'); END IF;
   markup_v:=s.default_markup_max;amount:=stock_money(d->'defaultMarkupMax');IF amount>100000 THEN PERFORM stock_error('P0400','加价上限过大'); END IF;
   UPDATE agent_settings SET default_markup_max=amount,version=version+1,updated_by=actor,updated_at=now() WHERE id=1 RETURNING * INTO s;
   PERFORM stock_audit(u,p_request_id,'调整代理默认加价上限','agent_settings',jsonb_build_object('defaultMarkupMax',markup_v),jsonb_build_object('defaultMarkupMax',amount),d->>'reason');
  END IF;RETURN jsonb_build_object('defaultMarkupMax',s.default_markup_max,'version',s.version,'lockMinutes',p_config->'lockMinutes');
 END IF;
 IF a IN ('admin.applications.list','admin.agents.list') THEN
  state_v:=coalesce(nullif(d->>'status',''),CASE WHEN a='admin.applications.list' THEN 'pending' END);
  WITH matches AS(SELECT ag.* FROM agents ag WHERE (state_v IS NULL OR ag.status=state_v) AND (nullif(d->>'keyword','') IS NULL OR ag.name ILIKE '%'||(d->>'keyword')||'%' OR ag.phone ILIKE '%'||(d->>'keyword')||'%' OR ag.region ILIKE '%'||(d->>'keyword')||'%')),paged AS(SELECT * FROM matches ORDER BY applied_at DESC,user_id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(agent_person(pg.user_id) ORDER BY applied_at DESC,user_id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a IN ('admin.review','admin.update') THEN
  SELECT * INTO g FROM agents WHERE user_id=p_id::uuid FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','代理或申请不存在'); END IF;
  IF g.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','代理资料已更新，请刷新'); END IF;
  IF a='admin.review' THEN
   IF g.status<>'pending' THEN PERFORM stock_error('P0409','申请已处理或已更新，请刷新'); END IF;
   IF d->'approve'='true'::jsonb THEN
    SELECT * INTO s FROM agent_settings WHERE id=1;max_v:=coalesce((d->>'markupMax')::numeric,s.default_markup_max);
    SELECT value#>>'{}' INTO invite_v FROM jsonb_array_elements(p_config->'inviteCodes') WHERE length(value#>>'{}')=8 AND NOT EXISTS(SELECT 1 FROM agents WHERE invite_code=value#>>'{}') LIMIT 1;
    IF g.invite_code IS NULL AND invite_v IS NULL THEN PERFORM stock_error('P0503','邀请码生成失败，请重试'); END IF;
    UPDATE agents SET status='active',markup_max=max_v,invite_code=coalesce(invite_code,invite_v),review_remark=d->>'remark',reviewed_by=actor,reviewed_at=now(),version=version+1 WHERE user_id=g.user_id;
    UPDATE users SET role='agent',agent_status='active' WHERE id=g.user_id;
   ELSE UPDATE agents SET status='rejected',review_remark=d->>'remark',reviewed_by=actor,reviewed_at=now(),version=version+1 WHERE user_id=g.user_id; END IF;
   PERFORM stock_audit(u,p_request_id,CASE WHEN d->'approve'='true'::jsonb THEN '通过代理申请' ELSE '拒绝代理申请' END,g.user_id::text,NULL,jsonb_build_object('status',CASE WHEN d->'approve'='true'::jsonb THEN 'active' ELSE 'rejected' END),d->>'remark');
  ELSE
   IF g.status NOT IN ('active','disabled') THEN PERFORM stock_error('P0404','代理不存在'); END IF;
   UPDATE agents SET status=coalesce(d->>'status',status),markup_max=coalesce((d->>'markupMax')::numeric,markup_max),version=version+1 WHERE user_id=g.user_id;
   UPDATE users SET agent_status=coalesce(d->>'status',g.status) WHERE id=g.user_id;
   PERFORM stock_audit(u,p_request_id,'调整代理资格或加价上限',g.user_id::text,jsonb_build_object('status',g.status,'markupMax',g.markup_max),jsonb_build_object('status',coalesce(d->>'status',g.status),'markupMax',coalesce((d->>'markupMax')::numeric,g.markup_max)),d->>'reason');
  END IF;RETURN agent_person(g.user_id);
 END IF;
 IF a='admin.settle' THEN
  FOR tid IN SELECT value::uuid FROM jsonb_array_elements_text(d->'ids') ORDER BY value LOOP
   SELECT status INTO state_v FROM agent_earning_states WHERE earning_id=tid FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','收益记录不存在'); END IF;IF state_v<>'pending' THEN PERFORM stock_error('P0409','所选记录已转账或已冲回，请刷新'); END IF;
  END LOOP;
  FOR tid IN SELECT value::uuid FROM jsonb_array_elements_text(d->'ids') LOOP
   UPDATE agent_earning_states SET status='settled',settled_by=actor,settled_at=now(),settle_reason=d->>'reason' WHERE earning_id=tid;PERFORM stock_audit(u,p_request_id,'标记代理收益已转账',tid::text,NULL,NULL,d->>'reason');
  END LOOP;RETURN jsonb_build_object('settled',jsonb_array_length(d->'ids'));
 END IF;
 IF a IN ('units','markup','invite','overview','orders','commissions') THEN g:=agent_active(u); END IF;
 IF a='invite' THEN RETURN jsonb_build_object('inviteCode',g.invite_code,'members',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY applied_at DESC) FROM(SELECT name,status,applied_at FROM agents WHERE inviter_id=actor ORDER BY applied_at DESC LIMIT 200)x),'[]')); END IF;
 IF a='overview' THEN RETURN jsonb_build_object('todayVisitors',(SELECT count(DISTINCT visitor_hash) FROM visit_events WHERE share_owner_id=actor AND type='pv' AND created_at>=today_v),'todayViews',(SELECT count(*) FROM visit_events WHERE share_owner_id=actor AND type='pv' AND created_at>=today_v),'todayShares',(SELECT count(*) FROM share_links WHERE owner_id=actor AND channel='agent' AND created_at>=today_v),'lockedOrders',(SELECT count(*) FROM agent_orders ao JOIN agent_order_states st ON st.request_id=ao.request_id WHERE ao.agent_id=actor AND st.status='locked'),'soldOrders',(SELECT count(*) FROM agent_orders ao JOIN agent_order_states st ON st.request_id=ao.request_id WHERE ao.agent_id=actor AND st.status='sold'),'markupMax',g.markup_max)||agent_earning_totals(actor); END IF;
 IF a IN ('units','markup') THEN
  IF a='markup' THEN
   SELECT * INTO un FROM units WHERE id=p_id::uuid FOR SHARE;IF NOT FOUND OR un.status<>'in_stock' OR un.ownership<>'own' OR un.share_flags->'shareAgent' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0409','该设备当前不允许代理转发'); END IF;
   amount:=stock_money(d->'markup');IF amount>g.markup_max THEN PERFORM stock_error('P0400','加价不能超过上限'); END IF;
   INSERT INTO agent_markups(agent_id,unit_id,markup) VALUES(actor,un.id,amount) ON CONFLICT(agent_id,unit_id) DO UPDATE SET markup=excluded.markup,updated_at=now();PERFORM stock_audit(u,p_request_id,'代理设置加价',un.id::text,NULL,jsonb_build_object('markup',amount));
   RETURN agent_public_unit(un.id,'agent',un.agent_base+amount)||jsonb_build_object('retail',un.retail,'markup',amount,'markupMax',g.markup_max,'price_version',un.price_version);
  END IF;
  WITH matches AS(SELECT un.*,coalesce(am.markup,0) markup FROM units un JOIN models m ON m.id=un.model_id LEFT JOIN agent_markups am ON am.agent_id=actor AND am.unit_id=un.id WHERE un.status='in_stock' AND un.ownership='own' AND un.share_flags->'shareAgent'='true'::jsonb AND (nullif(d->>'keyword','') IS NULL OR m.name ILIKE '%'||(d->>'keyword')||'%')),paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(agent_public_unit(pg.id,'agent',pg.agent_base+pg.markup)||jsonb_build_object('retail',pg.retail,'markup',pg.markup,'markupMax',g.markup_max,'price_version',pg.price_version) ORDER BY pg.created_at DESC,pg.id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a IN ('orders','admin.orders') THEN
  WITH matches AS(SELECT ao.* FROM agent_orders ao JOIN agent_order_states st ON st.request_id=ao.request_id WHERE (a='admin.orders' OR ao.agent_id=actor) AND (nullif(d->>'agentId','') IS NULL OR ao.agent_id=(d->>'agentId')::uuid) AND (nullif(d->>'status','') IS NULL OR st.status=d->>'status')),paged AS(SELECT * FROM matches ORDER BY created_at DESC,request_id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(agent_order_raw(pg.request_id) ORDER BY pg.created_at DESC,pg.request_id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a IN ('commissions','admin.earnings') THEN
  owner_v:=CASE WHEN a='commissions' THEN actor ELSE nullif(d->>'agentId','')::uuid END;
  WITH matches AS(SELECT e.*,st.status,st.settled_at,st.settle_reason,c.unit_snapshot,ag.name agent_name FROM agent_earnings e JOIN agent_earning_states st ON st.earning_id=e.id JOIN customer_requests c ON c.id=e.request_id JOIN agents ag ON ag.user_id=e.agent_id WHERE (owner_v IS NULL OR e.agent_id=owner_v) AND (nullif(d->>'status','') IS NULL OR st.status=d->>'status')),paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(to_jsonb(pg) ORDER BY created_at DESC,id),'[]'),'summary',agent_earning_totals(owner_v)) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a='share.create' THEN
  state_v:=d->>'channel';IF state_v='agent' THEN g:=agent_active(u);ELSIF state_v='peer' AND NOT (u->>'role'='peer' OR(u->>'staffNo' IS NOT NULL AND perms ? 'share:do' AND stock_can(u,'wholesalePrice'))) THEN PERFORM stock_error('P0403','无同行分享权限'); END IF;
  IF u->>'staffNo' IS NOT NULL AND NOT perms ? 'share:do' THEN PERFORM stock_error('P0403','无分享权限'); END IF;
  IF (p_config->>'shareHours')::numeric NOT BETWEEN 1 AND 720 THEN PERFORM stock_error('P0503','分享有效期配置无效'); END IF;
  share_v:=p_config->>'shareId';INSERT INTO share_links(id,owner_id,owner_kind,channel,expires_at) VALUES(share_v,actor,CASE WHEN u->>'staffNo' IS NOT NULL THEN 'staff' WHEN u->>'role' IN ('peer','agent') THEN u->>'role' ELSE 'customer' END,state_v,now()+((p_config->>'shareHours')::numeric*interval '1 hour')) RETURNING * INTO link;
  FOR tid IN SELECT value::uuid FROM jsonb_array_elements_text(d->'unitIds') ORDER BY value LOOP
   SELECT * INTO un FROM units WHERE id=tid FOR SHARE;
   IF NOT FOUND OR un.status<>'in_stock' OR un.share_flags->>(CASE state_v WHEN 'agent' THEN 'shareAgent' WHEN 'peer' THEN 'sharePeer' ELSE 'showInShop' END) IS DISTINCT FROM 'true' THEN PERFORM stock_error('P0409','所选设备不可对外分享'); END IF;
   markup_v:=NULL;amount:=CASE WHEN state_v='peer' THEN un.wholesale ELSE un.retail END;
   IF state_v='agent' THEN SELECT coalesce((SELECT markup FROM agent_markups WHERE agent_id=actor AND unit_id=tid),0) INTO markup_v;amount:=un.agent_base+markup_v;END IF;
   INSERT INTO share_items(share_id,unit_id,price_version,price,markup) VALUES(share_v,tid,un.price_version,amount,markup_v);
  END LOOP;
  PERFORM stock_audit(u,p_request_id,'生成商品分享',share_v,NULL,jsonb_build_object('channel',state_v,'unitIds',d->'unitIds','expiresAt',link.expires_at));RETURN agent_share_resolve(share_v,u);
 END IF;
 IF a='share.revoke' THEN
  SELECT * INTO link FROM share_links WHERE id=p_id FOR UPDATE;IF NOT FOUND OR link.owner_id<>actor THEN PERFORM stock_error('P0404','分享不存在'); END IF;UPDATE share_links SET active=false WHERE id=p_id;PERFORM stock_audit(u,p_request_id,'撤销商品分享',p_id,NULL,NULL,d->>'reason');RETURN '{"revoked":true}';
 END IF;
 IF a='order.create' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('request:'||actor::text||':'||(d->>'requestKey'),0));SELECT * INTO cr FROM customer_requests WHERE owner_id=actor AND request_key=d->>'requestKey';
  IF FOUND THEN IF cr.request_hash<>d->>'signature' THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF;RETURN agent_request_raw(cr.id); END IF;
  SELECT * INTO un FROM units WHERE id=(d->>'unitId')::uuid FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','商品不存在或已下架'); END IF;
  result:=agent_share_resolve(d->>'shareId',u);SELECT * INTO link FROM share_links WHERE id=d->>'shareId';
  IF link.channel<>'agent' THEN PERFORM stock_error('P0400','仅代理分享链接支持下单'); END IF;IF link.owner_id=actor THEN PERFORM stock_error('P0400','不能通过自己的分享链接下单'); END IF;
  SELECT * INTO item FROM share_items WHERE share_id=link.id AND unit_id=un.id;IF NOT FOUND THEN PERFORM stock_error('P0404','商品不在本分享内'); END IF;
  IF un.ownership<>'own' OR un.status<>'in_stock' OR un.share_flags->'shareAgent' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0409','该设备已被锁定或售出'); END IF;
  IF un.price_version<>item.price_version OR un.agent_base+coalesce(item.markup,0)<>item.price THEN PERFORM stock_error('P0410','代理价已变化，请重新获取分享'); END IF;
  IF (p_config->>'lockMinutes')::int NOT BETWEEN 5 AND 1440 THEN PERFORM stock_error('P0503','代理下单锁库时长配置无效'); END IF;
  rid:=gen_random_uuid();SELECT value INTO x FROM jsonb_array_elements(result->'units') WHERE value->>'id'=un.id::text;
  INSERT INTO customer_requests(id,owner_id,kind,unit_id,unit_snapshot,content,phone,name,source,share_id,share_owner_id,request_key,request_hash) VALUES(rid,actor,'order',un.id,x,d->>'content',d->>'phone',d->>'name','agent',link.id,link.owner_id,d->>'requestKey',d->>'signature');INSERT INTO customer_request_states(request_id) VALUES(rid);
  INSERT INTO agent_orders(request_id,agent_id,unit_id,share_id,agent_base,markup,share_price,price_version,lock_expires_at) VALUES(rid,link.owner_id,un.id,link.id,un.agent_base,coalesce(item.markup,0),item.price,un.price_version,now()+((p_config->>'lockMinutes')::int*interval '1 minute'));INSERT INTO agent_order_states(request_id) VALUES(rid);INSERT INTO agent_unit_locks(unit_id,request_id) VALUES(un.id,rid);UPDATE units SET status='locked' WHERE id=un.id;
  INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(un.id,'in_stock','locked','agent_order',rid::text,actor,'代理链接下单锁定 '||(p_config->>'lockMinutes')||' 分钟');
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),rid,actor,'customer',NULL,'new',1,'',d->>'requestKey',d->>'signature');PERFORM stock_audit(u,p_request_id,'代理链接下单',rid::text,NULL,jsonb_build_object('kind','order','unitId',un.id,'shareId',link.id));RETURN agent_request_raw(rid);
 END IF;
 IF a IN ('requests','request.get','order.cancel','admin.requests','admin.request.get','admin.request.status') THEN
  IF a LIKE 'admin.%' AND (u->>'staffNo' IS NULL OR NOT perms ? 'consult:manage') THEN PERFORM stock_error('P0403','仅有顾客跟进权限的员工可操作'); END IF;
  IF a IN ('requests','admin.requests') THEN
   IF d ? 'kind' AND d->>'kind'<>'order' THEN PERFORM stock_error('P0503','普通咨询预约尚未迁移'); END IF;
   WITH matches AS(SELECT c.* FROM customer_requests c JOIN customer_request_states st ON st.request_id=c.id WHERE c.kind='order' AND (a='admin.requests' OR c.owner_id=actor) AND (nullif(d->>'status','') IS NULL OR st.status=d->>'status') AND (a<>'admin.requests' OR nullif(d->>'keyword','') IS NULL OR c.name ILIKE '%'||(d->>'keyword')||'%' OR c.phone ILIKE '%'||(d->>'keyword')||'%' OR c.id::text=d->>'keyword')),paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
   SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(agent_request_raw(pg.id) ORDER BY created_at DESC,id),'[]')) INTO result FROM paged pg;RETURN result;
  END IF;
  SELECT * INTO cs FROM customer_request_states WHERE request_id=p_id::uuid FOR UPDATE;SELECT * INTO cr FROM customer_requests WHERE id=p_id::uuid;
  IF cs.request_id IS NULL OR cr.id IS NULL OR (a NOT LIKE 'admin.%' AND cr.owner_id<>actor) THEN PERFORM stock_error('P0404','记录不存在'); END IF;IF cr.kind<>'order' THEN PERFORM stock_error('P0503','普通咨询预约尚未迁移'); END IF;
  IF a IN ('request.get','admin.request.get') THEN RETURN agent_request_raw(cr.id); END IF;
  SELECT * INTO event_v FROM customer_request_events WHERE request_id=cr.id AND actor_id=actor AND request_key=d->>'requestKey';IF FOUND THEN IF event_v.request_hash<>d->>'signature' THEN PERFORM stock_error('P0409','操作标识内容冲突'); END IF;RETURN jsonb_build_object('id',cr.id,'status',event_v.to_status,'version',event_v.version); END IF;
  IF cs.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','记录已更新，请刷新后处理'); END IF;
  state_v:=d->>'status';IF cs.status NOT IN ('new','contacted') OR state_v NOT IN ('contacted','closed','cancelled') OR state_v=cs.status THEN PERFORM stock_error('P0409','当前状态不能执行此操作'); END IF;
  UPDATE customer_request_states SET status=state_v,version=version+1,updated_at=now() WHERE request_id=cr.id;
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),cr.id,actor,CASE WHEN a='order.cancel' THEN 'customer' ELSE 'staff' END,cs.status,state_v,cs.version+1,d->>'reason',d->>'requestKey',d->>'signature');
  IF state_v IN ('closed','cancelled') THEN PERFORM agent_unlock(cr.id,CASE WHEN a='order.cancel' THEN '顾客取消代理订单' ELSE '门店关闭代理订单：'||(d->>'reason') END,actor); END IF;
  PERFORM stock_audit(u,p_request_id,CASE WHEN a='order.cancel' THEN '取消咨询预约' ELSE '跟进咨询预约' END,cr.id::text,NULL,jsonb_build_object('status',state_v,'version',cs.version+1),d->>'reason');RETURN jsonb_build_object('id',cr.id,'status',state_v,'version',cs.version+1);
 END IF;
 PERFORM stock_error('P0404','接口尚未迁移');
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','记录或设备已被占用，请刷新后重试');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN PERFORM stock_error('P0400','参数或金额无效');
 WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN PERFORM stock_error('P0409','记录正被其他操作更新，请重试');
END $$;
REVOKE ALL ON FUNCTION agent_rate_limit(text,text,int),agent_person(uuid),agent_active(jsonb),agent_public_unit(uuid,text,numeric),agent_share_resolve(text,jsonb),agent_order_raw(uuid),agent_request_raw(uuid),agent_unlock(uuid,text,uuid),agent_release_expired(),agent_earning_totals(uuid),api_agents(text,text,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION agent_rate_limit(text,text,int),agent_person(uuid),agent_active(jsonb),agent_public_unit(uuid,text,numeric),agent_share_resolve(text,jsonb),agent_order_raw(uuid),agent_request_raw(uuid),agent_unlock(uuid,text,uuid),agent_release_expired(),agent_earning_totals(uuid),api_agents(text,text,jsonb,jsonb,text,jsonb) TO service_role;
