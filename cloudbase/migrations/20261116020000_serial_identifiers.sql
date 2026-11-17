-- 非手机入库（docs/PLAN-DEVICE-TYPES-AND-SERIAL-INBOUND.md WP3/WP4）：
-- - 设备可登记 IMEI（手机）、序列号（非手机，推荐），或填写无序列号原因；蜂窝版平板可另填 IMEI。
-- - 同一型号下序列号不重复；跨型号不拦截。
-- - 配件等无序列号设备可按数量入库：仍是一件一条记录，共用 lot_id；顾客端同批折叠为一张卡片。
-- - 按码查设备（收银、盘点）支持序列号；同一序列号命中多台时要求改扫设备标签。
-- 存储过程均从原迁移复制后定点修改，未改动的逻辑保持原样。

ALTER TABLE units ALTER COLUMN imei1 DROP NOT NULL;
ALTER TABLE units ADD COLUMN serial_no varchar(40);
ALTER TABLE units ADD COLUMN no_serial_reason varchar(100);
ALTER TABLE units ADD COLUMN lot_id uuid;
ALTER TABLE units ADD CONSTRAINT units_identity_present CHECK (imei1 IS NOT NULL OR serial_no IS NOT NULL OR no_serial_reason IS NOT NULL);
ALTER TABLE units ADD CONSTRAINT units_serial_or_reason CHECK (no_serial_reason IS NULL OR serial_no IS NULL);
ALTER TABLE units ADD CONSTRAINT units_serial_format CHECK (serial_no IS NULL OR serial_no ~ '^[A-Z0-9-]{4,40}$');
CREATE UNIQUE INDEX units_model_serial ON units(model_id, serial_no) WHERE serial_no IS NOT NULL;
CREATE INDEX units_lot ON units(lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX units_serial ON units(serial_no) WHERE serial_no IS NOT NULL;

ALTER TABLE acceptance_items ALTER COLUMN imei1 DROP NOT NULL;
ALTER TABLE acceptance_items ADD COLUMN serial_no varchar(40);
ALTER TABLE acceptance_items ADD COLUMN no_serial_reason varchar(100);
ALTER TABLE acceptance_items ADD CONSTRAINT acceptance_identity_present CHECK (imei1 IS NOT NULL OR serial_no IS NOT NULL OR no_serial_reason IS NOT NULL);

CREATE FUNCTION stock_is_imei(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
DECLARE n int:=0; d int; i int;
BEGIN
 IF v IS NULL OR v !~ '^\d{15}$' THEN RETURN false; END IF;
 FOR i IN 1..15 LOOP d:=substring(v,i,1)::int; IF i%2=0 THEN d:=d*2; END IF; n:=n+d/10+d%10; END LOOP;
 RETURN n%10=0;
END $$;

-- 序列号：去首尾空格转大写，4～40 位字母、数字或连字符；15 位且通过 IMEI 校验的串应填到 IMEI 栏。
CREATE FUNCTION stock_serial(v text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
DECLARE s text:=upper(btrim(coalesce(v,'')));
BEGIN
 IF s !~ '^[A-Z0-9-]{4,40}$' THEN PERFORM stock_error('P0400','序列号需为 4～40 位字母、数字或连字符'); END IF;
 IF stock_is_imei(s) THEN PERFORM stock_error('P0400','这是 IMEI，请填写到 IMEI 栏'); END IF;
 RETURN s;
END $$;

CREATE FUNCTION stock_mask_serial(v text) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
 SELECT CASE WHEN v IS NULL THEN NULL ELSE left(v,2)||'****'||right(v,3) END
$$;

-- 按分类串码方式校验并返回 {imei1, imei2, serialNo, noSerialReason}。
CREATE FUNCTION stock_identity(d jsonb, mode text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
DECLARE i1 text; i2 text; sn text; why text;
BEGIN
 i1:=nullif(btrim(coalesce(d->>'imei1','')),''); i2:=nullif(btrim(coalesce(d->>'imei2','')),'');
 sn:=nullif(btrim(coalesce(d->>'serialNo','')),''); why:=nullif(btrim(coalesce(d->>'noSerialReason','')),'');
 IF mode='imei' THEN
  IF sn IS NOT NULL OR why IS NOT NULL THEN PERFORM stock_error('P0400','手机请填写 IMEI，不登记序列号'); END IF;
  i1:=stock_imei(stock_text(d->'imei1','IMEI1',15));
  IF i2 IS NOT NULL THEN PERFORM stock_imei(i2); IF i1=i2 THEN PERFORM stock_error('P0400','本次提交存在重复串码'); END IF; END IF;
 ELSIF mode IN ('serial','serial_imei') THEN
  IF i2 IS NOT NULL THEN PERFORM stock_error('P0400','IMEI2 只用于手机'); END IF;
  IF i1 IS NOT NULL THEN
   IF mode='serial' THEN PERFORM stock_error('P0400','该分类不登记 IMEI，请填写序列号'); END IF;
   PERFORM stock_imei(i1);
  END IF;
  IF sn IS NOT NULL THEN
   sn:=stock_serial(sn);
   IF why IS NOT NULL THEN PERFORM stock_error('P0400','已填写序列号，不需要填写无序列号原因'); END IF;
  ELSIF i1 IS NULL THEN
   IF why IS NULL OR char_length(why) NOT BETWEEN 2 AND 100 THEN PERFORM stock_error('P0400','没有序列号时请填写原因（2～100字）'); END IF;
  ELSE
   why:=NULL;
  END IF;
 ELSE
  PERFORM stock_error('P0400','分类串码方式无效');
 END IF;
 RETURN jsonb_build_object('imei1',i1,'imei2',i2,'serialNo',sn,'noSerialReason',why);
END $$;

-- 扫码查设备：设备编号、IMEI 优先；其次序列号。同一序列号对应多台时要求改扫设备标签。
CREATE FUNCTION stock_find_unit(code text) RETURNS uuid LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE c text:=btrim(coalesce(code,'')); r uuid; ids uuid[];
BEGIN
 IF c='' THEN RETURN NULL; END IF;
 SELECT id INTO r FROM units WHERE id::text=c OR imei1=c OR imei2=c LIMIT 1;
 IF FOUND THEN RETURN r; END IF;
 SELECT array_agg(id) INTO ids FROM units WHERE serial_no=upper(c);
 IF coalesce(array_length(ids,1),0)>1 THEN PERFORM stock_error('P0409','该序列号对应多台设备，请扫设备标签或从库存选择'); END IF;
 RETURN ids[1];
END $$;

CREATE OR REPLACE FUNCTION stock_insert(d jsonb,u jsonb,ctx jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE form jsonb; attrs jsonb:='{}'; f jsonb; supplier suppliers; mid text; sid uuid; uid uuid:=gen_random_uuid(); imei_v text; imei2_v text; status_v text; flags_v jsonb; receipt jsonb; public_v jsonb; item uuid:=(ctx->>'acceptanceItemId')::uuid; reserved uuid:=(ctx->>'reservedItemId')::uuid; k text; values_v jsonb; n int; mode_v text; ident jsonb; serial_v text; why_v text;
BEGIN
 mid:=stock_text(d->'modelId','型号',60);
 PERFORM 1 FROM models m JOIN templates t ON t.id=m.template_id WHERE m.id=mid FOR SHARE OF m,t;
 form:=stock_form(mid);
 IF d->'templateVersion' IS DISTINCT FROM form->'version' THEN PERFORM stock_error('P0409','模板已更新，请重新加载型号'); END IF;
 IF jsonb_typeof(d->'attributes') IS DISTINCT FROM 'object' THEN PERFORM stock_error('P0400','请填写模板参数'); END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(form->'fields') LOOP
  k:=f->>'key'; IF d->'attributes' ? k THEN attrs:=attrs||jsonb_build_object(k,d->'attributes'->k); END IF;
 END LOOP;
 sid:=coalesce(ctx->>'supplierId',d->>'supplierId')::uuid;
 IF sid IS NOT NULL THEN SELECT * INTO supplier FROM suppliers WHERE id=sid;
 ELSIF attrs->>'supplier' IS NOT NULL AND stock_can(u,'supplier') THEN SELECT * INTO supplier FROM suppliers WHERE lower(name)=lower(attrs->>'supplier') AND active; END IF;
 IF sid IS NOT NULL AND supplier.id IS NULL THEN PERFORM stock_error('P0400','供应商不存在'); END IF;
 IF supplier.id IS NOT NULL AND NOT ctx ? 'supplierId' AND NOT supplier.active THEN PERFORM stock_error('P0400','供应商已停用'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(form->'fields') WHERE value->>'key'='supplier') AND supplier.id IS NOT NULL THEN attrs:=attrs||jsonb_build_object('supplier',supplier.name); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(form->'fields') WHERE value->>'key'='supplier' AND (value->>'required')::boolean) AND supplier.id IS NULL THEN PERFORM stock_error('P0400','请关联有效供应商；库管可从采购验收单入库'); END IF;
 IF d ? 'receiptImages' AND EXISTS(SELECT 1 FROM jsonb_array_elements(form->'fields') WHERE value->>'key'='receipt' AND value->>'type'='image') AND coalesce(jsonb_array_length(attrs->'receipt'),0)=0 THEN attrs:=attrs||jsonb_build_object('receipt',d->'receiptImages'); END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(form->'fields') WHERE value->>'type'='image' LOOP
  attrs:=attrs||jsonb_build_object(f->>'key',stock_files(attrs->(f->>'key'),CASE WHEN f->'visibility' ? 'internal' THEN 'internal' ELSE 'public' END,u,true,coalesce(ctx->'trustedReceiptIds','[]')));
 END LOOP;
 PERFORM stock_values(form->'fields',attrs);
 mode_v:=stock_unit_mode(mid); ident:=stock_identity(d,mode_v);
 imei_v:=ident->>'imei1'; imei2_v:=ident->>'imei2'; serial_v:=ident->>'serialNo'; why_v:=ident->>'noSerialReason';
 IF serial_v IS NOT NULL THEN
  -- 只要求同型号下序列号不重复；跨型号相同序列号不拦截。
  PERFORM pg_advisory_xact_lock(hashtextextended('serial:'||mid||':'||serial_v,0));
  IF EXISTS(SELECT 1 FROM units WHERE model_id=mid AND serial_no=serial_v) THEN PERFORM stock_error('P0409','同型号下该序列号已入库'); END IF;
  IF EXISTS(SELECT 1 FROM acceptance_items WHERE model_id=mid AND serial_no=serial_v AND unit_id IS NULL AND result='fail' AND resolution IN ('none','dispute') AND id IS DISTINCT FROM reserved) THEN PERFORM stock_error('P0409','该序列号正在异常验收中'); END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM repair_external_slots WHERE identifier IN (imei_v,imei2_v,serial_v)) THEN PERFORM stock_error('P0409','串码正在外部维修中，不能作为本店库存入库'); END IF;
 IF EXISTS(SELECT 1 FROM unit_identifiers WHERE unit_identifiers.imei IN (imei_v,imei2_v) AND NOT (reserved IS NOT NULL AND acceptance_item_id=reserved AND unit_id IS NULL)) THEN PERFORM stock_error('P0409','串码已入库或正在异常验收中'); END IF;
 IF EXISTS(SELECT 1 FROM tac_mappings WHERE tac=left(imei_v,8) AND model_id<>mid) THEN PERFORM stock_error('P0400','串码识别型号与所选型号不一致'); END IF;
 IF coalesce(d->>'condition','used') NOT IN ('used','new') THEN PERFORM stock_error('P0400','设备类型无效'); END IF;
 status_v:=CASE WHEN attrs->>'refurbishment'='正在整备' THEN 'recheck' ELSE 'in_stock' END;
 flags_v:=stock_flags(coalesce(d->'flags','{}')); IF status_v<>'in_stock' THEN flags_v:='{"showInShop":false,"sharePeer":false,"shareAgent":false}'; END IF;
 receipt:=stock_files(d->'receiptImages','internal',u,true,coalesce(ctx->'trustedReceiptIds','[]')); public_v:=stock_files(d->'publicImages','public',u);
 INSERT INTO units(id,model_id,imei1,imei2,serial_no,no_serial_reason,lot_id,status,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,purchase_line_id,acceptance_item_id,inbound_operator_id,supplier_id)
 VALUES(uid,mid,imei_v,imei2_v,serial_v,why_v,(ctx->>'lotId')::uuid,status_v,coalesce(d->>'condition','used'),attrs,form-'modelId'-'modelName'-'specs',stock_money(coalesce(ctx->'cost',d->'cost')),stock_money(d->'retail'),stock_money(d->'wholesale'),stock_money(d->'agentBase'),flags_v,stock_text(d->'peerDesc','同行描述',4000,true),stock_text(d->'customerDesc','顾客描述',4000,true),stock_text(d->'internalNote','内部备注',4000,true),(ctx->>'purchaseLineId')::uuid,item,(u->>'id')::uuid,supplier.id);
 FOR k,values_v IN SELECT 'imei1',to_jsonb(imei_v) WHERE imei_v IS NOT NULL UNION ALL SELECT 'imei2',to_jsonb(imei2_v) WHERE imei2_v IS NOT NULL LOOP
  IF reserved IS NOT NULL THEN
   UPDATE unit_identifiers SET unit_id=uid WHERE unit_identifiers.imei=values_v#>>'{}' AND acceptance_item_id=reserved AND unit_id IS NULL; GET DIAGNOSTICS n=ROW_COUNT; IF n<>1 THEN PERFORM stock_error('P0409','异常验收串码已变更，请刷新'); END IF;
  ELSE INSERT INTO unit_identifiers(imei,unit_id,acceptance_item_id,slot) VALUES(values_v#>>'{}',uid,item,k); END IF;
 END LOOP;
 FOR k,values_v IN SELECT 'publicImages',public_v UNION ALL SELECT 'receiptImages',receipt UNION ALL SELECT value->>'key',attrs->(value->>'key') FROM jsonb_array_elements(form->'fields') WHERE value->>'type'='image' LOOP
  INSERT INTO unit_files(unit_id,file_id,field_key,position) SELECT uid,(value->>'fileId')::uuid,k,ordinality-1 FROM jsonb_array_elements(values_v) WITH ORDINALITY;
 END LOOP;
 INSERT INTO unit_inspections(id,unit_id,result,attributes,operator_id,reason) VALUES(gen_random_uuid(),uid,'pass',attrs,(u->>'id')::uuid,'首次验收确认');
 INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,CASE WHEN item IS NOT NULL THEN 'accepting' END,status_v,CASE WHEN item IS NULL THEN 'inbound' ELSE 'acceptance' END,coalesce(item,uid)::text,(u->>'id')::uuid,coalesce(ctx->>'reason',CASE WHEN why_v IS NOT NULL THEN '已核验型号、机况与凭证；无序列号：'||why_v ELSE '已核验型号、串码、机况与凭证' END));
 RETURN uid;
END $$;

CREATE OR REPLACE FUNCTION stock_raw(uid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(u)||jsonb_build_object('name',m.name,'brand',m.brand,'category_id',m.category_id,'identifier_mode',stock_unit_mode(m.id),'supplier_name',s.name,'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position) FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=u.id),'[]'),'inspectionVersion',(SELECT count(*) FROM unit_inspections WHERE unit_id=u.id),'loan',(SELECT jsonb_build_object('id',o.id,'no',o.no,'type',o.type) FROM loan_active_units a JOIN loan_orders o ON o.id=a.order_id WHERE a.unit_id=u.id)) FROM units u JOIN models m ON m.id=u.model_id LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.id=uid
$$;

CREATE OR REPLACE FUNCTION stock_accept(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE po purchase_orders; prev acceptance_batches; line purchase_lines; ai acceptance_items; item_v jsonb; proof jsonb; attrs jsonb; batch uuid:=gen_random_uuid(); iid uuid; uid uuid; planned jsonb:='[]'; ids jsonb:='[]'; itemids jsonb:='[]'; accepted int:=0; rejected int:=0; remaining int; reason_v text:=''; request_key_v text; digest text:=md5(d::text||coalesce(p->>'id','')); result_v jsonb; imei_v text; imei2_v text; state text; original jsonb; ident jsonb;
BEGIN
 IF action='acceptance.submit' THEN
  request_key_v:=stock_text(d->'requestKey','提交标识',80);
  SELECT * INTO po FROM purchase_orders WHERE id=(p->>'id')::uuid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','采购单不存在'); END IF;
  SELECT * INTO prev FROM acceptance_batches WHERE request_key=request_key_v;
  IF FOUND THEN IF prev.purchase_id<>po.id OR prev.request_hash<>digest THEN PERFORM stock_error('P0409','提交标识已用于其他内容，请重新核对'); END IF; RETURN prev.result; END IF;
  IF po.status NOT IN ('arrived','accepting','exception') OR NOT EXISTS(SELECT 1 FROM shipments WHERE purchase_id=po.id AND status='signed') THEN PERFORM stock_error('P0409','请先登记实际签收，再开始验收'); END IF;
  SELECT sum(quantity-received_count) INTO remaining FROM purchase_lines WHERE purchase_id=po.id;
  IF jsonb_array_length(d->'items')>remaining THEN PERFORM stock_error('P0400','实收数量超过采购剩余数量'); END IF;
  IF jsonb_array_length(d->'items')<remaining THEN IF d->'partialConfirmed' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0400','数量不足，请明确确认分批验收'); END IF; reason_v:=stock_text(d->'partialReason','分批验收原因',500); END IF;
  INSERT INTO acceptance_batches(id,purchase_id,request_key,request_hash,operator_id,result) VALUES(batch,po.id,request_key_v,digest,(u->>'id')::uuid,'{}');
  FOR item_v IN SELECT value FROM jsonb_array_elements(d->'items') LOOP
   SELECT * INTO line FROM purchase_lines WHERE id=(item_v->>'lineId')::uuid AND purchase_id=po.id FOR UPDATE;
   IF NOT FOUND THEN PERFORM stock_error('P0400','设备不属于本采购单明细'); END IF;
   IF line.received_count>=line.quantity THEN PERFORM stock_error('P0400','本型号验收数量超过采购剩余数量'); END IF;
   proof:=stock_files(coalesce(item_v->'receiptImages',item_v->'attributes'->'receipt','[]'),'internal',u,true); IF jsonb_array_length(proof)=0 THEN PERFORM stock_error('P0400','验收需上传内部收货凭证'); END IF;
   iid:=gen_random_uuid(); uid:=NULL; ident:=stock_identity(item_v,stock_unit_mode(coalesce(nullif(item_v->>'modelId',''),line.model_id))); imei_v:=ident->>'imei1'; imei2_v:=ident->>'imei2';
   IF item_v->>'result'='pass' THEN
    PERFORM stock_check_specs(line,item_v); attrs:=coalesce(item_v->'attributes','{}');
   ELSIF item_v->>'result'='fail' THEN attrs:=jsonb_build_object('_receiptImages',proof,'_observedModel',stock_text(item_v->'observedModel','实机型号说明',100,true));
   ELSE PERFORM stock_error('P0400','请填写验收结论'); END IF;
   INSERT INTO acceptance_items(id,batch_id,purchase_line_id,imei1,imei2,serial_no,no_serial_reason,model_id,result,reason,attributes) VALUES(iid,batch,line.id,imei_v,imei2_v,ident->>'serialNo',ident->>'noSerialReason',coalesce(item_v->>'modelId',line.model_id),item_v->>'result',CASE WHEN item_v->>'result'='fail' THEN stock_text(coalesce(item_v->'remark',item_v->'reason'),'异常原因',500) ELSE '' END,attrs);
   IF item_v->>'result'='pass' THEN
    uid:=stock_insert(item_v||jsonb_build_object('receiptImages',proof),u,jsonb_build_object('purchaseLineId',line.id,'acceptanceItemId',iid,'cost',line.unit_cost,'supplierId',po.supplier_id));
    UPDATE acceptance_items SET unit_id=uid,attributes=(SELECT attributes FROM units WHERE id=uid) WHERE id=iid; ids:=ids||to_jsonb(uid); accepted:=accepted+1;
   ELSE
    IF imei_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,acceptance_item_id,slot) VALUES(imei_v,iid,'imei1'); END IF; IF imei2_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,acceptance_item_id,slot) VALUES(imei2_v,iid,'imei2'); END IF; rejected:=rejected+1;
   END IF;
   UPDATE purchase_lines SET received_count=received_count+1,accepted_count=accepted_count+CASE WHEN uid IS NOT NULL THEN 1 ELSE 0 END,rejected_count=rejected_count+CASE WHEN uid IS NULL THEN 1 ELSE 0 END WHERE id=line.id;
   itemids:=itemids||to_jsonb(iid);
  END LOOP;
  result_v:=jsonb_build_object('batchId',batch,'accepted',accepted,'rejected',rejected,'unitIds',ids,'itemIds',itemids); UPDATE acceptance_batches SET result=result_v WHERE id=batch;
  PERFORM stock_purchase_status(po.id); PERFORM stock_audit(u,req,'采购到货验收',po.id::text,NULL,result_v,reason_v); RETURN result_v;
 END IF;
 SELECT * INTO ai FROM acceptance_items WHERE id=(p->>'id')::uuid; IF NOT FOUND THEN PERFORM stock_error('P0404','验收记录不存在'); END IF;
 SELECT o.* INTO po FROM purchase_orders o JOIN acceptance_batches b ON b.purchase_id=o.id WHERE b.id=ai.batch_id FOR UPDATE OF o;
 SELECT * INTO ai FROM acceptance_items WHERE id=(p->>'id')::uuid FOR UPDATE;
 IF ai.result<>'fail' OR ai.resolution NOT IN ('none','dispute') OR ai.unit_id IS NOT NULL THEN PERFORM stock_error('P0409','该异常已处理，不能重复操作'); END IF;
 reason_v:=stock_text(d->'reason','异常处理原因',500);
 CASE d->>'action'
 WHEN 'dispute' THEN UPDATE acceptance_items SET resolution='dispute',reason=reason_v WHERE id=ai.id;
 WHEN 'return' THEN DELETE FROM unit_identifiers WHERE acceptance_item_id=ai.id AND unit_id IS NULL; UPDATE acceptance_items SET resolution='returned',reason=reason_v WHERE id=ai.id;
 WHEN 'reinspect' THEN
  SELECT * INTO line FROM purchase_lines WHERE id=ai.purchase_line_id FOR UPDATE; item_v:=coalesce(d->'unit','{}'); PERFORM stock_check_specs(line,item_v);
  IF (item_v->>'imei1' IS NOT NULL AND item_v->>'imei1'<>'' AND item_v->>'imei1' IS DISTINCT FROM ai.imei1::text) OR (nullif(item_v->>'serialNo','') IS NOT NULL AND upper(btrim(item_v->>'serialNo')) IS DISTINCT FROM ai.serial_no) OR (item_v->>'imei2' IS NOT NULL AND item_v->>'imei2'<>'' AND item_v->>'imei2' IS DISTINCT FROM ai.imei2) THEN PERFORM stock_error('P0400','复验不能替换原异常设备串码'); END IF;
  proof:=coalesce(item_v->'receiptImages',item_v->'attributes'->'receipt',ai.attributes->'_receiptImages','[]');
  uid:=stock_insert(item_v||jsonb_build_object('imei1',ai.imei1,'imei2',coalesce(ai.imei2,''),'serialNo',ai.serial_no,'noSerialReason',ai.no_serial_reason,'receiptImages',proof),u,jsonb_build_object('purchaseLineId',line.id,'acceptanceItemId',ai.id,'reservedItemId',ai.id,'cost',line.unit_cost,'supplierId',po.supplier_id,'trustedReceiptIds',coalesce((SELECT jsonb_agg(value->>'fileId') FROM jsonb_array_elements(ai.attributes->'_receiptImages')),'[]'),'reason',reason_v));
  UPDATE acceptance_items SET resolution='reinspected',unit_id=uid,reason=reason_v WHERE id=ai.id; UPDATE purchase_lines SET accepted_count=accepted_count+1,rejected_count=rejected_count-1 WHERE id=line.id;
 ELSE PERFORM stock_error('P0400','异常处理方式无效'); END CASE;
 state:=stock_purchase_status(po.id); result_v:=jsonb_build_object('resolved',true,'unitId',uid,'purchaseStatus',state);
 PERFORM stock_audit(u,req,'处理验收异常',ai.id::text,jsonb_build_object('resolution',ai.resolution),jsonb_build_object('action',d->'action','unitId',uid,'status',state),reason_v); RETURN result_v;
END $$;

CREATE OR REPLACE FUNCTION stock_inventory(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE uid uuid:=(p->>'id')::uuid; row_v units; x jsonb; common jsonb; ids jsonb:='[]'; result jsonb; before_v jsonb; after_v jsonb; k text; attrs jsonb; f jsonb; ver int; next_v text; iid uuid; why text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int; qty int:=1; lot uuid;
BEGIN
 CASE action
 WHEN 'inbound.check' THEN
  k:=stock_imei(stock_text(d->'imei','IMEI',15)); SELECT jsonb_build_object('unique',false)||CASE WHEN unit_id IS NOT NULL THEN jsonb_build_object('conflictUnitId',unit_id) ELSE '{}' END INTO result FROM unit_identifiers WHERE imei=k; result:=coalesce(result,'{"unique":true}');
 WHEN 'inbound.checkSerial' THEN
  k:=stock_serial(stock_text(d->'serialNo','序列号',40));
  SELECT jsonb_build_object('unique',false,'conflictUnitId',id,'serialNo',k) INTO result FROM units WHERE model_id=stock_text(d->'modelId','型号',60) AND serial_no=k LIMIT 1;
  result:=coalesce(result,jsonb_build_object('unique',true,'serialNo',k));
 WHEN 'inbound.single','inbound.batch' THEN
  common:=CASE WHEN action='inbound.single' THEN d ELSE coalesce(d->'common','{}') END;
  IF common->'inspectionConfirmed' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0400','独立入库必须确认已完成到货验收'); END IF;
  -- 按数量入库：仅单台入口、无任何串码的设备；生成 N 条设备记录，共用同一批次号。
  IF action='inbound.single' AND d ? 'quantity' THEN
   IF coalesce(d->>'quantity','') !~ '^[0-9]{1,3}$' OR (d->>'quantity')::int NOT BETWEEN 1 AND 100 THEN PERFORM stock_error('P0400','入库数量需为 1～100 的整数'); END IF;
   qty:=(d->>'quantity')::int;
  END IF;
  IF qty>1 THEN
   IF nullif(d->>'serialNo','') IS NOT NULL OR nullif(d->>'imei1','') IS NOT NULL OR nullif(d->>'imei2','') IS NOT NULL THEN PERFORM stock_error('P0400','按数量入库只用于没有序列号的设备'); END IF;
   lot:=gen_random_uuid();
  END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(CASE WHEN action='inbound.single' THEN (SELECT jsonb_agg(d-'quantity') FROM generate_series(1,qty)) ELSE d->'units' END) LOOP
   uid:=stock_insert(common-'quantity'||x||jsonb_build_object('attributes',coalesce(common->'attributes','{}')||coalesce(x->'attributes','{}')),u,CASE WHEN lot IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('lotId',lot) END); ids:=ids||to_jsonb(uid);
  END LOOP;
  PERFORM stock_audit(u,req,CASE WHEN action='inbound.batch' THEN '批量验收入库' WHEN qty>1 THEN '按数量验收入库' ELSE '单台验收入库' END,ids->>0,NULL,jsonb_build_object('unitIds',ids,'count',jsonb_array_length(ids),'lotId',lot));
  result:=CASE WHEN action='inbound.single' THEN jsonb_build_object('id',ids->0,'created',jsonb_array_length(ids),'ids',ids,'lotId',lot) ELSE jsonb_build_object('created',jsonb_array_length(ids),'ids',ids) END;
 WHEN 'pricing.presets' THEN SELECT coalesce(jsonb_agg(cost ORDER BY cost),'[]') INTO result FROM (SELECT DISTINCT cost FROM units WHERE model_id=d->>'modelId' ORDER BY cost LIMIT 20) x;
 WHEN 'units.list' THEN
  WITH filtered AS(SELECT u.* FROM units u JOIN models m ON m.id=u.model_id WHERE (NOT d ? 'status' OR u.status=d->>'status') AND (NOT d ? 'modelId' OR u.model_id=d->>'modelId') AND (NOT d ? 'keyword' OR m.name ILIKE '%'||(d->>'keyword')||'%' OR u.id::text=d->>'keyword' OR u.imei1=d->>'keyword' OR u.imei2=d->>'keyword' OR u.serial_no=upper(d->>'keyword')) AND (NOT d ? 'lotId' OR u.lot_id=(d->>'lotId')::uuid) AND (NOT d ? 'noSerial' OR (u.imei1 IS NULL AND u.serial_no IS NULL)) AND (NOT d ? 'category' OR m.category_id=d->>'category') AND (NOT d ? 'imei' OR u.imei1=d->>'imei' OR u.imei2=d->>'imei') AND (NOT d ? 'ageingOver' OR u.created_at<=now()-make_interval(days=>(d->>'ageingOver')::int)) AND (NOT d ? 'minPrice' OR u.retail>=stock_money(d->'minPrice')) AND (NOT d ? 'maxPrice' OR u.retail<=stock_money(d->'maxPrice'))), rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
  SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(stock_raw(id) ORDER BY created_at DESC,id) FROM rows),'[]'),'total',(SELECT count(*) FROM filtered),'counts',(SELECT coalesce(jsonb_object_agg(status,n),'{}') FROM (SELECT status,count(*) n FROM units GROUP BY status) c)||jsonb_build_object('all',(SELECT count(*) FROM units)),'summary',(SELECT jsonb_build_object('inStock',count(*),'retailTotal',coalesce(sum(retail),0),'costTotal',coalesce(sum(cost),0)) FROM units WHERE status='in_stock')) INTO result;
 WHEN 'units.flags.batch' THEN
  PERFORM 1 FROM units WHERE id IN(SELECT value::uuid FROM jsonb_array_elements_text(d->'unitIds')) ORDER BY id FOR UPDATE;
  FOR k IN SELECT DISTINCT value FROM jsonb_array_elements_text(d->'unitIds') ORDER BY value LOOP
   SELECT * INTO row_v FROM units WHERE id=k::uuid; IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
   IF d->'shareAgent'='true'::jsonb AND row_v.status<>'in_stock' THEN PERFORM stock_error('P0409','只有在库可售设备能开启代理转发，请刷新后重选'); END IF;
   after_v:=stock_flags(jsonb_build_object('shareAgent',d->'shareAgent'),row_v.share_flags); UPDATE units SET share_flags=after_v WHERE id=row_v.id; PERFORM stock_audit(u,req,'批量调整代理转发',k,row_v.share_flags,after_v); ids:=ids||to_jsonb(k);
  END LOOP; result:=jsonb_build_object('updated',jsonb_array_length(ids),'shareAgent',d->'shareAgent');
 ELSE
  IF action IN ('units.price','units.flags','units.recheck') THEN SELECT * INTO row_v FROM units WHERE id=uid FOR UPDATE; ELSE SELECT * INTO row_v FROM units WHERE id=uid FOR SHARE; END IF;
  IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
  CASE action
  WHEN 'units.get','units.recheckForm' THEN result:=stock_raw(uid);
  WHEN 'units.label' THEN result:=jsonb_build_object('unitId',uid,'name',(SELECT name FROM models WHERE id=row_v.model_id),'storage',row_v.attributes->'storage','grade',row_v.attributes->'grade','retail',row_v.retail,'qrcodeText',uid,'imeiMasked',left(row_v.imei1,2)||'****'||right(row_v.imei1,4),'serialMasked',stock_mask_serial(row_v.serial_no),'identifierMode',stock_unit_mode(row_v.model_id));
  WHEN 'units.ledger' THEN SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',id,'time',created_at,'from',from_status,'to',to_status,'doc',doc_id,'docType',doc_type,'reason',reason,'operator',stock_operator(operator_id)) ORDER BY id DESC),'[]'),'total',(SELECT count(*) FROM inventory_ledger WHERE unit_id=uid)) INTO result FROM (SELECT * FROM inventory_ledger WHERE unit_id=uid ORDER BY id DESC LIMIT lim OFFSET off_v) l;
  WHEN 'units.price' THEN
   why:=stock_text(d->'reason','改价原因',500); IF row_v.status<>'in_stock' THEN PERFORM stock_error('P0409','当前状态不可改价'); END IF;
   IF d->'priceVersion' IS DISTINCT FROM to_jsonb(row_v.price_version) THEN PERFORM stock_error('P0409','价格已更新，请刷新'); END IF;
   before_v:='{}'; after_v:='{}'; FOR k IN SELECT unnest(ARRAY['retail','wholesale','agentBase']) LOOP IF d ? k THEN before_v:=before_v||jsonb_build_object(k,CASE k WHEN 'retail' THEN row_v.retail WHEN 'wholesale' THEN row_v.wholesale ELSE row_v.agent_base END); after_v:=after_v||jsonb_build_object(k,stock_money(d->k)); END IF; END LOOP;
   UPDATE units SET retail=coalesce((after_v->>'retail')::numeric,retail),wholesale=coalesce((after_v->>'wholesale')::numeric,wholesale),agent_base=coalesce((after_v->>'agentBase')::numeric,agent_base),price_version=price_version+1 WHERE id=uid;
   PERFORM stock_audit(u,req,'修改库存价格',uid::text,before_v,after_v,why); result:=stock_raw(uid);
  WHEN 'units.flags' THEN
   after_v:=stock_flags(d,row_v.share_flags); IF row_v.status<>'in_stock' AND EXISTS(SELECT 1 FROM jsonb_each(after_v) WHERE value='true') THEN PERFORM stock_error('P0409','只有在库可售设备能对外展示或分享'); END IF;
   UPDATE units SET share_flags=after_v WHERE id=uid; PERFORM stock_audit(u,req,'调整库存共享范围',uid::text,row_v.share_flags,after_v); result:=after_v;
  WHEN 'units.recheck' THEN
   why:=stock_text(d->'reason','复检说明',500); IF row_v.status<>'recheck' THEN PERFORM stock_error('P0409','设备不在待复检状态'); END IF;
   SELECT count(*) INTO ver FROM unit_inspections WHERE unit_id=uid; IF d->'inspectionVersion' IS DISTINCT FROM to_jsonb(ver) THEN PERFORM stock_error('P0409','复检记录已更新，请重新加载后核对'); END IF;
   attrs:=row_v.attributes;
   FOR k,x IN SELECT * FROM jsonb_each(coalesce(d->'attributes','{}')) LOOP
    SELECT value INTO f FROM jsonb_array_elements(row_v.template_snapshot->'fields') WHERE value->>'key'=k;
    IF f IS NULL OR k='supplier' THEN PERFORM stock_error('P0400','复检不能修改型号、货源或未定义字段'); END IF;
    IF NOT stock_can(u,k) OR (f->'visibility' ? 'internal' AND NOT stock_can(u,'internalNote')) THEN PERFORM stock_error('P0403','无权修改该复检字段'); END IF;
    IF f->>'type'='image' THEN x:=stock_files(x,CASE WHEN f->'visibility' ? 'internal' THEN 'internal' ELSE 'public' END,u,true); DELETE FROM unit_files WHERE unit_id=uid AND field_key=k; INSERT INTO unit_files(unit_id,file_id,field_key,position) SELECT uid,(value->>'fileId')::uuid,k,ordinality-1 FROM jsonb_array_elements(x) WITH ORDINALITY; END IF;
    attrs:=attrs||jsonb_build_object(k,x);
   END LOOP;
   PERFORM stock_values(row_v.template_snapshot->'fields',attrs);
   IF d->>'result'='pass' AND attrs->>'refurbishment'='正在整备' THEN PERFORM stock_error('P0400','整备未完成，不能复检通过'); END IF;
   iid:=gen_random_uuid(); next_v:=CASE WHEN d->>'result'='pass' THEN 'in_stock' ELSE 'recheck' END;
   INSERT INTO unit_inspections(id,unit_id,result,attributes,operator_id,reason) VALUES(iid,uid,d->>'result',attrs,(u->>'id')::uuid,why);
   UPDATE units SET status=next_v,attributes=attrs WHERE id=uid;
   INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,row_v.status,next_v,'recheck',iid::text,(u->>'id')::uuid,why);
   PERFORM stock_audit(u,req,'库存复检',uid::text,jsonb_build_object('status',row_v.status),jsonb_build_object('status',next_v,'result',d->'result'),why); result:=stock_raw(uid);
  ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发'); END CASE;
 END CASE; RETURN result;
END $$;

CREATE OR REPLACE FUNCTION stock_count(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE target uuid:=(p->>'id')::uuid; sid uuid; s stocktake_sessions; r stocktakes; unit_v units; expected stocktake_session_units; scope_v jsonb; result_v jsonb; rows_v jsonb; matched jsonb; missing jsonb; changed jsonb; extras jsonb; code_v text; message_v text; scanresult text; key_v text; digest text; state text; total_v int; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'sessions.list' THEN
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(stock_session(id) ORDER BY created_at DESC,id),'[]'),'total',(SELECT count(*) FROM stocktake_sessions WHERE status=coalesce(d->>'status','open'))) INTO result_v FROM (SELECT * FROM stocktake_sessions WHERE status=coalesce(d->>'status','open') ORDER BY created_at DESC,id LIMIT lim OFFSET off_v) x;
 WHEN 'sessions.create' THEN
  key_v:=stock_text(d->'requestKey','提交标识',80); digest:=md5((d-'requestKey')::text);
  PERFORM pg_advisory_xact_lock(hashtextextended('stocktake:'||key_v,0));
  SELECT * INTO s FROM stocktake_sessions WHERE request_key=key_v;
  IF FOUND THEN IF s.request_hash<>digest THEN PERFORM stock_error('P0409','提交标识已用于其他内容，请保留原内容重试'); END IF; RETURN stock_session(s.id); END IF;
  scope_v:=jsonb_build_object('statuses',d->'statuses','modelId',d->'modelId','category',d->'category','modelName','','categoryLabel','');
  IF d->>'modelId' IS NOT NULL THEN SELECT scope_v||jsonb_build_object('modelName',name) INTO scope_v FROM models WHERE id=d->>'modelId'; IF NOT FOUND THEN PERFORM stock_error('P0400','盘点型号不存在'); END IF; END IF;
  IF d->>'category' IS NOT NULL THEN SELECT scope_v||jsonb_build_object('categoryLabel',label) INTO scope_v FROM categories WHERE id=d->>'category'; IF NOT FOUND THEN PERFORM stock_error('P0400','盘点分类不存在'); END IF; END IF;
  sid:=gen_random_uuid(); INSERT INTO stocktake_sessions(id,operator_id,scope,note,request_key,request_hash) VALUES(sid,(u->>'id')::uuid,scope_v,stock_text(d->'note','盘点说明',200,true),key_v,digest);
  INSERT INTO stocktake_session_units(session_id,unit_id,start_status) SELECT sid,un.id,un.status FROM units un JOIN models m ON m.id=un.model_id WHERE scope_v->'statuses' ? un.status AND (d->>'modelId' IS NULL OR un.model_id=d->>'modelId') AND (d->>'category' IS NULL OR m.category_id=d->>'category');
  result_v:=stock_session(sid); PERFORM stock_audit(u,req,'开始盘点',sid::text,NULL,scope_v||jsonb_build_object('expectedCount',result_v->'expectedCount'));
 WHEN 'records.list' THEN
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(stock_record(id,false) ORDER BY created_at DESC,id),'[]'),'total',(SELECT count(*) FROM stocktakes)) INTO result_v FROM (SELECT * FROM stocktakes ORDER BY created_at DESC,id LIMIT lim OFFSET off_v) x;
 WHEN 'records.get','records.resolve' THEN
  SELECT * INTO r FROM stocktakes WHERE id=target; IF NOT FOUND THEN PERFORM stock_error('P0404','盘点记录不存在'); END IF;
  IF action='records.resolve' THEN
   key_v:=stock_text(d->'target','差异项',80);
   IF d->>'type'='unit' AND NOT r.result->'missingIds' ? key_v THEN PERFORM stock_error('P0400','该设备不是本次盘点的缺失设备'); END IF;
   IF d->>'type'='extra' AND (key_v !~ '^\d+$' OR r.result->'extra'->key_v::int IS NULL) THEN PERFORM stock_error('P0400','盘点异常项不存在'); END IF;
   INSERT INTO stocktake_resolutions(id,stocktake_id,target_type,target,resolution,note,operator_id) VALUES(gen_random_uuid(),target,d->>'type',key_v,d->>'resolution',stock_text(d->'note','处理说明',200),(u->>'id')::uuid);
   PERFORM stock_audit(u,req,'处理盘点差异',target::text,NULL,d,stock_text(d->'note','处理说明',200));
  END IF; result_v:=stock_record(target);
 ELSE
  IF action IN ('sessions.scan','sessions.close','sessions.cancel') THEN SELECT * INTO s FROM stocktake_sessions WHERE id=target FOR UPDATE; ELSE SELECT * INTO s FROM stocktake_sessions WHERE id=target FOR SHARE; END IF;
  IF NOT FOUND THEN PERFORM stock_error('P0404','盘点单不存在'); END IF;
  CASE action
  WHEN 'sessions.get' THEN result_v:=stock_session(target);
  WHEN 'sessions.units' THEN
   state:=coalesce(d->>'state','pending');
   IF state='extra' THEN
    SELECT jsonb_build_object('rows',coalesce(jsonb_agg(jsonb_build_object('id',e.id,'code',e.code,'unitId',e.unit_id,'name',coalesce(m.name,''),'reason',e.reason,'scannedAt',e.scanned_at,'scanner',stock_operator(e.scanned_by)) ORDER BY e.scanned_at DESC,e.id),'[]'),'total',(SELECT count(*) FROM stocktake_extras WHERE session_id=target)) INTO result_v FROM (SELECT * FROM stocktake_extras WHERE session_id=target ORDER BY scanned_at DESC,id LIMIT lim OFFSET off_v) e LEFT JOIN units un ON un.id=e.unit_id LEFT JOIN models m ON m.id=un.model_id;
   ELSE
    SELECT jsonb_build_object('rows',coalesce(jsonb_agg(stock_raw(x.unit_id)||jsonb_build_object('scannedAt',x.scanned_at,'scanner',stock_operator(x.scanned_by)) ORDER BY x.ord),'[]'),'total',(SELECT count(*) FROM stocktake_session_units WHERE session_id=target AND ((scanned_at IS NULL)=(state='pending')))) INTO result_v FROM (SELECT su.*,row_number() OVER(ORDER BY CASE WHEN state='pending' THEN m.name END,CASE WHEN state='scanned' THEN su.scanned_at END DESC,su.unit_id) ord FROM stocktake_session_units su JOIN units un ON un.id=su.unit_id JOIN models m ON m.id=un.model_id WHERE su.session_id=target AND ((su.scanned_at IS NULL)=(state='pending')) ORDER BY ord LIMIT lim OFFSET off_v) x;
   END IF;
  WHEN 'sessions.scan' THEN
   IF s.status<>'open' THEN PERFORM stock_error('P0409','盘点单已结束，不能继续扫码'); END IF;
   code_v:=stock_text(d->'code','设备编号或串码',80); SELECT * INTO unit_v FROM units WHERE id=stock_find_unit(code_v);
   SELECT * INTO expected FROM stocktake_session_units WHERE session_id=target AND unit_id=unit_v.id;
   IF FOUND THEN
    IF expected.scanned_at IS NOT NULL THEN scanresult:='duplicate'; message_v:='这台已经盘过'; ELSE UPDATE stocktake_session_units SET scanned_by=(u->>'id')::uuid,scanned_at=now(),scanned_code=code_v WHERE session_id=target AND unit_id=unit_v.id; scanresult:='matched'; message_v:='已盘到'; END IF;
   ELSIF EXISTS(SELECT 1 FROM stocktake_extras WHERE session_id=target AND (code=code_v OR unit_id=unit_v.id)) THEN scanresult:='duplicate'; message_v:='已记为异常，不重复登记';
   ELSE
    scanresult:=CASE WHEN unit_v.id IS NULL THEN 'unknown' ELSE 'out_of_scope' END;
    message_v:=CASE WHEN unit_v.id IS NULL THEN '系统里没有这台设备' WHEN s.scope->'statuses' ? unit_v.status AND (s.scope->>'modelId' IS NULL OR s.scope->>'modelId'=unit_v.model_id) AND (s.scope->>'category' IS NULL OR s.scope->>'category'=(SELECT category_id FROM models WHERE id=unit_v.model_id)) THEN '开盘后才进入盘点范围，不在开盘清单' ELSE unit_v.status||'，不在本次盘点范围' END;
    INSERT INTO stocktake_extras(id,session_id,code,unit_id,unit_status,reason,scanned_by) VALUES(gen_random_uuid(),target,code_v,unit_v.id,unit_v.status,message_v,(u->>'id')::uuid);
   END IF;
   result_v:=jsonb_build_object('result',scanresult,'message',message_v,'code',code_v,'unit',stock_raw(unit_v.id))||(stock_session(target)-'id'-'status'-'scope'-'note'-'operator'-'createdAt'-'closedAt'-'stocktakeId'-'cancelReason');
  WHEN 'sessions.close' THEN
   IF s.status='closed' THEN RETURN stock_record(s.stocktake_id); END IF; IF s.status<>'open' THEN PERFORM stock_error('P0409','盘点单已作废'); END IF;
   SELECT coalesce(jsonb_agg(su.unit_id ORDER BY m.name,un.id) FILTER(WHERE su.scanned_at IS NOT NULL),'[]'),coalesce(jsonb_agg(su.unit_id ORDER BY m.name,un.id) FILTER(WHERE su.scanned_at IS NULL AND s.scope->'statuses' ? un.status),'[]'),coalesce(jsonb_agg(jsonb_build_object('unitId',su.unit_id,'from',su.start_status,'to',un.status) ORDER BY m.name,un.id) FILTER(WHERE su.scanned_at IS NULL AND NOT s.scope->'statuses' ? un.status),'[]'),count(*) INTO matched,missing,changed,total_v FROM stocktake_session_units su JOIN units un ON un.id=su.unit_id JOIN models m ON m.id=un.model_id WHERE su.session_id=target;
   SELECT coalesce(jsonb_agg(jsonb_build_object('code',code,'unitId',unit_id,'unitStatus',unit_status,'reason',reason) ORDER BY scanned_at,id),'[]') INTO extras FROM stocktake_extras WHERE session_id=target;
   result_v:=jsonb_build_object('expectedCount',total_v,'scannedCount',jsonb_array_length(matched)+jsonb_array_length(extras),'matched',jsonb_array_length(matched),'matchedIds',matched,'missingIds',missing,'changed',changed,'extra',extras);
   sid:=gen_random_uuid(); INSERT INTO stocktakes(id,operator_id,scope,result,session_id) VALUES(sid,(u->>'id')::uuid,s.scope||jsonb_build_object('note',s.note,'startedAt',s.created_at),result_v,target);
   UPDATE stocktake_sessions SET status='closed',stocktake_id=sid,closed_by=(u->>'id')::uuid,closed_at=now() WHERE id=target;
   PERFORM stock_audit(u,req,'结束盘点',sid::text,NULL,result_v||jsonb_build_object('sessionId',target)); result_v:=stock_record(sid);
  WHEN 'sessions.cancel' THEN
   IF s.status<>'open' THEN PERFORM stock_error('P0409','只能作废进行中的盘点单'); END IF;
   key_v:=stock_text(d->'reason','作废原因',200); UPDATE stocktake_sessions SET status='cancelled',cancel_reason=key_v,closed_by=(u->>'id')::uuid,closed_at=now() WHERE id=target;
   PERFORM stock_audit(u,req,'作废盘点',target::text,NULL,NULL,key_v); result_v:=stock_session(target);
  ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发'); END CASE;
 END CASE; RETURN result_v;
