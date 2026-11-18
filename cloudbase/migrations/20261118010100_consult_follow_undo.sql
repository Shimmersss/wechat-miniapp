-- 仅撤销同一员工刚执行的新咨询联系操作。沿用版本锁、幂等和审计。
CREATE OR REPLACE FUNCTION api_customer_requests(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text,p_config jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE actor uuid:=(p_user->>'id')::uuid; doc_row customer_requests; state_row customer_request_states; event_row customer_request_events; unit_row units; ctx jsonb; snapshot jsonb; result jsonb; target uuid; kind_v text; transitions jsonb; undo_v boolean; today_v date:=(now() AT TIME ZONE 'Asia/Shanghai')::date; a text:=p_action; d jsonb:=p_data;
BEGIN
 IF actor IS NULL THEN PERFORM stock_error('P0401','请先登录'); END IF;
 IF a LIKE 'staff.%' AND (p_user->>'staffNo' IS NULL OR NOT coalesce(p_user->'permissions','[]') ? 'consult:manage') THEN PERFORM stock_error('P0403','仅有顾客跟进权限的员工可操作'); END IF;
 IF a='order.create' THEN
  result:=api_agents('order.create',NULL,d,p_user,p_request_id,jsonb_build_object('lockMinutes',p_config->'lockMinutes'));
  RETURN customer_request_raw((result->>'id')::uuid);
 END IF;
 IF a IN ('consult.create','appointment.create') THEN
  kind_v:=split_part(a,'.',1);
  PERFORM pg_advisory_xact_lock(hashtextextended('request:'||actor::text||':'||(d->>'requestKey'),0));
  SELECT * INTO doc_row FROM customer_requests WHERE owner_id=actor AND request_key=d->>'requestKey';
  IF FOUND THEN IF doc_row.request_hash<>d->>'signature' THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF;RETURN customer_request_raw(doc_row.id); END IF;
  IF kind_v='appointment' THEN
   IF p_config->'valid' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0503','预约时段配置无效'); END IF;
   IF (d->>'date')::date<today_v OR (d->>'date')::date>today_v+(p_config->>'days')::int OR NOT (p_config->'slots') ? (d->>'timeSlot') THEN PERFORM stock_error('P0400','请选择有效的预约日期和时段'); END IF;
  END IF;
  IF d->>'unitId' IS NOT NULL THEN SELECT * INTO unit_row FROM units WHERE id=(d->>'unitId')::uuid FOR SHARE;IF NOT FOUND THEN PERFORM stock_error('P0404','商品不存在或已下架'); END IF; END IF;
  IF nullif(d->>'shareId','') IS NOT NULL THEN
   IF (d->>'shareId') !~ '^[A-Za-z0-9_-]{16}$' THEN PERFORM stock_error('P0404','分享不存在'); END IF;
   ctx:=agent_share_resolve(d->>'shareId',p_user);
   IF d->>'unitId' IS NOT NULL THEN SELECT value INTO snapshot FROM jsonb_array_elements(ctx->'units') WHERE value->>'id'=d->>'unitId';IF snapshot IS NULL THEN PERFORM stock_error('P0404','商品不在本分享内'); END IF; END IF;
  ELSIF d->>'unitId' IS NOT NULL THEN snapshot:=agent_shop_unit((d->>'unitId')::uuid,p_user); END IF;
  IF snapshot IS NOT NULL THEN snapshot:=snapshot||jsonb_build_object('priceType',CASE WHEN coalesce(ctx->'link'->>'channel',CASE WHEN p_user->>'role'='peer' THEN 'peer' ELSE 'customer' END)='peer' THEN 'wholesale' WHEN ctx->'link'->>'channel'='agent' THEN 'agent' ELSE 'retail' END); END IF;
  target:=gen_random_uuid();
  INSERT INTO customer_requests(id,owner_id,kind,unit_id,unit_snapshot,content,phone,name,appointment_date,time_slot,source,share_id,share_owner_id,request_key,request_hash) VALUES(target,actor,kind_v,(d->>'unitId')::uuid,snapshot,d->>'content',d->>'phone',d->>'name',(d->>'date')::date,d->>'timeSlot',coalesce(ctx->'link'->>'channel','natural'),ctx->'link'->>'id',(ctx->'link'->>'owner_id')::uuid,d->>'requestKey',d->>'signature');
  INSERT INTO customer_request_states(request_id) VALUES(target);
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),target,actor,'customer',NULL,'new',1,'',d->>'requestKey',d->>'signature');
  PERFORM stock_audit(p_user,p_request_id,CASE WHEN kind_v='appointment' THEN '提交到店预约' ELSE '提交商品咨询' END,target::text,NULL,jsonb_build_object('kind',kind_v,'unitId',d->'unitId','shareId',ctx->'link'->'id'));RETURN customer_request_raw(target);
 END IF;
 IF a IN ('list','staff.list') THEN
  WITH matches AS(SELECT cr.* FROM customer_requests cr JOIN customer_request_states st ON st.request_id=cr.id WHERE (a='staff.list' OR cr.owner_id=actor) AND (nullif(d->>'kind','') IS NULL OR cr.kind=d->>'kind') AND (nullif(d->>'status','') IS NULL OR st.status=d->>'status') AND (a<>'staff.list' OR nullif(d->>'keyword','') IS NULL OR cr.name ILIKE '%'||(d->>'keyword')||'%' OR cr.phone ILIKE '%'||(d->>'keyword')||'%' OR cr.id::text=d->>'keyword')),paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(customer_request_raw(pg.id) ORDER BY pg.created_at DESC,pg.id),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF a IN ('get','staff.get','cancel','staff.status') THEN
  IF a IN ('cancel','staff.status') THEN SELECT * INTO state_row FROM customer_request_states WHERE request_id=p_id FOR UPDATE;ELSE SELECT * INTO state_row FROM customer_request_states WHERE request_id=p_id; END IF;
  SELECT * INTO doc_row FROM customer_requests WHERE id=p_id;
  IF state_row.request_id IS NULL OR doc_row.id IS NULL OR (a NOT LIKE 'staff.%' AND doc_row.owner_id<>actor) THEN PERFORM stock_error('P0404','记录不存在'); END IF;
  IF a IN ('get','staff.get') THEN RETURN customer_request_raw(p_id); END IF;
  SELECT * INTO event_row FROM customer_request_events WHERE request_id=p_id AND actor_id=actor AND request_key=d->>'requestKey';
  IF FOUND THEN IF event_row.request_hash<>d->>'signature' THEN PERFORM stock_error('P0409','操作标识内容冲突'); END IF;RETURN jsonb_build_object('id',p_id,'status',event_row.to_status,'version',event_row.version); END IF;
  IF state_row.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','记录已更新，请刷新后处理'); END IF;
  transitions:=CASE doc_row.kind WHEN 'appointment' THEN '{"new":["confirmed","cancelled"],"confirmed":["completed","cancelled"]}'::jsonb ELSE '{"new":["contacted","closed","cancelled"],"contacted":["closed","cancelled"]}'::jsonb END;
  undo_v:=d->>'undoOf' IS NOT NULL;
  IF undo_v THEN
   IF a<>'staff.status' OR doc_row.kind<>'consult' OR state_row.status<>'contacted' OR d->>'status' IS DISTINCT FROM 'new'
      OR NOT EXISTS(SELECT 1 FROM customer_request_events e
        WHERE e.request_id=p_id AND e.actor_id=actor AND e.actor_kind='staff' AND e.request_key=d->>'undoOf'
          AND e.version=state_row.version AND e.from_status='new' AND e.to_status='contacted'
          AND e.note='跟进状态变更' AND e.created_at>now()-interval '30 seconds') THEN
    PERFORM stock_error('P0409','这次跟进已不能撤销，请刷新记录');
   END IF;
   d:=jsonb_set(d,'{reason}',to_jsonb('撤销跟进状态变更'::text));
  ELSIF NOT coalesce((transitions->state_row.status) ? (d->>'status'),false) OR (a='cancel' AND d->>'status'<>'cancelled') THEN
   PERFORM stock_error('P0409','当前状态不能执行此操作');
  END IF;
  UPDATE customer_request_states SET status=d->>'status',version=version+1,updated_at=now() WHERE request_id=p_id;
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),p_id,actor,CASE WHEN a='cancel' THEN 'customer' ELSE 'staff' END,state_row.status,d->>'status',state_row.version+1,d->>'reason',d->>'requestKey',d->>'signature');
  IF doc_row.kind='order' AND d->>'status' IN ('closed','cancelled') THEN PERFORM agent_unlock(p_id,CASE WHEN a='cancel' THEN '顾客取消代理订单' ELSE '门店关闭代理订单：'||(d->>'reason') END,actor); END IF;
  PERFORM stock_audit(p_user,p_request_id,CASE WHEN a='cancel' THEN '取消咨询预约' ELSE '跟进咨询预约' END,p_id::text,NULL,jsonb_build_object('status',d->>'status','version',state_row.version+1),d->>'reason');RETURN jsonb_build_object('id',p_id,'status',d->>'status','version',state_row.version+1);
 END IF;
 PERFORM stock_error('P0404','接口尚未迁移');
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','记录已存在或内容冲突');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation OR foreign_key_violation THEN PERFORM stock_error('P0400','提交参数无效');
 WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN PERFORM stock_error('P0409','记录正被其他操作更新，请重试');
END $$;
