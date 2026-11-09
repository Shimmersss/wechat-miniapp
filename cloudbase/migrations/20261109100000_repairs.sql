-- 对应 server/src/repair*.js；事务/金额/权限在服务端，敏感响应字段由云函数白名单裁剪。
REVOKE UPDATE,DELETE,TRUNCATE ON repair_events,repair_files,repair_part_ledger,repair_payments,repair_cost_allocations FROM service_role;
CREATE INDEX repair_orders_queue ON repair_orders(status,engineer_id,created_at DESC);
CREATE INDEX repair_files_file ON repair_files(file_id);
CREATE INDEX repair_payments_order_time ON repair_payments(order_id,created_at);
CREATE INDEX repair_part_ledger_order ON repair_part_ledger(order_id);
CREATE INDEX repair_part_ledger_issue ON repair_part_ledger(issue_id);
CREATE INDEX repair_part_ledger_part_time ON repair_part_ledger(part_id,created_at DESC);
CREATE FUNCTION repair_totals(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('received',coalesce(sum(CASE kind WHEN 'receipt' THEN amount WHEN 'refund' THEN -amount ELSE 0 END),0),'expenses',coalesce(sum(CASE kind WHEN 'expense' THEN amount WHEN 'expense_refund' THEN -amount ELSE 0 END),0),'parts',(SELECT coalesce(sum(CASE kind WHEN 'issue' THEN cost_amount ELSE -cost_amount END),0) FROM repair_part_ledger WHERE order_id=oid)) FROM repair_payments WHERE order_id=oid
$$;
CREATE FUNCTION repair_guard(u jsonb,r repair_orders,writing boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE perms jsonb:=coalesce(u->'permissions','[]');
BEGIN
 IF u->>'staffNo' IS NULL OR NOT perms ?| ARRAY['repair:handle','repair:quote','repair:cash'] THEN PERFORM stock_error('P0403','无权限查看维修'); END IF;
 IF r.id IS NOT NULL AND NOT perms ?| ARRAY['repair:assign','repair:quote','repair:cash'] AND r.engineer_id IS DISTINCT FROM (u->>'id')::uuid THEN PERFORM stock_error('P0404','维修单不存在'); END IF;
 IF writing AND (NOT perms ? 'repair:handle' OR (r.id IS NOT NULL AND NOT perms ? 'repair:assign' AND r.engineer_id IS DISTINCT FROM (u->>'id')::uuid)) THEN PERFORM stock_error('P0403','仅可处理本人获分派工单'); END IF;
END $$;
CREATE FUNCTION repair_engineer(who uuid) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
BEGIN
 IF who IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM staff s JOIN users u ON u.id=s.user_id JOIN roles r ON r.role_key=s.role_key WHERE s.user_id=who AND s.role_key='engineer' AND s.status='active' AND u.status='active' AND r.permissions ? 'repair:handle') THEN PERFORM stock_error('P0400','工程师账号不可用'); END IF;
 RETURN who;
END $$;
CREATE FUNCTION repair_raw(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(o)||jsonb_build_object('totals',repair_totals(o.id),'engineer',(SELECT name FROM staff WHERE user_id=o.engineer_id),'repairAccess',true,
 'events',coalesce((SELECT jsonb_agg(to_jsonb(e)||jsonb_build_object('operator',u.nickname) ORDER BY e.version,e.id) FROM repair_events e JOIN users u ON u.id=e.actor_id WHERE e.order_id=o.id),'[]'),
 'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('purpose',rf.purpose,'field_key','repairPhotos') ORDER BY rf.purpose,rf.position,rf.file_id) FROM repair_files rf JOIN files f ON f.id=rf.file_id WHERE rf.order_id=o.id),'[]'),
 'payments',coalesce((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('operator',u.nickname) ORDER BY p.created_at,p.id) FROM repair_payments p JOIN users u ON u.id=p.actor_id WHERE p.order_id=o.id),'[]'),
 'parts',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('name',p.name,'sku',p.sku,'returned',(SELECT coalesce(sum(rr.quantity),0) FROM repair_part_ledger rr WHERE rr.issue_id=l.id AND rr.kind='return')) ORDER BY l.created_at,l.id) FROM repair_part_ledger l JOIN repair_parts p ON p.id=l.part_id WHERE l.order_id=o.id AND l.kind='issue'),'[]'),
 'allocation',(SELECT to_jsonb(a) FROM repair_cost_allocations a WHERE a.order_id=o.id)) FROM repair_orders o WHERE o.id=oid
