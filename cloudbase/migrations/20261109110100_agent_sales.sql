-- 代理收银扩展原库存销售函数；非代理行为与原逻辑保持一致。
CREATE FUNCTION agent_sale_order(rid uuid,uid uuid,lock_v boolean) RETURNS agent_orders LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE a agent_orders; s agent_order_states;
BEGIN
 IF rid IS NULL THEN PERFORM stock_error('P0400','代理订单与设备不符'); END IF;
 IF lock_v THEN SELECT * INTO s FROM agent_order_states WHERE request_id=rid FOR UPDATE;ELSE SELECT * INTO s FROM agent_order_states WHERE request_id=rid; END IF;
 SELECT * INTO a FROM agent_orders WHERE request_id=rid;
 IF a.request_id IS NULL OR a.unit_id IS DISTINCT FROM uid THEN PERFORM stock_error('P0400','代理订单与设备不符'); END IF;
 IF s.status<>'locked' THEN PERFORM stock_error('P0409','代理订单锁定已释放，不能按代理价成交'); END IF;
 IF a.lock_expires_at<=now() THEN PERFORM stock_error('P0409','代理订单锁定已到期，请让顾客重新下单'); END IF;
 RETURN a;
END $$;
CREATE OR REPLACE FUNCTION stock_sale(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE unit_v units; x jsonb; plan jsonb:='[]'; total numeric:=0; costs numeric:=0; price_v numeric; base_v numeric; uid uuid; oid uuid:=gen_random_uuid(); old sales_orders; key_v text; digest text:=md5(d::text); why text:=''; changed boolean:=false; fid uuid; files_v jsonb; result_v jsonb; referral customer_requests; request_state customer_request_states; agent_order_v agent_orders; request_v uuid:=nullif(d->>'customerRequestId','')::uuid; earning_v uuid;
BEGIN

 IF action='sales.lookup' THEN
  SELECT * INTO unit_v FROM units WHERE id::text=d->>'code' OR imei1=d->>'code' OR imei2=d->>'code' LIMIT 1;
  IF NOT FOUND THEN PERFORM stock_error('P0404','未找到设备'); END IF; IF unit_v.status='locked' AND request_v IS NOT NULL THEN PERFORM agent_sale_order(request_v,unit_v.id,false);ELSIF unit_v.status<>'in_stock' OR unit_v.ownership<>'own' THEN PERFORM stock_error('P0409','设备不可售'); END IF; RETURN stock_raw(unit_v.id);
 END IF;
 IF action='sales.create' THEN
  key_v:=stock_text(d->'requestKey','提交标识',80); PERFORM pg_advisory_xact_lock(hashtextextended('sale:'||key_v,0));
  SELECT * INTO old FROM sales_orders WHERE request_key=key_v; IF FOUND THEN IF old.request_hash<>digest THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF; RETURN stock_sale_raw(old.id); END IF;
  files_v:=stock_files(d->'receipts','internal',u,true);
  FOR x IN SELECT value FROM jsonb_array_elements(files_v) LOOP
   fid:=(x->>'fileId')::uuid;
   IF EXISTS(SELECT 1 FROM unit_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM shipments WHERE receipt_file_id=fid) OR EXISTS(SELECT 1 FROM acceptance_items WHERE attributes->'_receiptImages' @> jsonb_build_array(jsonb_build_object('fileId',fid))) THEN PERFORM stock_error('P0400','其他业务凭证不能用作收款凭证'); END IF;
   IF EXISTS(SELECT 1 FROM files WHERE id=fid AND owner_id<>(u->>'id')::uuid) AND u->>'role' NOT IN ('boss','manager') THEN PERFORM stock_error('P0403','无权引用他人的收款凭证'); END IF;
  END LOOP;
 END IF;
 IF request_v IS NOT NULL AND action='sales.create' THEN
  IF NOT u->'permissions' ? 'consult:manage' THEN PERFORM stock_error('P0403','仅员工可跟进顾客资料'); END IF;
  SELECT * INTO request_state FROM customer_request_states WHERE request_id=request_v FOR UPDATE;
  SELECT * INTO referral FROM customer_requests WHERE id=request_v;
  IF NOT FOUND THEN PERFORM stock_error('P0404','咨询预约不存在'); END IF;
  IF referral.kind<>'order' THEN PERFORM stock_error('P0503','普通咨询预约归因尚未迁移'); END IF;
  IF request_state.status NOT IN ('new','contacted','confirmed') THEN PERFORM stock_error('P0409','咨询预约已结束或取消'); END IF;
  IF EXISTS(SELECT 1 FROM sales_attributions WHERE customer_request_id=request_v) THEN PERFORM stock_error('P0409','此意向已关联成交'); END IF;
  PERFORM agent_sale_order(request_v,referral.unit_id,true);
 END IF;
 -- 固定设备ID顺序加锁，避免多台交叉销售死锁。
 FOR x IN SELECT value FROM jsonb_array_elements(d->'items') ORDER BY value->>'unitId' LOOP
  uid:=(x->>'unitId')::uuid;
  IF action='sales.create' THEN SELECT * INTO unit_v FROM units WHERE id=uid FOR UPDATE; ELSE SELECT * INTO unit_v FROM units WHERE id=uid FOR SHARE; END IF;
  IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
  agent_order_v:=NULL;IF x->>'channel'='agent' THEN agent_order_v:=agent_sale_order(request_v,uid,action='sales.create');IF x ? 'price' THEN PERFORM stock_error('P0400','代理订单按分享价成交，不能改价'); END IF; END IF;
  IF unit_v.ownership<>'own' OR unit_v.status<>(CASE WHEN agent_order_v.request_id IS NOT NULL THEN 'locked' ELSE 'in_stock' END) THEN PERFORM stock_error('P0409','设备不可售，请刷新库存'); END IF;
  IF x->'priceVersion' IS DISTINCT FROM to_jsonb(unit_v.price_version) THEN PERFORM stock_error('P0409','设备价格已变化，请重新核对'); END IF;
  IF x->>'channel'='wholesale' AND NOT stock_can(u,'wholesalePrice') THEN PERFORM stock_error('P0403','无权限使用批发价格'); END IF;
  base_v:=CASE WHEN agent_order_v.request_id IS NOT NULL THEN agent_order_v.share_price WHEN x->>'channel'='wholesale' THEN unit_v.wholesale ELSE unit_v.retail END; price_v:=CASE WHEN x ? 'price' THEN stock_money(x->'price') ELSE base_v END;
  IF price_v<>base_v THEN changed:=true; IF NOT u->'permissions' ? 'price:edit' THEN PERFORM stock_error('P0403','无权限执行该操作'); END IF; END IF;
  total:=total+price_v; costs:=costs+unit_v.cost;
  plan:=plan||jsonb_build_array(jsonb_build_object('unitId',uid,'price',price_v,'basePrice',base_v,'priceVersion',unit_v.price_version,'channel',coalesce(x->>'channel','retail')));
 END LOOP;
 IF total>999999999999.99 OR costs>999999999999.99 THEN PERFORM stock_error('P0400','金额合计超出允许范围'); END IF;
 IF action='sales.quote' THEN RETURN jsonb_build_object('total',total,'items',plan); END IF;
 IF request_v IS NOT NULL AND NOT plan @> jsonb_build_array(jsonb_build_object('unitId',referral.unit_id)) THEN PERFORM stock_error('P0400','销售单需包含意向设备'); END IF;
 IF changed THEN why:=stock_text(d->'priceReason','成交改价原因',500); END IF;
 INSERT INTO sales_orders(id,no,seller_id,pay_method,customer,phone,remark,amount,cost_total,request_key,request_hash) VALUES(oid,'SO'||replace(oid::text,'-',''),(u->>'id')::uuid,d->>'payMethod',stock_text(d->'customer','顾客',100,true),stock_text(d->'phone','电话',30,true),stock_text(d->'remark','备注',1000,true),total,costs,key_v,digest);
 FOR x IN SELECT value FROM jsonb_array_elements(plan) LOOP
  SELECT * INTO unit_v FROM units WHERE id=(x->>'unitId')::uuid;
  INSERT INTO sales_items(id,order_id,unit_id,model_id,name,spec,store,price,cost,price_version,channel) VALUES(gen_random_uuid(),oid,unit_v.id,unit_v.model_id,(SELECT name FROM models WHERE id=unit_v.model_id),concat_ws(' / ',nullif(unit_v.attributes->>'version',''),nullif(unit_v.attributes->>'storage',''),nullif(unit_v.attributes->>'color',''),nullif(unit_v.attributes->>'grade','')),coalesce(unit_v.attributes->>'store',''),(x->>'price')::numeric,unit_v.cost,unit_v.price_version,x->>'channel');
  UPDATE units SET status='sold',share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}' WHERE id=unit_v.id;
  INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(unit_v.id,unit_v.status,'sold','sales_order',oid::text,(u->>'id')::uuid,coalesce(nullif(why,''),'实际收款确认'));
 END LOOP;
 INSERT INTO sales_files(order_id,file_id,added_by) SELECT oid,(value->>'fileId')::uuid,(u->>'id')::uuid FROM jsonb_array_elements(files_v);
 IF request_v IS NOT NULL THEN
  agent_order_v:=agent_sale_order(request_v,referral.unit_id,true);
  DELETE FROM agent_unit_locks WHERE unit_id=agent_order_v.unit_id AND request_id=request_v;
  UPDATE agent_order_states SET status='sold',sale_order_id=oid,updated_at=now() WHERE request_id=request_v;
  earning_v:=gen_random_uuid();INSERT INTO agent_earnings(id,agent_id,request_id,sale_order_id,kind,amount) VALUES(earning_v,agent_order_v.agent_id,request_v,oid,'earning',agent_order_v.markup);INSERT INTO agent_earning_states(earning_id) VALUES(earning_v);
  INSERT INTO sales_attributions(order_id,customer_request_id,customer_id,source,share_id,share_owner_id) VALUES(oid,referral.id,referral.owner_id,referral.source,referral.share_id,referral.share_owner_id);
  UPDATE customer_request_states SET status='closed',version=version+1,updated_at=now() WHERE request_id=request_v;
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),request_v,(u->>'id')::uuid,'staff',request_state.status,'closed',request_state.version+1,'已登记销售单 '||oid::text,'sale_'||oid::text,encode(sha256(convert_to('sale_'||oid::text,'UTF8')),'hex'));
  PERFORM stock_audit(u,req,'代理订单成交记收益',request_v::text,NULL,jsonb_build_object('saleOrderId',oid,'markup',agent_order_v.markup,'agentId',agent_order_v.agent_id));
 END IF;
 PERFORM stock_audit(u,req,'销售收款出库',oid::text,NULL,jsonb_build_object('unitIds',(SELECT jsonb_agg(value->'unitId') FROM jsonb_array_elements(plan)),'amount',total,'payMethod',d->'payMethod'),why);
 RETURN stock_sale_raw(oid);
END $$;

REVOKE ALL ON FUNCTION agent_sale_order(uuid,uuid,boolean),stock_sale(text,jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION agent_sale_order(uuid,uuid,boolean),stock_sale(text,jsonb,jsonb,jsonb,text) TO service_role;
CREATE FUNCTION agent_shop_unit(p_id uuid,p_user jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE un units; ch text:=CASE WHEN p_user->>'role'='peer' THEN 'peer' ELSE 'customer' END;
BEGIN
 SELECT * INTO un FROM units WHERE id=p_id;
 IF NOT FOUND OR un.status<>'in_stock' OR un.share_flags->>(CASE WHEN ch='peer' THEN 'sharePeer' ELSE 'showInShop' END) IS DISTINCT FROM 'true' THEN PERFORM stock_error('P0404','商品不存在或已下架'); END IF;
 RETURN agent_public_unit(un.id,ch,CASE WHEN ch='peer' THEN un.wholesale ELSE un.retail END);
END $$;
REVOKE ALL ON FUNCTION agent_shop_unit(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION agent_shop_unit(uuid,jsonb) TO service_role;