END $$;

CREATE OR REPLACE FUNCTION stock_sale(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE unit_v units; x jsonb; plan jsonb:='[]'; total numeric:=0; costs numeric:=0; price_v numeric; base_v numeric; uid uuid; oid uuid:=gen_random_uuid(); old sales_orders; key_v text; digest text:=md5(d::text); why text:=''; changed boolean:=false; fid uuid; files_v jsonb; result_v jsonb; referral customer_requests; request_state customer_request_states; agent_order_v agent_orders; request_v uuid:=nullif(d->>'customerRequestId','')::uuid; earning_v uuid;
BEGIN

 IF action='sales.lookup' THEN
  SELECT * INTO unit_v FROM units WHERE id=stock_find_unit(d->>'code');
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
  IF NOT FOUND OR request_state.request_id IS NULL THEN PERFORM stock_error('P0404','咨询预约不存在'); END IF;
  IF request_state.status NOT IN ('new','contacted','confirmed') THEN PERFORM stock_error('P0409','咨询预约已结束或取消'); END IF;
  IF EXISTS(SELECT 1 FROM sales_attributions WHERE customer_request_id=request_v) THEN PERFORM stock_error('P0409','此意向已关联成交'); END IF;
  IF referral.kind='order' THEN PERFORM agent_sale_order(request_v,referral.unit_id,true); END IF;
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
  IF referral.kind='order' THEN
  agent_order_v:=agent_sale_order(request_v,referral.unit_id,true);
  DELETE FROM agent_unit_locks WHERE unit_id=agent_order_v.unit_id AND request_id=request_v;
  UPDATE agent_order_states SET status='sold',sale_order_id=oid,updated_at=now() WHERE request_id=request_v;
  earning_v:=gen_random_uuid();INSERT INTO agent_earnings(id,agent_id,request_id,sale_order_id,kind,amount) VALUES(earning_v,agent_order_v.agent_id,request_v,oid,'earning',agent_order_v.markup);INSERT INTO agent_earning_states(earning_id) VALUES(earning_v);
  PERFORM stock_audit(u,req,'代理订单成交记收益',request_v::text,NULL,jsonb_build_object('saleOrderId',oid,'markup',agent_order_v.markup,'agentId',agent_order_v.agent_id));
  END IF;
  INSERT INTO sales_attributions(order_id,customer_request_id,customer_id,source,share_id,share_owner_id) VALUES(oid,referral.id,referral.owner_id,referral.source,referral.share_id,referral.share_owner_id);
  UPDATE customer_request_states SET status=CASE WHEN referral.kind='appointment' THEN 'completed' ELSE 'closed' END,version=version+1,updated_at=now() WHERE request_id=request_v;
  INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES(gen_random_uuid(),request_v,(u->>'id')::uuid,'staff',request_state.status,CASE WHEN referral.kind='appointment' THEN 'completed' ELSE 'closed' END,request_state.version+1,'已登记销售单 '||oid::text,'sale_'||oid::text,encode(sha256(convert_to('sale_'||oid::text,'UTF8')),'hex'));

 END IF;
 PERFORM stock_audit(u,req,'销售收款出库',oid::text,NULL,jsonb_build_object('unitIds',(SELECT jsonb_agg(value->'unitId') FROM jsonb_array_elements(plan)),'amount',total,'payMethod',d->'payMethod'),why);
 RETURN stock_sale_raw(oid);
END $$;

CREATE OR REPLACE FUNCTION api_loans(p_action text,p_id uuid,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
 d jsonb:=p_data; actor uuid:=(p_user->>'id')::uuid; oid uuid:=p_id; o loan_orders; st loan_states;
 key_v text; sig text; why text; old_hash text; inp jsonb; x jsonb; dev jsonb; proof jsonb:='[]'; part jsonb; data_v jsonb:='[]';
 uid uuid; iid uuid; eid uuid:=gen_random_uuid(); u units; ident unit_identifiers; prior_uid uuid;
 imei_v text; imei2_v text; mode_v text; serial_v text; code_v text; form jsonb; model_name text; seen text[]:='{}'; typ text; next_v text;
 li loan_items; ls loan_item_states; cnt int; ledger_id bigint; today_v date:=(now() AT TIME ZONE 'Asia/Shanghai')::date; result jsonb; total_v bigint;
 closed_flags jsonb:='{"showInShop":false,"sharePeer":false,"shareAgent":false}';
BEGIN
 IF p_user->>'staffNo' IS NULL OR NOT coalesce(p_user->'permissions','[]') ? 'loan:manage' THEN PERFORM stock_error('P0403','仅有借还权限的员工可管理借还'); END IF;
 IF p_action='options' THEN RETURN '{"financialPolicy":"none","supportsPayments":false,"borrowedSalesEnabled":false,"maxItems":50}'::jsonb; END IF;
 IF p_action='get' THEN result:=loan_raw(oid); IF result IS NULL THEN PERFORM stock_error('P0404','借还单不存在'); END IF; RETURN result; END IF;
 IF p_action='list' THEN
  WITH matches AS(SELECT ord.id,ord.created_at FROM loan_orders ord JOIN loan_states s ON s.order_id=ord.id WHERE
   (nullif(d->>'type','') IS NULL OR ord.type=d->>'type') AND
   (nullif(d->>'status','') IS NULL OR (d->>'status'='overdue' AND s.status='active' AND ord.due_date<today_v) OR
    (d->>'status'='returned_recheck' AND EXISTS(SELECT 1 FROM loan_items i JOIN loan_item_states item_state ON item_state.item_id=i.id WHERE i.order_id=ord.id AND item_state.status='returned_recheck')) OR (d->>'status' IN ('active','closed') AND s.status=d->>'status')) AND
   (nullif(d->>'keyword','') IS NULL OR ord.no ILIKE '%'||(d->>'keyword')||'%' OR ord.counterparty ILIKE '%'||(d->>'keyword')||'%' OR EXISTS(SELECT 1 FROM loan_items i JOIN units unit_row ON unit_row.id=i.unit_id WHERE i.order_id=ord.id AND (unit_row.imei1=d->>'keyword' OR unit_row.imei2=d->>'keyword' OR unit_row.serial_no=upper(d->>'keyword'))))
  ), paged AS(SELECT * FROM matches ORDER BY created_at DESC,id LIMIT (d->>'pageSize')::int OFFSET (d->>'offset')::int)
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'rows',coalesce(jsonb_agg(loan_raw(paged.id) ORDER BY created_at DESC,id),'[]')) INTO result FROM paged;
  RETURN result;
 END IF;
 key_v:=stock_text(d->'requestKey','提交标识',100); sig:=d->>'signature'; why:=stock_text(d->'reason','处理说明',500);
 IF sig IS NULL OR sig !~ '^[a-f0-9]{64}$' THEN PERFORM stock_error('P0400','请求摘要无效'); END IF;
 IF p_action='create' THEN
  -- 同一员工同一提交标识串行化；重试在任何库存变动之前直接返回原单。
  PERFORM pg_advisory_xact_lock(hashtextextended('loan:'||actor::text||':'||key_v,0));
  SELECT * INTO o FROM loan_orders WHERE creator_id=actor AND request_key=key_v;
  IF FOUND THEN IF o.request_hash<>sig THEN PERFORM stock_error('P0409','提交标识内容冲突'); END IF; RETURN loan_raw(o.id); END IF;
  typ:=d->>'type'; inp:=CASE WHEN typ='loan_out' THEN d->'unitIds' ELSE d->'devices' END;
  IF typ NOT IN ('loan_out','borrow_in') OR inp IS NULL OR jsonb_typeof(inp)<>'array' OR jsonb_array_length(inp) NOT BETWEEN 1 AND 50 THEN PERFORM stock_error('P0400','每单须有1～50台且类型与设备匹配'); END IF;
  proof:=loan_proofs(d->'photos',p_user); oid:=gen_random_uuid();
  INSERT INTO loan_orders(id,no,type,counterparty,phone,due_date,remark,creator_id,request_key,request_hash) VALUES(oid,'LN'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS')||left(oid::text,8),typ,stock_text(d->'counterparty','对方',120),stock_text(d->'phone','联系电话',30),(d->>'dueAt')::date,stock_text(d->'remark','备注',2000,true),actor,key_v,sig) RETURNING * INTO o;
  INSERT INTO loan_states(order_id) VALUES(oid) RETURNING * INTO st;
  -- 先按设备/串码排序，所有多台写入同一事务，任意失败全单回滚。
  FOR dev IN SELECT value FROM jsonb_array_elements(inp) ORDER BY CASE WHEN typ='loan_out' THEN value#>>'{}' ELSE coalesce(nullif(value->>'imei1',''),value->>'serialNo') END LOOP
   IF typ='loan_out' THEN
    IF NOT coalesce(p_user->'permissions','[]') ? 'inventory:view' THEN PERFORM stock_error('P0403','无权限查看库存'); END IF;
    uid:=(dev#>>'{}')::uuid; IF uid::text=ANY(seen) THEN PERFORM stock_error('P0400','设备重复'); END IF; seen:=array_append(seen,uid::text);
    SELECT * INTO u FROM units WHERE id=uid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
    IF u.status<>'in_stock' OR u.ownership<>'own' THEN PERFORM stock_error('P0409','仅本店自有可售设备可以出借'); END IF;
    INSERT INTO loan_active_units(unit_id,order_id) VALUES(uid,oid);
    UPDATE units SET status='loaned_out',share_flags=closed_flags WHERE id=uid;
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,u.status,'loaned_out','loan_out',oid::text,actor,why);
   ELSE
    mode_v:=stock_unit_mode(dev->>'modelId'); serial_v:=NULL;
    IF mode_v='imei' THEN imei_v:=stock_imei(dev->>'imei1'); imei2_v:=nullif(dev->>'imei2','');
    ELSE
     -- 非手机借入必须登记序列号，用于归还时核对是同一台设备。
     imei_v:=NULL; imei2_v:=NULL; serial_v:=stock_serial(stock_text(dev->'serialNo','序列号',40));
     IF serial_v=ANY(seen) THEN PERFORM stock_error('P0400','借入序列号重复'); END IF; seen:=array_append(seen,serial_v);
     PERFORM pg_advisory_xact_lock(hashtextextended('serial:'||(dev->>'modelId')||':'||serial_v,0));
    END IF;
    FOR code_v IN SELECT value FROM unnest(ARRAY[imei_v,imei2_v]) value WHERE value IS NOT NULL ORDER BY value LOOP
     PERFORM stock_imei(code_v); IF code_v=ANY(seen) THEN PERFORM stock_error('P0400','借入串码无效或重复'); END IF; seen:=array_append(seen,code_v);
     PERFORM pg_advisory_xact_lock(hashtextextended('imei:'||code_v,0));
     PERFORM 1 FROM repair_external_slots WHERE identifier=code_v FOR SHARE; IF FOUND THEN PERFORM stock_error('P0409','设备正在外部维修'); END IF;
    END LOOP;
    SELECT name INTO model_name FROM models WHERE id=dev->>'modelId'; IF NOT FOUND THEN PERFORM stock_error('P0400','型号不存在'); END IF;
    -- 原借入设备只可在已归还且型号/主副串码完全一致时再借入，历史快照不变。
    prior_uid:=NULL; cnt:=0;
    IF serial_v IS NOT NULL THEN SELECT id INTO prior_uid FROM units WHERE model_id=dev->>'modelId' AND serial_no=serial_v FOR UPDATE; IF FOUND THEN cnt:=1; END IF; END IF;
    FOR code_v IN SELECT value FROM unnest(ARRAY[imei_v,imei2_v]) value WHERE value IS NOT NULL ORDER BY value LOOP
     SELECT * INTO ident FROM unit_identifiers WHERE imei=code_v FOR UPDATE;
     IF FOUND THEN
      cnt:=cnt+1; IF ident.unit_id IS NULL OR (prior_uid IS NOT NULL AND prior_uid<>ident.unit_id) THEN PERFORM stock_error('P0409','串码已用于其他业务'); END IF; prior_uid:=ident.unit_id;
     END IF;
    END LOOP;
    IF cnt>0 THEN
     IF cnt<>(CASE WHEN imei2_v IS NULL THEN 1 ELSE 2 END) THEN PERFORM stock_error('P0409','串码已用于其他业务'); END IF;
     SELECT * INTO u FROM units WHERE id=prior_uid FOR UPDATE;
     IF u.ownership<>'borrowed' OR u.status<>'returned' OR u.model_id<>dev->>'modelId' OR u.imei1<>imei_v OR coalesce(u.imei2,'')<>coalesce(imei2_v,'') THEN PERFORM stock_error('P0409','该设备不是已归还的相同借入设备'); END IF;
     uid:=u.id; UPDATE units SET status='borrowed_in',share_flags=closed_flags,internal_note=dev->>'description' WHERE id=uid;
    ELSE
     uid:=gen_random_uuid(); form:=stock_form(dev->>'modelId');
     INSERT INTO units(id,model_id,imei1,imei2,serial_no,status,ownership,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,inbound_operator_id) VALUES(uid,dev->>'modelId',imei_v,imei2_v,serial_v,'borrowed_in','borrowed',coalesce(dev->>'condition','used'),'{}',form-'modelId'-'modelName'-'specs',0,0,0,0,closed_flags,'','',coalesce(dev->>'description',''),actor) RETURNING * INTO u;
     IF imei_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei_v,uid,'imei1'); END IF;
     IF imei2_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei2_v,uid,'imei2'); END IF;
    END IF;
    INSERT INTO loan_active_units(unit_id,order_id) VALUES(uid,oid);
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,CASE WHEN u.status='returned' THEN 'returned' END,'borrowed_in','borrow_in',oid::text,actor,why);
   END IF;
   SELECT name INTO model_name FROM models WHERE id=u.model_id;
   iid:=gen_random_uuid();
   INSERT INTO loan_items(id,order_id,unit_id,snapshot) VALUES(iid,oid,uid,jsonb_build_object('modelId',u.model_id,'name',model_name,'imei1',u.imei1,'imei2',coalesce(u.imei2,''),'serialNo',u.serial_no));
   INSERT INTO loan_item_states(item_id) VALUES(iid);
  END LOOP;
  data_v:=jsonb_build_object('count',jsonb_array_length(inp),'type',typ);
 ELSE
  SELECT * INTO st FROM loan_states WHERE order_id=oid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','借还单不存在'); END IF;
  SELECT * INTO o FROM loan_orders WHERE id=oid;
  SELECT request_hash INTO old_hash FROM loan_events WHERE order_id=oid AND request_key=key_v;
  IF FOUND THEN IF old_hash<>sig THEN PERFORM stock_error('P0409','操作标识内容冲突'); END IF; RETURN loan_raw(oid); END IF;
  IF st.version<>(d->>'version')::int OR st.status='closed' THEN PERFORM stock_error('P0409','借还单已更新或已完结'); END IF;
  inp:=CASE WHEN p_action='return' THEN d->'items' ELSE d->'unitIds' END;
  IF p_action NOT IN ('return','recheck') OR inp IS NULL OR jsonb_typeof(inp)<>'array' OR jsonb_array_length(inp) NOT BETWEEN 1 AND 50 THEN PERFORM stock_error('P0400','请选择逐台处理设备'); END IF;
  IF p_action='recheck' AND o.type<>'loan_out' THEN PERFORM stock_error('P0400','请选择已实际通过库存复检的设备'); END IF;
  -- 全部凭证按全局顺序预锁，随后逐台归还，避免同一次提交文件锁顺序不一致。
  IF p_action='return' THEN PERFORM 1 FROM files WHERE id IN(SELECT (f->>'fileId')::uuid FROM jsonb_array_elements(inp) item CROSS JOIN LATERAL jsonb_array_elements(item->'photos') f) ORDER BY id FOR UPDATE; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(inp) ORDER BY CASE WHEN p_action='return' THEN value->>'unitId' ELSE value#>>'{}' END LOOP
   uid:=CASE WHEN p_action='return' THEN (x->>'unitId')::uuid ELSE (x#>>'{}')::uuid END;
   IF uid::text=ANY(seen) THEN PERFORM stock_error('P0400','设备重复'); END IF; seen:=array_append(seen,uid::text);
   SELECT * INTO li FROM loan_items WHERE order_id=oid AND unit_id=uid;
   IF NOT FOUND THEN PERFORM stock_error('P0409','设备不在本单待处理列表'); END IF;
   SELECT * INTO ls FROM loan_item_states WHERE item_id=li.id;
   IF (p_action='return' AND ls.status<>'active') OR (p_action='recheck' AND ls.status<>'returned_recheck') THEN PERFORM stock_error('P0409','设备不在本单待处理列表'); END IF;
   SELECT * INTO u FROM units WHERE id=uid FOR UPDATE;
   IF p_action='return' THEN
    part:=loan_proofs(x->'photos',p_user,true); proof:=proof||part;
    typ:=CASE WHEN o.type='loan_out' THEN 'loaned_out' ELSE 'borrowed_in' END; next_v:=CASE WHEN o.type='loan_out' THEN 'recheck' ELSE 'returned' END;
    IF u.status<>typ THEN PERFORM stock_error('P0409','设备状态已变化，不能登记归还'); END IF;
    SELECT count(*) INTO cnt FROM unit_inspections WHERE unit_id=uid;
    UPDATE units SET status=next_v,share_flags=closed_flags WHERE id=uid;
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,typ,next_v,CASE WHEN o.type='loan_out' THEN 'loan_return' ELSE 'borrow_return' END,oid::text,actor,why) RETURNING id INTO ledger_id;
    UPDATE loan_item_states SET status=CASE WHEN o.type='loan_out' THEN 'returned_recheck' ELSE 'closed' END,returned_at=now(),inspection_version=cnt,return_ledger_id=ledger_id WHERE item_id=li.id;
    IF o.type='borrow_in' THEN DELETE FROM loan_active_units WHERE unit_id=uid AND order_id=oid; END IF;
    data_v:=data_v||jsonb_build_array(jsonb_build_object('unitId',uid,'condition',stock_text(x->'condition','归还外观和功能结论',2000),'damage',stock_text(x->'damage','损坏描述',2000,true),'next',next_v));
   ELSE
    IF ls.return_ledger_id IS NULL OR NOT EXISTS(SELECT 1 FROM inventory_ledger l JOIN unit_inspections i ON i.id::text=l.doc_id WHERE l.unit_id=uid AND l.id>ls.return_ledger_id AND l.doc_type='recheck' AND l.to_status='in_stock' AND i.result='pass') THEN PERFORM stock_error('P0409','须先在库存复检页逐项检查并实际通过，不能一键恢复可售'); END IF;
    UPDATE loan_item_states SET status='closed' WHERE item_id=li.id;
    DELETE FROM loan_active_units WHERE unit_id=uid AND order_id=oid;
    data_v:=data_v||jsonb_build_array(uid);
   END IF;
  END LOOP;
  SELECT CASE WHEN bool_and(s.status='closed') THEN 'closed' WHEN bool_or(s.status='active') THEN 'active' ELSE 'returned_recheck' END INTO next_v FROM loan_items i JOIN loan_item_states s ON s.item_id=i.id WHERE i.order_id=oid;
  UPDATE loan_states SET status=next_v,version=version+1,updated_at=now() WHERE order_id=oid RETURNING * INTO st;
  data_v:=jsonb_build_object(CASE WHEN p_action='return' THEN 'items' ELSE 'unitIds' END,data_v);
 END IF;
 INSERT INTO loan_events(id,order_id,actor_id,action,version,reason,data,request_key,request_hash) VALUES(eid,oid,actor,p_action,st.version,why,data_v,key_v,sig);
 INSERT INTO loan_files(order_id,file_id,event_id) SELECT oid,value::uuid,eid FROM jsonb_array_elements_text(proof) GROUP BY value;
 PERFORM stock_audit(p_user,p_request_id,'借还:'||p_action,oid::text,NULL,jsonb_build_object('type',o.type,'status',st.status,'version',st.version),why);
 RETURN loan_raw(oid);
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','设备已被其他借还或串码已占用');
 WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR check_violation OR not_null_violation THEN PERFORM stock_error('P0400','借还参数无效');