$$;
CREATE FUNCTION repair_attach(oid uuid,vals jsonb,u jsonb,purpose_v text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE fid uuid; f files; n int;
BEGIN
 vals:=coalesce(vals,'[]');IF jsonb_typeof(vals)<>'array' OR jsonb_array_length(vals)>9 THEN PERFORM stock_error('P0400','每组附件最多9张'); END IF;
 IF (SELECT count(DISTINCT value->>'fileId') FROM jsonb_array_elements(vals))<>jsonb_array_length(vals) THEN PERFORM stock_error('P0400','附件重复'); END IF;
 PERFORM 1 FROM files WHERE id IN(SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(vals)) ORDER BY id FOR UPDATE;
 FOR fid IN SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(vals) LOOP
  SELECT * INTO f FROM files WHERE id=fid;
  IF NOT FOUND OR f.scope<>'internal' OR f.mime NOT LIKE 'image/%' THEN PERFORM stock_error('P0400','维修附件须单独上传为内部图片'); END IF;
  IF EXISTS(SELECT 1 FROM unit_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM loan_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM sales_files WHERE file_id=fid) THEN PERFORM stock_error('P0400','其他业务凭证不能作为维修附件'); END IF;
  IF NOT file_can_read(fid,u) THEN PERFORM stock_error('P0403','无权引用此附件'); END IF;
  IF purpose_v<>'expense' AND EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid AND purpose='expense') THEN PERFORM stock_error('P0400','费用凭证不能转作普通维修附件'); END IF;
 END LOOP;
 SELECT count(DISTINCT fid_v) INTO n FROM(SELECT file_id fid_v FROM repair_files WHERE order_id=oid AND purpose=purpose_v UNION SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(vals)) x;
 IF n>9 THEN PERFORM stock_error('P0400','每组维修附件最多9张'); END IF;
 INSERT INTO repair_files(order_id,file_id,purpose,position) SELECT oid,(value->>'fileId')::uuid,purpose_v,ordinality-1 FROM jsonb_array_elements(vals) WITH ORDINALITY ON CONFLICT DO NOTHING;
END $$;
CREATE FUNCTION repair_finish(r repair_orders,u jsonb,policy_v text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE unit_v units; t jsonb; added numeric; next_cost numeric;
BEGIN
 IF r.kind<>'inventory' THEN RETURN; END IF;
 SELECT * INTO unit_v FROM units WHERE id=r.unit_id FOR UPDATE;
 IF unit_v.status<>'repairing' THEN PERFORM stock_error('P0409','本店设备维修状态已变化'); END IF;
 IF policy_v NOT IN ('capitalize','separate') OR policy_v IS NULL THEN PERFORM stock_error('P0503','本店维修成本处理尚未配置'); END IF;
 t:=repair_totals(r.id);added:=(t->>'parts')::numeric+(t->>'expenses')::numeric;next_cost:=unit_v.cost+CASE WHEN policy_v='capitalize' THEN added ELSE 0 END;
 PERFORM stock_money(to_jsonb(next_cost));
 INSERT INTO repair_cost_allocations(order_id,unit_id,policy,parts_cost,expenses,total_cost,old_unit_cost,new_unit_cost) VALUES(r.id,r.unit_id,policy_v,(t->>'parts')::numeric,(t->>'expenses')::numeric,added,unit_v.cost,next_cost);
 UPDATE units SET status='recheck',cost=next_cost,share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}' WHERE id=r.unit_id;
 INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(r.unit_id,'repairing','recheck','repair_done',r.id::text,(u->>'id')::uuid,'维修结束，待独立复检');
