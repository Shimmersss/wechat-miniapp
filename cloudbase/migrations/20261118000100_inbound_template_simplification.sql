-- 入库模板一次发布：可选凭证、自定义成色、移除整备；旧设备快照保持不变。
DO $$
DECLARE t record; fields_v jsonb;
BEGIN
 FOR t IN SELECT tp.id,tp.current_version,tv.fields,tv.description_presets FROM templates tp
 JOIN template_versions tv ON tv.template_id=tp.id AND tv.version=tp.current_version
 LOOP
  SELECT coalesce(jsonb_agg(CASE value->>'key'
   WHEN 'receipt' THEN value||'{"required":false}'::jsonb
   WHEN 'grade' THEN value||jsonb_build_object('allowCustom',true,'options',CASE WHEN value->'options' ? '8成新' THEN value->'options' ELSE (value->'options')||'["8成新"]'::jsonb END)
   ELSE value END ORDER BY ordinality),'[]'::jsonb) INTO fields_v
  FROM jsonb_array_elements(t.fields) WITH ORDINALITY WHERE value->>'key'<>'refurbishment';
  IF fields_v=t.fields THEN CONTINUE; END IF;
  INSERT INTO template_versions(template_id,version,fields,description_presets) VALUES(t.id,t.current_version+1,fields_v,t.description_presets);
  UPDATE templates SET current_version=t.current_version+1 WHERE id=t.id;
 END LOOP;
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
  common:=common||jsonb_build_object('inspectionConfirmed',coalesce(common->'inspectionConfirmed','false'::jsonb));
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
  PERFORM stock_audit(u,req,CASE WHEN action='inbound.batch' THEN '批量验收入库' WHEN qty>1 THEN '按数量验收入库' ELSE '单台验收入库' END,ids->>0,NULL,jsonb_build_object('unitIds',ids,'count',jsonb_array_length(ids),'lotId',lot,'inspectionConfirmed',common->'inspectionConfirmed'));
  result:=CASE WHEN action='inbound.single' THEN jsonb_build_object('id',ids->0,'created',jsonb_array_length(ids),'ids',ids,'lotId',lot) ELSE jsonb_build_object('created',jsonb_array_length(ids),'ids',ids) END;
 WHEN 'pricing.presets' THEN SELECT coalesce(jsonb_agg(cost ORDER BY cost),'[]') INTO result FROM (SELECT DISTINCT cost FROM units WHERE model_id=d->>'modelId' ORDER BY cost LIMIT 20) x;
 WHEN 'units.list' THEN
  WITH filtered AS(SELECT u.* FROM units u JOIN models m ON m.id=u.model_id WHERE (NOT d ? 'status' OR u.status=d->>'status') AND (NOT d ? 'modelId' OR u.model_id=d->>'modelId') AND (NOT d ? 'keyword' OR m.name ILIKE '%'||(d->>'keyword')||'%' OR lower(u.attributes->>'ram')=lower(d->>'keyword') OR u.id::text=d->>'keyword' OR u.imei1=d->>'keyword' OR u.imei2=d->>'keyword' OR u.serial_no=upper(d->>'keyword')) AND (NOT d ? 'lotId' OR u.lot_id=(d->>'lotId')::uuid) AND (NOT d ? 'noSerial' OR (u.imei1 IS NULL AND u.serial_no IS NULL)) AND (NOT d ? 'category' OR m.category_id=d->>'category') AND (NOT d ? 'imei' OR u.imei1=d->>'imei' OR u.imei2=d->>'imei') AND (NOT d ? 'ageingOver' OR u.created_at<=now()-make_interval(days=>(d->>'ageingOver')::int)) AND (NOT d ? 'minPrice' OR u.retail>=stock_money(d->'minPrice')) AND (NOT d ? 'maxPrice' OR u.retail<=stock_money(d->'maxPrice'))), rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
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
  WHEN 'units.label' THEN result:=jsonb_build_object('unitId',uid,'name',(SELECT name FROM models WHERE id=row_v.model_id),'storage',row_v.attributes->'storage','ram',row_v.attributes->'ram','grade',row_v.attributes->'grade','retail',row_v.retail,'qrcodeText',uid,'imeiMasked',left(row_v.imei1,2)||'****'||right(row_v.imei1,4),'serialMasked',stock_mask_serial(row_v.serial_no),'identifierMode',stock_unit_mode(row_v.model_id));
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
    attrs:=attrs||jsonb_build_object(k,CASE WHEN f->>'type'='select' AND f->'allowCustom'='true'::jsonb AND jsonb_typeof(x)='string' THEN to_jsonb(trim(x#>>'{}')) ELSE x END);
   END LOOP;
   PERFORM stock_values(row_v.template_snapshot->'fields',attrs);
   iid:=gen_random_uuid(); next_v:=CASE WHEN d->>'result'='pass' THEN 'in_stock' ELSE 'recheck' END;
   INSERT INTO unit_inspections(id,unit_id,result,attributes,operator_id,reason) VALUES(iid,uid,d->>'result',attrs,(u->>'id')::uuid,why);
   UPDATE units SET status=next_v,attributes=attrs WHERE id=uid;
   INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,row_v.status,next_v,'recheck',iid::text,(u->>'id')::uuid,why);
   PERFORM stock_audit(u,req,'库存复检',uid::text,jsonb_build_object('status',row_v.status),jsonb_build_object('status',next_v,'result',d->'result'),why); result:=stock_raw(uid);
  ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发'); END CASE;
 END CASE; RETURN result;
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
  k:=f->>'key'; IF d->'attributes' ? k THEN attrs:=attrs||jsonb_build_object(k,CASE WHEN f->>'type'='select' AND f->'allowCustom'='true'::jsonb AND jsonb_typeof(d->'attributes'->k)='string' THEN to_jsonb(trim(d->'attributes'->>k)) ELSE d->'attributes'->k END); END IF;
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
 status_v:='in_stock';
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

CREATE OR REPLACE FUNCTION stock_values(fields jsonb,attrs jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE f jsonb; v jsonb; typ text; empty_v boolean; num numeric;
BEGIN
 IF jsonb_typeof(attrs) IS DISTINCT FROM 'object' THEN PERFORM stock_error('P0400','请填写模板参数'); END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(fields) LOOP
  v:=attrs->(f->>'key'); typ:=f->>'type';
  empty_v:= v IS NULL OR v='null'::jsonb OR (jsonb_typeof(v)='string' AND trim(v#>>'{}')='') OR v='[]'::jsonb;
  IF empty_v THEN IF (f->>'required')::boolean THEN PERFORM stock_error('P0400','请填写'||(f->>'label')); END IF; CONTINUE; END IF;
  IF typ IN ('text','ref','select','date') AND jsonb_typeof(v)<>'string' THEN PERFORM stock_error('P0400',(f->>'label')||'必须为文本'); END IF;
  IF typ='select' AND NOT (f->'options' @> jsonb_build_array(v)) AND NOT (coalesce(f->'allowCustom'='true'::jsonb,false) AND jsonb_typeof(v)='string' AND length(trim(v#>>'{}')) BETWEEN 1 AND 10) THEN PERFORM stock_error('P0400','请选择有效的'||(f->>'label')); END IF;
  IF typ='number' THEN
   BEGIN num:=(v#>>'{}')::numeric; EXCEPTION WHEN invalid_text_representation THEN PERFORM stock_error('P0400',(f->>'label')||'必须为数字'); END;
   IF jsonb_typeof(v) NOT IN ('string','number') OR num::text IN ('NaN','Infinity','-Infinity') OR num < (f->>'min')::numeric OR num > (f->>'max')::numeric THEN PERFORM stock_error('P0400',(f->>'label')||'超出允许范围'); END IF;
  END IF;
  IF typ='boolean' AND jsonb_typeof(v)<>'boolean' THEN PERFORM stock_error('P0400',(f->>'label')||'必须为是或否'); END IF;
  IF typ='date' THEN
   BEGIN IF (v#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' OR to_char((v#>>'{}')::date,'YYYY-MM-DD')<>v#>>'{}' THEN RAISE invalid_datetime_format; END IF;
   EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN PERFORM stock_error('P0400',(f->>'label')||'应为有效日期'); END;
  END IF;
  IF typ='image' AND jsonb_typeof(v)<>'array' THEN PERFORM stock_error('P0400','请上传'||(f->>'label')); END IF;
 END LOOP;
END $$;