END $$;

CREATE OR REPLACE FUNCTION api_shop_units(p jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_flag text := p ->> 'flag';
  v_aud text := p ->> 'audience';
  v_peer boolean := (p ->> 'audience') = 'peer';
  v_total bigint;
  v_rows jsonb;
BEGIN
  IF v_flag NOT IN ('showInShop', 'sharePeer') OR v_aud NOT IN ('customer', 'peer') THEN
    RAISE EXCEPTION '渠道参数无效' USING ERRCODE = 'P0400';
  END IF;

  WITH base AS (
    SELECT u.*, m.name, m.brand, m.category_id,
           CASE WHEN v_peer THEN u.wholesale ELSE u.retail END AS price
    FROM units u JOIN models m ON m.id = u.model_id
    WHERE u.status = 'in_stock'
      AND (u.share_flags ->> v_flag)::boolean IS TRUE
      AND (p ->> 'brand' IS NULL OR p ->> 'brand' = 'all' OR m.brand = p ->> 'brand')
      AND (p ->> 'category' IS NULL OR m.category_id = p ->> 'category')
      -- 首页品牌入口：由云函数展开别名，按品牌值或品牌名匹配（不区分大小写）
      AND (p -> 'brandNames' IS NULL OR lower(m.brand) IN (SELECT jsonb_array_elements_text(p -> 'brandNames'))
           OR lower(m.brand_label) IN (SELECT jsonb_array_elements_text(p -> 'brandNames')))
      AND (p -> 'excludeBrandNames' IS NULL OR NOT (lower(m.brand) IN (SELECT jsonb_array_elements_text(p -> 'excludeBrandNames'))
           OR lower(m.brand_label) IN (SELECT jsonb_array_elements_text(p -> 'excludeBrandNames'))))
      AND (p ->> 'modelId' IS NULL OR u.model_id = p ->> 'modelId')
      AND (p ->> 'condition' IS NULL OR u.condition_type = p ->> 'condition')
      -- MySQL 原实现默认不区分大小写，这里用 ILIKE 保持一致
      AND (p ->> 'keyword' IS NULL
           OR m.name ILIKE '%' || (p ->> 'keyword') || '%'
           OR u.attributes ->> 'storage' ILIKE '%' || (p ->> 'keyword') || '%'
           OR u.attributes ->> 'color' ILIKE '%' || (p ->> 'keyword') || '%')
  ), folded AS (
    -- 按数量入库的同批设备只显示一张卡片：取最早入库的一件作代表，附带剩余件数
    SELECT b.*, count(*) OVER (PARTITION BY coalesce(b.lot_id::text, b.id::text)) AS lot_count,
           row_number() OVER (PARTITION BY coalesce(b.lot_id::text, b.id::text) ORDER BY b.created_at, b.id) AS lot_rank
    FROM base b
  ), filtered AS (
    SELECT * FROM folded b
    WHERE b.lot_rank = 1 AND (p ->> 'priceMin' IS NULL OR b.price >= (p ->> 'priceMin')::numeric)
      AND (p ->> 'priceMax' IS NULL OR b.price <= (p ->> 'priceMax')::numeric)
      AND (p ->> 'grade' IS NULL OR (shop_field_public(b.template_snapshot, 'grade', v_aud)
           AND b.attributes ->> 'grade' = p ->> 'grade'))
      AND (p ->> 'batteryMin' IS NULL OR (shop_field_public(b.template_snapshot, 'battery', v_aud)
           AND replace(b.attributes ->> 'battery', '%', '') ~ '^[0-9]+([.][0-9]+)?$'
           AND replace(b.attributes ->> 'battery', '%', '')::numeric >= (p ->> 'batteryMin')::numeric))
  ), ordered AS (
    SELECT f.*, row_number() OVER (ORDER BY
      CASE WHEN p ->> 'sort' = 'price_asc' THEN f.price END ASC,
      CASE WHEN p ->> 'sort' = 'price_desc' THEN f.price END DESC,
      f.created_at DESC, f.id) AS ord
    FROM filtered f
  ), x AS (
    SELECT * FROM ordered ORDER BY ord
    LIMIT (p ->> 'limit')::int OFFSET (p ->> 'offset')::int
  )
  SELECT (SELECT count(*) FROM filtered),
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', x.id, 'model_id', x.model_id, 'name', x.name, 'brand', x.brand,
           'category_id', x.category_id, 'condition_type', x.condition_type,
           'attributes', x.attributes, 'template_snapshot', x.template_snapshot,
           'price', x.price,
           'attached', COALESCE((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position)
             FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=x.id AND f.scope='public'
             AND (uf.field_key='publicImages' OR shop_field_public(x.template_snapshot,uf.field_key,v_aud))), '[]'::jsonb),
           'desc', CASE WHEN v_peer THEN x.peer_desc ELSE x.customer_desc END,
           'imei_masked', left(x.imei1, 2) || '****' || right(x.imei1, 4),
           'serial_masked', stock_mask_serial(x.serial_no),
           'lot_count', CASE WHEN x.lot_id IS NULL THEN NULL ELSE x.lot_count END)
         ORDER BY x.ord), '[]'::jsonb)
  INTO v_total, v_rows
  FROM x;

  RETURN jsonb_build_object('total', v_total, 'rows', v_rows);
END
$$;

DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('stock_is_imei','stock_serial','stock_mask_serial','stock_identity','stock_find_unit','stock_insert','stock_raw','stock_accept','stock_inventory','stock_count','stock_sale','api_loans','api_shop_units') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
 END LOOP;
END $$;