END $$;
CREATE FUNCTION api_repairs(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text,p_policy text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 d jsonb:=p_data; u jsonb:=p_user; perms jsonb:=coalesce(p_user->'permissions','[]'); actor uuid:=(p_user->>'id')::uuid;
 oid uuid:=p_id; r repair_orders; old repair_orders; unit_v units; part repair_parts; issue repair_part_ledger;
 key_v text; sig text; why text; old_hash text; assigned uuid; model_v text; code_v text; from_v text; next_v text; eid uuid:=gen_random_uuid();
 total jsonb; qty int; amount numeric(14,2); remaining int; remaining_cost numeric; part_id_v uuid; returned_qty int; returned_cost numeric;
 patch jsonb:='{}'; data_v jsonb:='{}'; internal_v jsonb; files_v jsonb; raw_v jsonb; result jsonb; n bigint; started timestamptz; ended timestamptz; all_scope boolean;
BEGIN
 IF u->>'staffNo' IS NULL THEN PERFORM stock_error('P0403','仅员工可访问维修'); END IF;
 all_scope:=perms ?| ARRAY['repair:assign','repair:quote','repair:cash'];
 IF p_action='options' THEN
  IF NOT perms ?| ARRAY['repair:handle','repair:quote','repair:cash','parts:manage'] THEN PERFORM stock_error('P0403','无权限查看维修选项'); END IF;
  RETURN jsonb_build_object('engineers',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.user_id,'name',s.name) ORDER BY s.name,s.id) FROM staff s JOIN users usr ON usr.id=s.user_id JOIN roles roles_v ON roles_v.role_key=s.role_key WHERE s.role_key='engineer' AND s.status='active' AND usr.status='active' AND roles_v.permissions ? 'repair:handle' AND (perms ? 'repair:assign' OR s.user_id=actor)),'[]'),'canManageParts',perms ? 'parts:manage' AND stock_can(u,'cost'),'passwordStorage',false,'internalCostPolicy',p_policy);
 END IF;
 IF p_action IN ('list','board','stats') THEN
  IF p_action='stats' AND NOT perms ?| ARRAY['repair:handle','repair:quote','repair:cash'] THEN
   IF NOT perms ? 'stats:view' THEN PERFORM stock_error('P0403','无权限查看维修统计'); END IF;all_scope:=true;
  ELSE PERFORM repair_guard(u,NULL); END IF;
  IF p_action='stats' THEN
   started:=(d->>'start')::timestamptz;ended:=(d->>'end')::timestamptz;
   WITH scoped AS(SELECT ro.* FROM repair_orders ro WHERE (all_scope OR ro.engineer_id=actor) AND (nullif(d->>'engineerId','') IS NULL OR ro.engineer_id=(d->>'engineerId')::uuid))
   SELECT jsonb_build_object('created',count(*) FILTER(WHERE created_at>=started AND created_at<ended),'cohort_completed',count(*) FILTER(WHERE created_at>=started AND created_at<ended AND status='completed'),'completed',count(*) FILTER(WHERE completed_at>=started AND completed_at<ended),'avg_hours',coalesce(avg(extract(epoch FROM(completed_at-created_at))/3600) FILTER(WHERE completed_at>=started AND completed_at<ended),0),
   'revenue',(SELECT coalesce(sum(CASE pay.kind WHEN 'receipt' THEN pay.amount WHEN 'refund' THEN -pay.amount ELSE 0 END),0) FROM repair_payments pay JOIN scoped sc ON sc.id=pay.order_id WHERE sc.kind='external' AND pay.created_at>=started AND pay.created_at<ended),
   'expenses',(SELECT coalesce(sum(CASE pay.kind WHEN 'expense' THEN pay.amount WHEN 'expense_refund' THEN -pay.amount ELSE 0 END),0) FROM repair_payments pay JOIN scoped sc ON sc.id=pay.order_id WHERE sc.kind='external' AND pay.created_at>=started AND pay.created_at<ended),
   'parts',(SELECT coalesce(sum(CASE pl.kind WHEN 'issue' THEN pl.cost_amount ELSE -pl.cost_amount END),0) FROM repair_part_ledger pl JOIN scoped sc ON sc.id=pl.order_id WHERE sc.kind='external' AND pl.created_at>=started AND pl.created_at<ended),
   'internal_cost',(SELECT coalesce(sum(a.total_cost),0) FROM repair_cost_allocations a JOIN scoped sc ON sc.id=a.order_id WHERE a.created_at>=started AND a.created_at<ended)) INTO result FROM scoped; RETURN result;
  END IF;
  WITH matches AS(SELECT ro.* FROM repair_orders ro WHERE (all_scope OR ro.engineer_id=actor)
   AND (nullif(d->>'engineerId','') IS NULL OR ro.engineer_id=(d->>'engineerId')::uuid) AND (nullif(d->>'status','') IS NULL OR ro.status=d->>'status')
   AND (d->>'waitingParts' IS DISTINCT FROM 'true' OR ro.waiting_parts) AND (d->>'overdue' IS DISTINCT FROM 'true' OR (ro.status NOT IN ('completed','cancelled') AND ro.expected_date<(now() AT TIME ZONE 'Asia/Shanghai')::date))
   AND (nullif(d->>'keyword','') IS NULL OR ro.no ILIKE '%'||(d->>'keyword')||'%' OR ro.model ILIKE '%'||(d->>'keyword')||'%' OR ro.customer ILIKE '%'||(d->>'keyword')||'%' OR ro.identifier=d->>'keyword')),
  paged AS(SELECT * FROM matches ORDER BY CASE WHEN p_action='board' THEN status IN ('completed','cancelled') ELSE false END,created_at DESC,CASE WHEN p_action='board' THEN id END DESC,CASE WHEN p_action='list' THEN id END LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(repair_raw(pg.id) ORDER BY CASE WHEN p_action='board' THEN pg.status IN ('completed','cancelled') ELSE false END,pg.created_at DESC,CASE WHEN p_action='board' THEN pg.id END DESC,CASE WHEN p_action='list' THEN pg.id END),'[]')) INTO result FROM paged pg;RETURN result;
 END IF;
 IF p_action LIKE 'parts.%' THEN
  IF NOT perms ?| ARRAY['repair:handle','repair:cash','parts:manage'] THEN PERFORM stock_error('P0403','无权限查看配件'); END IF;
  IF p_action IN ('parts.create','parts.receive') AND (NOT perms ? 'parts:manage' OR NOT stock_can(u,'cost')) THEN PERFORM stock_error('P0403','无权登记配件成本'); END IF;
  IF p_action='parts.list' THEN
   WITH matches AS(SELECT * FROM repair_parts WHERE nullif(d->>'keyword','') IS NULL OR name ILIKE '%'||(d->>'keyword')||'%' OR sku ILIKE '%'||(d->>'keyword')||'%'), paged AS(SELECT * FROM matches ORDER BY name,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int)
   SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(to_jsonb(pg) ORDER BY name,id),'[]')) INTO result FROM paged pg;RETURN result;
  ELSIF p_action='parts.create' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('part-sku:'||lower(d->>'sku'),0));SELECT * INTO part FROM repair_parts WHERE lower(sku)=lower(d->>'sku');
   IF FOUND THEN IF part.name<>d->>'name' OR part.unit<>d->>'unit' THEN PERFORM stock_error('P0409','配件SKU已存在'); END IF;RETURN to_jsonb(part); END IF;
   INSERT INTO repair_parts(id,sku,name,unit) VALUES(gen_random_uuid(),d->>'sku',d->>'name',d->>'unit') RETURNING * INTO part;PERFORM stock_audit(u,p_request_id,'新增维修配件',part.id::text,NULL,jsonb_build_object('sku',part.sku,'name',part.name,'unit',part.unit));RETURN to_jsonb(part);
  ELSIF p_action='parts.ledger' THEN
   SELECT jsonb_build_object('total',(SELECT count(*) FROM repair_part_ledger WHERE part_id=p_id),'rows',coalesce(jsonb_agg(to_jsonb(pg)||jsonb_build_object('operator',usr.nickname,'engineer_id',ro.engineer_id) ORDER BY pg.created_at DESC,pg.id),'[]')) INTO result FROM(SELECT * FROM repair_part_ledger WHERE part_id=p_id ORDER BY created_at DESC,id LIMIT(d->>'pageSize')::int OFFSET(d->>'offset')::int) pg JOIN users usr ON usr.id=pg.actor_id LEFT JOIN repair_orders ro ON ro.id=pg.order_id;RETURN result;
  ELSE
   SELECT * INTO part FROM repair_parts WHERE id=p_id FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','配件不存在'); END IF;
   SELECT request_hash INTO old_hash FROM repair_part_ledger WHERE actor_id=actor AND request_key=d->>'requestKey';
   IF FOUND THEN IF old_hash<>d->>'signature' THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF;RETURN to_jsonb(part); END IF;
   IF NOT part.active OR part.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','配件或版本已变化'); END IF;
   qty:=(d->>'quantity')::int;amount:=stock_money(d->'unitCost')*qty;PERFORM stock_money(to_jsonb(amount));PERFORM stock_money(to_jsonb(part.stock_value+amount));IF part.quantity+qty>1000000 THEN PERFORM stock_error('P0400','库存数量超出范围'); END IF;
   UPDATE repair_parts SET quantity=quantity+qty,stock_value=stock_value+amount,version=version+1 WHERE id=p_id RETURNING * INTO part;
   INSERT INTO repair_part_ledger(id,part_id,kind,quantity,cost_amount,actor_id,reason,request_key,request_hash) VALUES(eid,p_id,'receive',qty,amount,actor,d->>'reason',d->>'requestKey',d->>'signature');PERFORM stock_audit(u,p_request_id,'维修配件入库',p_id::text,NULL,jsonb_build_object('quantity',qty,'cost',amount),d->>'reason');RETURN to_jsonb(part);
  END IF;
 END IF;
 IF p_action='get' THEN SELECT * INTO r FROM repair_orders WHERE id=oid;IF NOT FOUND THEN PERFORM stock_error('P0404','维修单不存在'); END IF;PERFORM repair_guard(u,r);RETURN repair_raw(oid); END IF;
 key_v:=stock_text(d->'requestKey','提交标识',100);sig:=d->>'signature';why:=coalesce(d->>'reason','创建维修单');IF sig IS NULL OR sig !~ '^[a-f0-9]{64}$' THEN PERFORM stock_error('P0400','请求摘要无效'); END IF;
 -- 凭证总按编号先锁；再锁维修单和设备/配件，避免跨业务反向认领。
 files_v:=CASE WHEN p_action IN ('create','update') THEN d->'photos' WHEN p_action='payment' THEN d->'proof' WHEN p_action='transition' THEN d->'pickupProof' ELSE '[]' END;
 PERFORM 1 FROM files WHERE id IN(SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(coalesce(files_v,'[]'))) ORDER BY id FOR UPDATE;
 IF p_action='create' THEN
  PERFORM repair_guard(u,NULL,true);PERFORM pg_advisory_xact_lock(hashtextextended('repair:'||actor::text||':'||key_v,0));
  SELECT * INTO r FROM repair_orders WHERE creator_id=actor AND request_key=key_v;IF FOUND THEN IF r.request_hash<>sig THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF;PERFORM repair_guard(u,r);RETURN repair_raw(r.id); END IF;
  IF perms ? 'repair:assign' THEN assigned:=repair_engineer(nullif(d->>'engineerId','')::uuid);ELSE assigned:=repair_engineer(actor);IF nullif(d->>'engineerId','') IS NOT NULL AND d->>'engineerId'<>actor::text THEN PERFORM stock_error('P0403','不能指派其他工程师'); END IF; END IF;
  IF d->>'kind'='inventory' THEN
   IF NOT perms ? 'inventory:view' THEN PERFORM stock_error('P0403','无权限查看库存'); END IF;
   SELECT * INTO unit_v FROM units WHERE id=(d->>'unitId')::uuid FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
   IF unit_v.status<>'in_stock' OR unit_v.ownership<>'own' THEN PERFORM stock_error('P0409','只有本店自有可售设备能从库存发起送修'); END IF;
   SELECT name INTO model_v FROM models WHERE id=unit_v.model_id;code_v:=unit_v.imei1;
  ELSE
   model_v:=d->>'model';code_v:=d->>'identifier';
   IF nullif(code_v,'') IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('imei:'||code_v,0));
    PERFORM 1 FROM unit_identifiers ident JOIN units unit_row ON unit_row.id=ident.unit_id WHERE ident.imei=code_v AND unit_row.status NOT IN ('sold','returned') FOR SHARE OF unit_row;
    IF FOUND THEN PERFORM stock_error('P0409','该串码属于门店业务库存，请从库存档案发起'); END IF;
   END IF;
  END IF;
  oid:=gen_random_uuid();
  INSERT INTO repair_orders(id,no,kind,unit_id,model,identifier,customer,phone,fault,engineer_id,expected_date,request_key,request_hash,creator_id) VALUES(oid,'RO'||replace(oid::text,'-',''),d->>'kind',unit_v.id,model_v,coalesce(code_v,''),CASE WHEN d->>'kind'='external' THEN d->>'customer' ELSE '' END,CASE WHEN d->>'kind'='external' THEN d->>'phone' ELSE '' END,d->>'fault',assigned,nullif(d->>'expectedAt','')::date,key_v,sig,actor) RETURNING * INTO r;
  IF r.kind='external' AND r.identifier<>'' THEN INSERT INTO repair_external_slots(identifier,order_id) VALUES(r.identifier,oid); END IF;
  PERFORM repair_attach(oid,d->'photos',u,'appearance');
  IF r.unit_id IS NOT NULL THEN
   UPDATE units SET status='repairing',share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}' WHERE id=r.unit_id;
   INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(r.unit_id,'in_stock','repairing','repair_order',oid::text,actor,'本店设备送修');
  END IF;
  from_v:=r.status;data_v:=jsonb_build_object('kind',r.kind,'unitId',r.unit_id);
  PERFORM stock_audit(u,p_request_id,'创建维修单',oid::text,NULL,jsonb_build_object('kind',r.kind,'unitId',r.unit_id,'engineerId',assigned));
 ELSE
  SELECT * INTO r FROM repair_orders WHERE id=oid FOR UPDATE;IF NOT FOUND THEN PERFORM stock_error('P0404','维修单不存在'); END IF;PERFORM repair_guard(u,r,p_action NOT IN ('quote','payment'));
  IF p_action='quote' AND NOT perms ? 'repair:quote' THEN PERFORM stock_error('P0403','无权限报价'); END IF;
  IF p_action='payment' AND NOT perms ? 'repair:cash' THEN PERFORM stock_error('P0403','无权限登记收支'); END IF;
  SELECT request_hash INTO old_hash FROM repair_events WHERE order_id=oid AND request_key=key_v;IF FOUND THEN IF old_hash<>sig THEN PERFORM stock_error('P0409','操作标识内容冲突'); END IF;RETURN repair_raw(oid); END IF;
  IF r.version<>(d->>'version')::int THEN PERFORM stock_error('P0409','维修单已更新，请刷新核对'); END IF;
  from_v:=r.status;total:=repair_totals(oid);
  CASE p_action
  WHEN 'update' THEN
   IF r.status IN ('completed','cancelled') THEN PERFORM stock_error('P0409','已结束维修不能编辑'); END IF;
   IF d ? 'fault' THEN r.fault:=d->>'fault';patch:=patch||jsonb_build_object('fault',r.fault); END IF;
   IF d ? 'diagnosis' THEN r.diagnosis:=d->>'diagnosis';patch:=patch||jsonb_build_object('diagnosis',r.diagnosis); END IF;
   IF d ? 'customer' OR d ? 'phone' THEN
    IF NOT perms ? 'repair:assign' THEN PERFORM stock_error('P0403','无权限修改联系方式'); END IF;IF r.kind<>'external' THEN PERFORM stock_error('P0400','本店维修不登记顾客联系资料'); END IF;
    IF d ? 'customer' THEN r.customer:=d->>'customer';patch:=patch||jsonb_build_object('customer',r.customer); END IF;IF d ? 'phone' THEN r.phone:=d->>'phone';patch:=patch||jsonb_build_object('phone',r.phone); END IF;
   END IF;
   IF d ? 'engineerId' THEN IF NOT perms ? 'repair:assign' THEN PERFORM stock_error('P0403','无权限指派工程师'); END IF;r.engineer_id:=repair_engineer(nullif(d->>'engineerId','')::uuid);patch:=patch||jsonb_build_object('engineer_id',r.engineer_id); END IF;
   IF d ? 'expectedAt' THEN r.expected_date:=nullif(d->>'expectedAt','')::date;patch:=patch||jsonb_build_object('expected_date',r.expected_date); END IF;
   IF d ? 'waitingParts' THEN r.waiting_parts:=(d->>'waitingParts')::boolean;patch:=patch||jsonb_build_object('waiting_parts',r.waiting_parts); END IF;
   PERFORM repair_attach(oid,d->'photos',u,'appearance');IF patch='{}' AND jsonb_array_length(coalesce(d->'photos','[]'))=0 THEN PERFORM stock_error('P0400','没有需保存的改动'); END IF;
   data_v:=patch||jsonb_build_object('addedPhotos',coalesce((SELECT jsonb_agg(value->'fileId') FROM jsonb_array_elements(d->'photos')),'[]'));
  WHEN 'quote' THEN
   IF r.status NOT IN ('checking','pending_confirm') THEN PERFORM stock_error('P0409','当前节点不能报价'); END IF;amount:=stock_money(d->'amount');IF amount<(total->>'received')::numeric THEN PERFORM stock_error('P0400','新报价低于已收净额，请先办理退款'); END IF;
   r.quote:=amount;r.quote_version:=r.quote_version+1;r.confirmed_version:=NULL;data_v:=jsonb_build_object('quote',amount,'quoteVersion',r.quote_version);
  WHEN 'confirm' THEN
   IF r.kind='inventory' AND NOT perms ? 'repair:assign' THEN PERFORM stock_error('P0403','本店维修方案须管理授权确认'); END IF;
   IF r.status<>'pending_confirm' OR r.quote IS NULL OR d->'quoteVersion' IS DISTINCT FROM to_jsonb(r.quote_version) OR d->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0409','请核对当前报价版本并记录已获确认'); END IF;r.confirmed_version:=r.quote_version;data_v:=jsonb_build_object('quoteVersion',r.quote_version,'confirmed',true);
  WHEN 'issue','return_parts' THEN
   qty:=(d->>'quantity')::int;
   IF (p_action='issue' AND r.status<>'repairing') OR (p_action='return_parts' AND r.status NOT IN ('repairing','pending_pickup')) THEN PERFORM stock_error('P0409','当前节点不能领退料'); END IF;
   IF p_action='return_parts' THEN SELECT * INTO issue FROM repair_part_ledger WHERE id=(d->>'issueId')::uuid AND order_id=oid AND kind='issue';IF NOT FOUND THEN PERFORM stock_error('P0404','领用记录不存在'); END IF;part_id_v:=issue.part_id;ELSE part_id_v:=(d->>'partId')::uuid; END IF;
   SELECT * INTO part FROM repair_parts WHERE id=part_id_v FOR UPDATE;IF NOT FOUND OR NOT part.active THEN PERFORM stock_error('P0404','配件不存在'); END IF;
   IF p_action='issue' THEN
    IF qty>part.quantity THEN PERFORM stock_error('P0409','配件库存不足'); END IF;amount:=CASE WHEN qty=part.quantity THEN part.stock_value ELSE floor((part.stock_value*100*qty+floor(part.quantity/2.0))/part.quantity)/100 END;
    UPDATE repair_parts SET quantity=quantity-qty,stock_value=stock_value-amount,version=version+1 WHERE id=part_id_v;
   ELSE
    SELECT coalesce(sum(quantity),0),coalesce(sum(cost_amount),0) INTO returned_qty,returned_cost FROM repair_part_ledger WHERE issue_id=issue.id AND kind='return';remaining:=issue.quantity-returned_qty;remaining_cost:=issue.cost_amount-returned_cost;
    IF qty>remaining THEN PERFORM stock_error('P0400','退料超过原领用数量'); END IF;amount:=floor((remaining_cost*100*qty+floor(remaining/2.0))/remaining)/100;
    IF part.quantity+qty>1000000 THEN PERFORM stock_error('P0400','库存数量超出范围'); END IF;PERFORM stock_money(to_jsonb(part.stock_value+amount));
    UPDATE repair_parts SET quantity=quantity+qty,stock_value=stock_value+amount,version=version+1 WHERE id=part_id_v;
   END IF;
   INSERT INTO repair_part_ledger(id,part_id,order_id,issue_id,kind,quantity,cost_amount,actor_id,reason,request_key,request_hash) VALUES(eid,part_id_v,oid,issue.id,CASE WHEN p_action='issue' THEN 'issue' ELSE 'return' END,qty,amount,actor,why,key_v,encode(sha256(convert_to(jsonb_build_object('order',oid,'data',d)::text,'UTF8')),'hex'));
   data_v:=jsonb_build_object('partId',part_id_v,'issueId',CASE WHEN p_action='issue' THEN eid ELSE issue.id END,'quantity',qty);internal_v:=jsonb_build_object('cost',amount);
  WHEN 'payment' THEN
   IF d->>'kind' NOT IN ('receipt','refund','expense','expense_refund') OR d->'confirmed' IS DISTINCT FROM 'true'::jsonb OR d->>'method' NOT IN ('微信','支付宝','现金','银行卡','其他') THEN PERFORM stock_error('P0400','请选择收支类型/方式并确认已实际办理'); END IF;
   amount:=stock_money(d->'amount');IF amount=0 THEN PERFORM stock_error('P0400','金额须大于零'); END IF;
   IF d->>'kind' LIKE '%refund%' AND NOT perms ? 'sales:refund' THEN PERFORM stock_error('P0403','无退款权限'); END IF;
   IF d->>'kind' LIKE 'expense%' THEN
    IF NOT stock_can(u,'cost') THEN PERFORM stock_error('P0403','无权登记维修成本'); END IF;IF r.kind='inventory' AND r.status IN ('completed','cancelled') THEN PERFORM stock_error('P0409','本店维修成本已归档，不能重复调整'); END IF;
    IF d->>'kind'='expense_refund' AND amount>(total->>'expenses')::numeric THEN PERFORM stock_error('P0400','超过可退维修费用'); END IF;
   ELSE
    IF r.kind<>'external' THEN PERFORM stock_error('P0400','本店维修不登记对客收退款'); END IF;
    IF d->>'kind'='receipt' AND (r.status='cancelled' OR r.quote IS NULL OR (total->>'received')::numeric+amount>r.quote) THEN PERFORM stock_error('P0400','未报价或收款超过报价'); END IF;
    IF d->>'kind'='refund' AND amount>(total->>'received')::numeric THEN PERFORM stock_error('P0400','退款超过已收净额'); END IF;
   END IF;
   PERFORM repair_attach(oid,d->'proof',u,CASE WHEN d->>'kind' LIKE 'expense%' THEN 'expense' ELSE 'payment' END);
   INSERT INTO repair_payments(id,order_id,kind,amount,method,actor_id,reason) VALUES(eid,oid,d->>'kind',amount,d->>'method',actor,why);
   data_v:=jsonb_build_object('kind',d->>'kind');IF d->>'kind' LIKE 'expense%' THEN internal_v:=jsonb_build_object('amount',amount);ELSE data_v:=data_v||jsonb_build_object('amount',amount); END IF;
  WHEN 'transition' THEN
   next_v:=d->>'to';
   IF NOT coalesce((CASE r.status WHEN 'pending_check' THEN '["checking","cancelled"]' WHEN 'checking' THEN '["pending_confirm","cancelled"]' WHEN 'pending_confirm' THEN '["repairing","checking","cancelled"]' WHEN 'repairing' THEN '["pending_pickup"]' WHEN 'pending_pickup' THEN '["completed"]' ELSE '[]' END)::jsonb ? next_v,false) THEN PERFORM stock_error('P0409','不允许跨节点推进'); END IF;
   data_v:=jsonb_build_object('to',next_v);
   IF next_v='pending_confirm' AND (r.diagnosis='' OR r.quote IS NULL) THEN PERFORM stock_error('P0400','请先保存检测结果并由有权限人员报价'); END IF;
   IF next_v='repairing' AND (r.quote IS NULL OR r.confirmed_version IS DISTINCT FROM r.quote_version) THEN PERFORM stock_error('P0409','当前报价尚未确认'); END IF;
   IF r.status='pending_confirm' AND next_v='checking' THEN r.confirmed_version:=NULL; END IF;
   IF next_v='pending_pickup' THEN IF r.waiting_parts THEN PERFORM stock_error('P0400','仍在等待配件'); END IF;data_v:=data_v||jsonb_build_object('result',stock_text(d->'result','维修结果',2000)); END IF;
   IF next_v='cancelled' THEN IF (total->>'received')::numeric<>0 THEN PERFORM stock_error('P0409','请先退清已收款'); END IF;IF (total->>'parts')::numeric<>0 THEN PERFORM stock_error('P0409','请先核对领用配件'); END IF;PERFORM repair_finish(r,u,p_policy); END IF;
   IF next_v='completed' THEN
    r.pickup_name:=stock_text(d->'pickupName','取机/交接人',100);IF jsonb_array_length(coalesce(d->'pickupProof','[]'))=0 THEN PERFORM stock_error('P0400','请上传取机/交接凭证'); END IF;
    IF r.kind='external' AND (r.quote IS NULL OR (total->>'received')::numeric<>r.quote) THEN PERFORM stock_error('P0409','请先结清当前维修报价'); END IF;
    r.warranty_days:=(d->>'warrantyDays')::int;r.completed_at:=now();PERFORM repair_attach(oid,d->'pickupProof',u,'pickup');PERFORM repair_finish(r,u,p_policy);data_v:=data_v||jsonb_build_object('pickupName',r.pickup_name,'warrantyDays',r.warranty_days);
   END IF;
   IF next_v IN ('completed','cancelled') AND r.kind='external' AND r.identifier<>'' THEN DELETE FROM repair_external_slots WHERE order_id=oid; END IF;r.status:=next_v;
  ELSE PERFORM stock_error('P0400','维修操作无效');END CASE;
  r.version:=r.version+1;
  UPDATE repair_orders SET customer=r.customer,phone=r.phone,fault=r.fault,engineer_id=r.engineer_id,expected_date=r.expected_date,status=r.status,version=r.version,diagnosis=r.diagnosis,waiting_parts=r.waiting_parts,quote=r.quote,quote_version=r.quote_version,confirmed_version=r.confirmed_version,warranty_days=r.warranty_days,pickup_name=r.pickup_name,completed_at=r.completed_at,updated_at=now() WHERE id=oid;
  PERFORM stock_audit(u,p_request_id,'维修处理:'||p_action,oid::text,NULL,jsonb_build_object('status',r.status,'version',r.version),why);
 END IF;
 INSERT INTO repair_events(id,order_id,actor_id,action,from_status,to_status,version,note,public_data,internal_data,request_key,request_hash) VALUES(gen_random_uuid(),oid,actor,p_action,from_v,r.status,r.version,why,data_v,internal_v,key_v,sig);
 PERFORM repair_guard(u,r);RETURN repair_raw(oid);
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','维修单、设备串码或提交标识已被占用');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation OR datetime_field_overflow THEN PERFORM stock_error('P0400','维修参数或金额超出范围');
END $$;
REVOKE ALL ON FUNCTION repair_totals(uuid),repair_guard(jsonb,repair_orders,boolean),repair_engineer(uuid),repair_raw(uuid),repair_attach(uuid,jsonb,jsonb,text),repair_finish(repair_orders,jsonb,text),api_repairs(text,uuid,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION repair_totals(uuid),repair_guard(jsonb,repair_orders,boolean),repair_engineer(uuid),repair_raw(uuid),repair_attach(uuid,jsonb,jsonb,text),repair_finish(repair_orders,jsonb,text),api_repairs(text,uuid,jsonb,jsonb,text,text) TO service_role;
