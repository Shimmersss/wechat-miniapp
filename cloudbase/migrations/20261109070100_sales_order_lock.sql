-- PG 对行锁要求UPDATE权限；锁独立订单锁表，销售快照与退款记录继续只追加。
CREATE OR REPLACE FUNCTION api_sales(p_action text,p_params jsonb,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE oid uuid:=(p_params->>'id')::uuid; d jsonb:=p_data; o sales_orders; prior sales_refunds; item sales_items; un units; input jsonb; plan jsonb:='[]'; remaining numeric; amount_v numeric; total numeric:=0; rid uuid:=gen_random_uuid(); key_v text; why text; kind_v text; digest text; result_v jsonb; lim int:=(p_params->>'limit')::int; off_v int:=(p_params->>'offset')::int;
BEGIN
 IF p_action IN ('sales.lookup','sales.quote','sales.create') THEN RETURN stock_sale(p_action,p_params,d,p_user,p_request_id); END IF;
 IF p_action='sales.sellers' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',seller_id,'name',stock_operator(seller_id)) ORDER BY stock_operator(seller_id),seller_id),'[]') INTO result_v FROM (SELECT DISTINCT seller_id FROM sales_orders) s; RETURN result_v;
 END IF;
 IF p_action='sales.list' THEN
  WITH base AS(SELECT o.*,stock_sale_raw(o.id) raw FROM sales_orders o WHERE
   (NOT d ? 'sellerId' OR o.seller_id=(d->>'sellerId')::uuid) AND
   (NOT d ? 'keyword' OR o.no ILIKE '%'||(d->>'keyword')||'%' OR o.customer ILIKE '%'||(d->>'keyword')||'%') AND
   (NOT d ? 'from' OR o.created_at >= (d->>'from')::timestamp AT TIME ZONE 'Asia/Shanghai') AND
   (NOT d ? 'to' OR o.created_at < ((d->>'to')::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')),
  filtered AS(SELECT * FROM base WHERE NOT d ? 'status' OR CASE
   WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'items') WHERE value->'returned'='false'::jsonb) THEN 'refunded'
   WHEN jsonb_array_length(raw->'refunds')>0 THEN 'partially_refunded' ELSE 'paid' END=d->>'status'),
  rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(raw ORDER BY created_at DESC,id),'[]'),'total',(SELECT count(*) FROM filtered)) INTO result_v FROM rows; RETURN result_v;
 END IF;
 -- 与旧端一致：对销售单加互斥锁，所有退款与重试在同一事务内序列化。
 IF p_action='sales.refund' THEN
  IF NOT EXISTS(SELECT 1 FROM sales_orders WHERE id=oid) THEN PERFORM stock_error('P0404','销售单不存在'); END IF;
  INSERT INTO sales_order_locks(order_id) VALUES(oid) ON CONFLICT(order_id) DO NOTHING;
  PERFORM 1 FROM sales_order_locks WHERE order_id=oid FOR UPDATE;
 END IF;
 SELECT * INTO o FROM sales_orders WHERE id=oid;
 IF NOT FOUND THEN PERFORM stock_error('P0404','销售单不存在'); END IF;
 IF p_action='sales.get' THEN RETURN sales_detail(oid); END IF;
 IF p_action<>'sales.refund' THEN PERFORM stock_error('P0404','接口尚未迁移到云开发'); END IF;
 why:=stock_text(d->'reason','退款原因',500); key_v:=stock_text(d->'requestKey','提交标识',80); kind_v:=coalesce(d->>'kind','return'); digest:=md5((d||jsonb_build_object('orderId',oid))::text);
 SELECT * INTO prior FROM sales_refunds WHERE request_key=key_v;
 IF FOUND THEN IF prior.request_hash<>digest THEN PERFORM stock_error('P0409','退款提交标识冲突'); END IF; RETURN sales_detail(oid); END IF;
 FOR input IN SELECT value FROM jsonb_array_elements(d->'items') LOOP
  IF plan @> jsonb_build_array(jsonb_build_object('itemId',input->'itemId')) THEN PERFORM stock_error('P0400','退款明细重复'); END IF;
  SELECT * INTO item FROM sales_items WHERE id=(input->>'itemId')::uuid AND order_id=oid;
  IF NOT FOUND THEN PERFORM stock_error('P0400','退款明细不属于本单'); END IF;
  IF EXISTS(SELECT 1 FROM sales_refund_items ri JOIN sales_refunds rf ON rf.id=ri.refund_id WHERE ri.sale_item_id=item.id AND rf.kind='return') THEN PERFORM stock_error('P0409','该设备已退货'); END IF;
  SELECT item.price-coalesce(sum(amount),0) INTO remaining FROM sales_refund_items WHERE sale_item_id=item.id;
  amount_v:=CASE WHEN NOT input ? 'amount' AND kind_v='return' THEN remaining ELSE stock_money(input->'amount') END;
  IF amount_v>remaining OR (kind_v='adjustment' AND amount_v=0) THEN PERFORM stock_error('P0400','退款金额超出剩余可退范围'); END IF;
  total:=total+amount_v; plan:=plan||jsonb_build_array(jsonb_build_object('itemId',item.id,'unitId',item.unit_id,'amount',amount_v,'cost',item.cost));
 END LOOP;
 IF total>999999999999.99 THEN PERFORM stock_error('P0400','金额合计超出允许范围'); END IF;
 FOR input IN SELECT value FROM jsonb_array_elements(plan) ORDER BY value->>'unitId' LOOP
  SELECT * INTO un FROM units WHERE id=(input->>'unitId')::uuid FOR UPDATE;
  IF un.status IS DISTINCT FROM 'sold' THEN PERFORM stock_error('P0409','原销售设备状态不符'); END IF;
 END LOOP;
 INSERT INTO sales_refunds(id,order_id,operator_id,reason,kind,amount,request_key,request_hash) VALUES(rid,oid,(p_user->>'id')::uuid,why,kind_v,total,key_v,digest);
 FOR input IN SELECT value FROM jsonb_array_elements(plan) LOOP
  INSERT INTO sales_refund_items(refund_id,sale_item_id,amount,cost_reversal) VALUES(rid,(input->>'itemId')::uuid,(input->>'amount')::numeric,CASE WHEN kind_v='return' THEN (input->>'cost')::numeric ELSE 0 END);
  IF kind_v='return' THEN
   UPDATE units SET status='recheck',share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}' WHERE id=(input->>'unitId')::uuid;
   INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES((input->>'unitId')::uuid,'sold','recheck','refund',rid::text,(p_user->>'id')::uuid,why);
   PERFORM sales_return_earning(oid,(input->>'unitId')::uuid,rid,p_user,p_request_id);
  END IF;
 END LOOP;
 PERFORM stock_audit(p_user,p_request_id,'销售退款',oid::text,NULL,jsonb_build_object('refundId',rid,'kind',kind_v,'amount',total,'itemIds',(SELECT jsonb_agg(value->'itemId') FROM jsonb_array_elements(plan))),why);
 RETURN sales_detail(oid);
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','退款提交标识或冲回记录已存在，请刷新后重试');
 WHEN foreign_key_violation OR invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation THEN PERFORM stock_error('P0400','退款参数无效或关联记录不存在');
 WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN PERFORM stock_error('P0409','记录正被其他操作更新，请刷新后重试');
END $$;