-- 消除 PL/pgSQL 局部变量与 unit_identifiers.imei 列名歧义。
CREATE OR REPLACE FUNCTION stock_insert(d jsonb,u jsonb,ctx jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE form jsonb; attrs jsonb:='{}'; f jsonb; supplier suppliers; mid text; sid uuid; uid uuid:=gen_random_uuid(); imei_v text; imei2_v text; status_v text; flags_v jsonb; receipt jsonb; public_v jsonb; item uuid:=(ctx->>'acceptanceItemId')::uuid; reserved uuid:=(ctx->>'reservedItemId')::uuid; k text; values_v jsonb; n int;
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
 imei_v:=stock_imei(stock_text(d->'imei1','IMEI1',15)); imei2_v:=nullif(stock_text(d->'imei2','IMEI2',15,true),'');
 IF imei2_v IS NOT NULL THEN PERFORM stock_imei(imei2_v); IF imei_v=imei2_v THEN PERFORM stock_error('P0400','本次提交存在重复串码'); END IF; END IF;
 IF EXISTS(SELECT 1 FROM repair_external_slots WHERE identifier IN (imei_v,imei2_v)) THEN PERFORM stock_error('P0409','串码正在外部维修中，不能作为本店库存入库'); END IF;
 IF EXISTS(SELECT 1 FROM unit_identifiers WHERE unit_identifiers.imei IN (imei_v,imei2_v) AND NOT (reserved IS NOT NULL AND acceptance_item_id=reserved AND unit_id IS NULL)) THEN PERFORM stock_error('P0409','串码已入库或正在异常验收中'); END IF;
 IF EXISTS(SELECT 1 FROM tac_mappings WHERE tac=left(imei_v,8) AND model_id<>mid) THEN PERFORM stock_error('P0400','串码识别型号与所选型号不一致'); END IF;
 IF coalesce(d->>'condition','used') NOT IN ('used','new') THEN PERFORM stock_error('P0400','设备类型无效'); END IF;
 status_v:=CASE WHEN attrs->>'refurbishment'='正在整备' THEN 'recheck' ELSE 'in_stock' END;
 flags_v:=stock_flags(coalesce(d->'flags','{}')); IF status_v<>'in_stock' THEN flags_v:='{"showInShop":false,"sharePeer":false,"shareAgent":false}'; END IF;
 receipt:=stock_files(d->'receiptImages','internal',u,true,coalesce(ctx->'trustedReceiptIds','[]')); public_v:=stock_files(d->'publicImages','public',u);
 INSERT INTO units(id,model_id,imei1,imei2,status,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,purchase_line_id,acceptance_item_id,inbound_operator_id,supplier_id)
 VALUES(uid,mid,imei_v,imei2_v,status_v,coalesce(d->>'condition','used'),attrs,form-'modelId'-'modelName'-'specs',stock_money(coalesce(ctx->'cost',d->'cost')),stock_money(d->'retail'),stock_money(d->'wholesale'),stock_money(d->'agentBase'),flags_v,stock_text(d->'peerDesc','同行描述',4000,true),stock_text(d->'customerDesc','顾客描述',4000,true),stock_text(d->'internalNote','内部备注',4000,true),(ctx->>'purchaseLineId')::uuid,item,(u->>'id')::uuid,supplier.id);
 FOR k,values_v IN SELECT 'imei1',to_jsonb(imei_v) UNION ALL SELECT 'imei2',to_jsonb(imei2_v) WHERE imei2_v IS NOT NULL LOOP
  IF reserved IS NOT NULL THEN
   UPDATE unit_identifiers SET unit_id=uid WHERE unit_identifiers.imei=values_v#>>'{}' AND acceptance_item_id=reserved AND unit_id IS NULL; GET DIAGNOSTICS n=ROW_COUNT; IF n<>1 THEN PERFORM stock_error('P0409','异常验收串码已变更，请刷新'); END IF;
  ELSE INSERT INTO unit_identifiers(imei,unit_id,acceptance_item_id,slot) VALUES(values_v#>>'{}',uid,item,k); END IF;
 END LOOP;
 FOR k,values_v IN SELECT 'publicImages',public_v UNION ALL SELECT 'receiptImages',receipt UNION ALL SELECT value->>'key',attrs->(value->>'key') FROM jsonb_array_elements(form->'fields') WHERE value->>'type'='image' LOOP
  INSERT INTO unit_files(unit_id,file_id,field_key,position) SELECT uid,(value->>'fileId')::uuid,k,ordinality-1 FROM jsonb_array_elements(values_v) WITH ORDINALITY;
 END LOOP;
 INSERT INTO unit_inspections(id,unit_id,result,attributes,operator_id,reason) VALUES(gen_random_uuid(),uid,'pass',attrs,(u->>'id')::uuid,'首次验收确认');
 INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,CASE WHEN item IS NOT NULL THEN 'accepting' END,status_v,CASE WHEN item IS NULL THEN 'inbound' ELSE 'acceptance' END,coalesce(item,uid)::text,(u->>'id')::uuid,coalesce(ctx->>'reason','已核验型号、串码、机况与凭证'));
 RETURN uid;
END $$;
