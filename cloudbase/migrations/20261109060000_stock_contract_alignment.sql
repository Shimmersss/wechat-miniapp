-- 补齐旧服务的金额空白处理、快递不存在/未提供状态与运单大小写唯一性。
CREATE OR REPLACE FUNCTION stock_purchase(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE target uuid:=coalesce((p->>'id')::uuid,gen_random_uuid()); old suppliers; po purchase_orders; sh shipments; row_v jsonb; attrs jsonb; total numeric; qty int:=0; quantity_v int; cost_v numeric; result jsonb; sid uuid; key_v text; state text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'suppliers.list' THEN
  WITH filtered AS(SELECT id,name,contact,phone,settle,note,active,created_at FROM suppliers WHERE (NOT d ? 'keyword' OR name ILIKE '%'||(d->>'keyword')||'%') AND (NOT d ? 'active' OR active=(d->>'active')::boolean)), rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(rows)-'created_at' ORDER BY created_at DESC,id),'[]'),'total',(SELECT count(*) FROM filtered)) INTO result FROM rows;
 WHEN 'suppliers.create','suppliers.update' THEN
  IF action='suppliers.update' THEN SELECT * INTO old FROM suppliers WHERE id=target FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','供应商不存在'); END IF; END IF;
  INSERT INTO suppliers(id,name,contact,phone,settle,note,active) VALUES(target,stock_text(d->'name','供应商名称',100),stock_text(d->'contact','联系人',100,true),stock_text(d->'phone','联系电话',30,true),stock_text(d->'settle','结算方式',100,true),stock_text(d->'note','备注',1000,true),coalesce((d->>'active')::boolean,true))
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact=excluded.contact,phone=excluded.phone,settle=excluded.settle,note=excluded.note,active=excluded.active;
  SELECT to_jsonb(s)-'created_at' INTO result FROM suppliers s WHERE id=target; PERFORM stock_audit(u,req,CASE WHEN old.id IS NULL THEN '新增供应商' ELSE '修改供应商' END,target::text,to_jsonb(old),result);
 WHEN 'purchase.list' THEN
  WITH filtered AS(SELECT o.*,(SELECT coalesce(sum(received_count),0) FROM purchase_lines WHERE purchase_id=o.id) received FROM purchase_orders o WHERE (NOT d ? 'status' OR o.status=d->>'status') AND (NOT d ? 'supplierId' OR o.supplier_id=(d->>'supplierId')::uuid) AND (NOT d ? 'keyword' OR o.no ILIKE '%'||(d->>'keyword')||'%' OR EXISTS(SELECT 1 FROM shipments WHERE purchase_id=o.id AND tracking_no ILIKE '%'||(d->>'keyword')||'%'))), rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
  SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(stock_purchase_raw(id,false) ORDER BY created_at DESC,id) FROM rows),'[]'),'total',count(*),'summary',jsonb_build_object('orders',count(*),'totalQty',coalesce(sum(quantity),0),'remainingQty',coalesce(sum(quantity-received),0),'inTransitQty',coalesce(sum(quantity-received) FILTER(WHERE status='in_transit'),0))) INTO result FROM filtered;
 WHEN 'purchase.get','purchase.acceptance' THEN
  result:=stock_purchase_raw(target); IF result IS NULL THEN PERFORM stock_error('P0404','采购单不存在'); END IF;
 WHEN 'purchase.create','purchase.update' THEN
  IF action='purchase.update' THEN SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;
   IF po.status<>'pending_ship' THEN PERFORM stock_error('P0409','已发货或开始验收的采购单不能修改明细'); END IF;
  END IF;
  sid:=stock_text(d->'supplierId','供应商',36)::uuid; IF NOT EXISTS(SELECT 1 FROM suppliers WHERE id=sid AND active) THEN PERFORM stock_error('P0400','供应商不存在或已停用'); END IF;
  total:=stock_money(coalesce(d->'freight','0'));
  FOR row_v IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP quantity_v:=(row_v->>'quantity')::int; cost_v:=stock_money(row_v->'unitCost'); qty:=qty+quantity_v; total:=total+quantity_v*cost_v; END LOOP;
  IF qty>10000 OR total>999999999999.99 THEN PERFORM stock_error('P0400','单张采购单最多10000台或金额合计超出允许范围'); END IF;
  INSERT INTO purchase_orders(id,no,supplier_id,expected_at,freight,amount,quantity,owner_id,remark) VALUES(target,coalesce(po.no,'PO'||to_char(now() AT TIME ZONE 'UTC','YYYYMMDD')||'-'||left(replace(target::text,'-',''),16)),sid,(d->>'expectedAt')::date,stock_money(coalesce(d->'freight','0')),total,qty,(u->>'id')::uuid,stock_text(d->'remark','采购备注',1000,true))
  ON CONFLICT(id) DO UPDATE SET supplier_id=excluded.supplier_id,expected_at=excluded.expected_at,freight=excluded.freight,amount=excluded.amount,quantity=excluded.quantity,remark=excluded.remark;
  DELETE FROM purchase_lines WHERE purchase_id=target;
  FOR row_v IN SELECT value FROM jsonb_array_elements(d->'lines') LOOP
   IF NOT EXISTS(SELECT 1 FROM models WHERE id=row_v->>'modelId') THEN PERFORM stock_error('P0400','明细型号不存在'); END IF;
   attrs:='{}'; FOR key_v IN SELECT unnest(ARRAY['storage','color','version']) LOOP IF coalesce(row_v->'attributes'->>key_v,'')<>'' THEN attrs:=attrs||jsonb_build_object(key_v,stock_text(row_v->'attributes'->key_v,'采购规格',100)); END IF; END LOOP;
   INSERT INTO purchase_lines(id,purchase_id,model_id,expected_attributes,quantity,unit_cost) VALUES(gen_random_uuid(),target,row_v->>'modelId',attrs,(row_v->>'quantity')::int,stock_money(row_v->'unitCost'));
  END LOOP;
  PERFORM stock_audit(u,req,CASE WHEN po.id IS NULL THEN '创建采购单' ELSE '修改采购单' END,target::text,NULL,jsonb_build_object('qty',qty,'supplierId',sid)); result:=stock_purchase_raw(target);
 WHEN 'purchase.shipment' THEN
  SELECT * INTO po FROM purchase_orders WHERE id=target FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;
  IF po.status NOT IN ('pending_ship','in_transit','arrived','accepting','exception') THEN PERFORM stock_error('P0409','采购单已完成，不能追加运单'); END IF;
  sid:=gen_random_uuid(); INSERT INTO shipments(id,purchase_id,carrier,tracking_no) VALUES(sid,target,d->>'carrier',d->>'trackingNo'); PERFORM stock_purchase_status(target); PERFORM stock_audit(u,req,'绑定采购运单',target::text,NULL,jsonb_build_object('shipmentId',sid,'carrier',d->'carrier','trackingNo',d->'trackingNo')); result:=jsonb_build_object('id',sid);
 WHEN 'shipment.receive' THEN
  SELECT * INTO sh FROM shipments WHERE id=target; IF NOT FOUND THEN PERFORM stock_error('P0404','运单不存在'); END IF;
  PERFORM 1 FROM purchase_orders WHERE id=sh.purchase_id FOR UPDATE; SELECT * INTO sh FROM shipments WHERE id=target FOR UPDATE;
  IF sh.status='signed' THEN RETURN '{"received":true}'; END IF;
  IF d ? 'receiptFileId' THEN PERFORM stock_files(jsonb_build_array(jsonb_build_object('fileId',d->'receiptFileId')),'internal',u,true); END IF;
  UPDATE shipments SET status='signed',signed_at=now(),receipt_file_id=(d->>'receiptFileId')::uuid WHERE id=target; state:=stock_purchase_status(sh.purchase_id);
  PERFORM stock_audit(u,req,'采购运单人工签收',target::text,NULL,'{"status":"signed"}',stock_text(d->'reason','人工签收说明',500)); result:=jsonb_build_object('received',true,'purchaseStatus',state);
 WHEN 'shipment.tracks' THEN IF NOT EXISTS(SELECT 1 FROM shipments WHERE id=target) THEN PERFORM stock_error('P0404','运单不存在'); END IF; PERFORM stock_error('P0503','首期不提供快递轨迹查询，请在实际收货后登记签收');
 ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发'); END CASE; RETURN result;
END $$;

CREATE OR REPLACE FUNCTION stock_money(v jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
BEGIN
 IF jsonb_typeof(v) NOT IN ('number','string') OR v IS NULL OR trim(v#>>'{}') !~ '^\d{1,12}(\.\d{1,2})?$' THEN PERFORM stock_error('P0400','金额需为非负金额，最多两位小数'); END IF;
 RETURN trim(v#>>'{}')::numeric(14,2);
END $$;
CREATE UNIQUE INDEX shipments_tracking_ci ON shipments(lower(carrier),lower(tracking_no));
CREATE UNIQUE INDEX repair_external_identifier_ci ON repair_external_slots(lower(identifier));
