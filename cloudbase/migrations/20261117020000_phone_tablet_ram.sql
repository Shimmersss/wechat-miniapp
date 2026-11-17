-- 手机和平板新增可选运行内存。发布新模板版本，保留原模板版本和设备快照。
DO $$
DECLARE t record; ram_field jsonb := '{"key":"ram","label":"运行内存","type":"select","options":["1GB","2GB","3GB","4GB","6GB","8GB","10GB","12GB","16GB","18GB","20GB","24GB","32GB","36GB"],"required":false,"visibility":["customer","peer"],"filterable":true}'::jsonb; pos int;
BEGIN
 FOR t IN
  SELECT DISTINCT tp.id, tp.current_version, tv.fields, tv.description_presets
  FROM categories c JOIN templates tp ON tp.id=c.template_id
    JOIN template_versions tv ON tv.template_id=tp.id AND tv.version=tp.current_version
  WHERE c.id IN ('phone','tablet')
 LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(t.fields) AS f WHERE f->>'key'='ram') THEN CONTINUE; END IF;
  SELECT ordinality::int INTO pos FROM jsonb_array_elements(t.fields) WITH ORDINALITY AS f(value,ordinality) WHERE f.value->>'key'='storage';
  INSERT INTO template_versions(template_id,version,fields,description_presets)
  VALUES(t.id,t.current_version+1,CASE WHEN pos IS NULL OR pos=jsonb_array_length(t.fields)
     THEN t.fields || jsonb_build_array(ram_field)
     ELSE jsonb_insert(t.fields,ARRAY[pos::text],ram_field) END,t.description_presets);
  UPDATE templates SET current_version=t.current_version+1 WHERE id=t.id;
 END LOOP;
END $$;


CREATE OR REPLACE FUNCTION stock_form(mid text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE m models; t jsonb; f jsonb; fields jsonb:='[]'; opts jsonb;
BEGIN
 SELECT * INTO m FROM models WHERE id=mid; IF NOT FOUND THEN PERFORM stock_error('P0404','型号不存在'); END IF;
 t:=stock_template(m.template_id);
 FOR f IN SELECT value FROM jsonb_array_elements(t->'fields') LOOP
  opts:=m.specs->(f->>'key');
  IF f->>'key' IN ('storage','color','ram') AND f->>'type'='select' AND jsonb_array_length(coalesce(opts,'[]'))>0 THEN
   f:=f||jsonb_build_object('options',opts); IF f ? 'default' AND NOT opts @> jsonb_build_array(f->'default') THEN f:=f-'default'; END IF;
  END IF; fields:=fields||jsonb_build_array(f);
 END LOOP;
 RETURN t||jsonb_build_object('fields',fields,'modelId',m.id,'modelName',m.name,'specs',coalesce(m.specs,'{"storage":[],"color":[]}'),'identifierMode',stock_unit_mode(m.id));
END $$;

CREATE OR REPLACE FUNCTION stock_catalog(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE tid text:=p->>'id'; target text; cat categories; old models; t templates; base jsonb; result jsonb; spec jsonb; brand_v text; ver int; x text; lbl text; tac_v text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'categories.list' THEN SELECT jsonb_build_object('list',coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label,'templateId',template_id,'identifierMode',identifier_mode,'sortOrder',sort_order,'unitCount',(SELECT count(*) FROM units un JOIN models mm ON mm.id=un.model_id WHERE mm.category_id=c.id)) ORDER BY sort_order,created_at,id),'[]'),'total',count(*),'page',1,'pageSize',count(*)) INTO result FROM categories c;
 WHEN 'categories.create' THEN
  lbl:=stock_text(d->'label','分类名称',50); base:=stock_template(stock_text(d->'copyTemplateId','基础模板',60)); target:=gen_random_uuid()::text; tid:=gen_random_uuid()::text;
  INSERT INTO categories(id,label,identifier_mode) VALUES(target,lbl,stock_identifier_mode(coalesce(d->>'identifierMode','serial'))); INSERT INTO templates(id,name,category_id,current_version) VALUES(tid,lbl||'通用模板',target,1);
  INSERT INTO template_versions(template_id,version,fields,description_presets,operator_id) VALUES(tid,1,(SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb)
    FROM jsonb_array_elements(base->'fields') WITH ORDINALITY WHERE value->>'key'<>'ram'),base->'descriptionPresets',(u->>'id')::uuid);
  UPDATE categories SET template_id=tid WHERE id=target;
  PERFORM stock_audit(u,req,'新增分类',target,NULL,jsonb_build_object('label',lbl,'templateId',tid,'copiedFrom',d->'copyTemplateId'));
  result:=jsonb_build_object('value',target,'label',lbl,'templateId',tid,'identifierMode',coalesce(d->>'identifierMode','serial'),'sortOrder',100);
 WHEN 'categories.update' THEN
  SELECT * INTO cat FROM categories WHERE id=tid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','分类不存在'); END IF;
  lbl:=stock_text(d->'label','分类名称',50); x:=stock_identifier_mode(coalesce(d->>'identifierMode',cat.identifier_mode));
  IF x<>cat.identifier_mode AND EXISTS(SELECT 1 FROM units un JOIN models mm ON mm.id=un.model_id WHERE mm.category_id=tid) THEN PERFORM stock_error('P0409','该分类下已有设备，不能修改串码方式'); END IF;
  UPDATE categories SET label=lbl,identifier_mode=x WHERE id=tid;
  PERFORM stock_audit(u,req,'修改分类',tid,jsonb_build_object('label',cat.label,'identifierMode',cat.identifier_mode),jsonb_build_object('label',lbl,'identifierMode',x)); result:=jsonb_build_object('value',tid,'label',lbl,'templateId',cat.template_id,'identifierMode',x,'sortOrder',cat.sort_order);
 WHEN 'models.list' THEN SELECT coalesce(jsonb_agg(stock_model(id,(u->'permissions') ? 'template:manage') ORDER BY brand_label,series,name),'[]') INTO result FROM models WHERE NOT d ? 'category' OR category_id=d->>'category';
 WHEN 'models.form' THEN result:=stock_form(tid);
 WHEN 'models.identify' THEN
  tac_v:=left(stock_imei(stock_text(d->'imei','IMEI',15)),8);
  SELECT jsonb_build_object('matched',true,'model',stock_model(model_id),'source',source,'message','请核对实机型号；容量、颜色与机况需另行填写') INTO result FROM tac_mappings WHERE tac=tac_v;
  result:=coalesce(result,'{"matched":false,"message":"未找到已核验型号，请手动选择"}');
 WHEN 'models.create','models.update' THEN
  IF action='models.update' THEN SELECT * INTO old FROM models WHERE id=tid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','型号不存在'); END IF; END IF;
  SELECT * INTO cat FROM categories WHERE id=stock_text(d->'category','分类',60); IF NOT FOUND OR cat.template_id IS NULL THEN PERFORM stock_error('P0400','分类不存在或该分类还没有入库模板'); END IF;
  lbl:=stock_text(d->'brandLabel','品牌',50); SELECT brand INTO brand_v FROM models WHERE lower(brand_label)=lower(lbl) LIMIT 1;
  target:=coalesce(old.id,gen_random_uuid()::text); spec:=coalesce(d->'specs',old.specs,'{"storage":[],"color":[]}');
  IF cat.id NOT IN ('phone','tablet') THEN spec:=spec-'ram'; END IF;
  INSERT INTO models(id,category_id,brand,brand_label,series,name,template_id,specs) VALUES(target,cat.id,coalesce(brand_v,lbl),lbl,stock_text(d->'series','系列',50),stock_text(d->'name','标准型号',100),cat.template_id,spec)
  ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,brand=excluded.brand,brand_label=excluded.brand_label,series=excluded.series,name=excluded.name,template_id=excluded.template_id,specs=excluded.specs;
  DELETE FROM tac_mappings WHERE model_id=target;
  FOR x IN SELECT jsonb_array_elements_text(coalesce(d->'tacs','[]')) LOOP INSERT INTO tac_mappings(tac,model_id,source) VALUES(x,target,stock_text(d->'tacSource','TAC 核验来源',200)); END LOOP;
  PERFORM stock_audit(u,req,CASE WHEN old.id IS NULL THEN '新增型号' ELSE '修改型号' END,target,to_jsonb(old),jsonb_build_object('name',d->'name','category',cat.id,'templateId',cat.template_id,'specs',spec,'tacs',coalesce(d->'tacs','[]'))); result:=stock_model(target,true);
 WHEN 'templates.list' THEN
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(stock_template(id) ORDER BY name),'[]'),'total',(SELECT count(*) FROM templates WHERE NOT d ? 'category' OR category_id=d->>'category')) INTO result FROM (SELECT * FROM templates WHERE NOT d ? 'category' OR category_id=d->>'category' ORDER BY name LIMIT lim OFFSET off_v) x;
 WHEN 'templates.get' THEN result:=stock_template(tid);
 WHEN 'templates.versions' THEN
  PERFORM stock_template(tid);
  SELECT jsonb_build_object('rows',coalesce(jsonb_agg(stock_template(tid,version) ORDER BY version DESC),'[]'),'total',(SELECT count(*) FROM template_versions WHERE template_id=tid)) INTO result FROM (SELECT version FROM template_versions WHERE template_id=tid ORDER BY version DESC LIMIT lim OFFSET off_v) x;
 WHEN 'templates.publish' THEN
  SELECT * INTO t FROM templates WHERE id=tid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','模板不存在'); END IF;
  IF d->'baseVersion' IS DISTINCT FROM to_jsonb(t.current_version) THEN PERFORM stock_error('P0409','模板已更新，请刷新后编辑'); END IF;
  base:=stock_template(tid); ver:=t.current_version+1;
  INSERT INTO template_versions(template_id,version,fields,description_presets,operator_id) VALUES(tid,ver,d->'fields',coalesce(d->'descriptionPresets',base->'descriptionPresets'),(u->>'id')::uuid);
  UPDATE templates SET current_version=ver WHERE id=tid; PERFORM stock_audit(u,req,'发布模板版本',tid,jsonb_build_object('version',t.current_version),jsonb_build_object('version',ver)); result:=stock_template(tid);
 ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发');
 END CASE; RETURN result;
END $$;

-- 采购和借入只取运行内存，不要求填写完整的入库模板。
CREATE FUNCTION stock_ram_value(form jsonb,v jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE f jsonb;
BEGIN
 IF v IS NULL OR v='null'::jsonb OR v='""'::jsonb THEN RETURN '{}'::jsonb; END IF;
 SELECT value INTO f FROM jsonb_array_elements(form->'fields') WHERE value->>'key'='ram';
 IF NOT FOUND THEN PERFORM stock_error('P0400','该型号未配置运行内存字段'); END IF;
 PERFORM stock_values(jsonb_build_array(f),jsonb_build_object('ram',v));
 RETURN jsonb_build_object('ram',v);
END $$;
REVOKE ALL ON FUNCTION stock_ram_value(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION stock_ram_value(jsonb,jsonb) TO service_role;

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
   IF nullif(row_v->'attributes'->>'ram','') IS NOT NULL THEN
    attrs:=attrs||stock_ram_value(stock_form(row_v->>'modelId'),row_v->'attributes'->'ram');
   END IF;
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
  INSERT INTO sales_items(id,order_id,unit_id,model_id,name,spec,store,price,cost,price_version,channel) VALUES(gen_random_uuid(),oid,unit_v.id,unit_v.model_id,(SELECT name FROM models WHERE id=unit_v.model_id),concat_ws(' / ',nullif(unit_v.attributes->>'version',''),nullif(unit_v.attributes->>'storage',''),'运行内存 '||nullif(unit_v.attributes->>'ram',''),nullif(unit_v.attributes->>'color',''),nullif(unit_v.attributes->>'grade','')),coalesce(unit_v.attributes->>'store',''),(x->>'price')::numeric,unit_v.cost,unit_v.price_version,x->>'channel');
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
 imei_v text; imei2_v text; mode_v text; serial_v text; code_v text; form jsonb; ram_attrs jsonb; model_name text; seen text[]:='{}'; typ text; next_v text;
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
    form:=stock_form(dev->>'modelId');
    ram_attrs:=stock_ram_value(form,dev->'ram');
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
     uid:=u.id; UPDATE units SET status='borrowed_in',share_flags=closed_flags,internal_note=dev->>'description',attributes=attributes||ram_attrs WHERE id=uid RETURNING * INTO u;
    ELSE
     uid:=gen_random_uuid();
     INSERT INTO units(id,model_id,imei1,imei2,serial_no,status,ownership,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,inbound_operator_id) VALUES(uid,dev->>'modelId',imei_v,imei2_v,serial_v,'borrowed_in','borrowed',coalesce(dev->>'condition','used'),ram_attrs,form-'modelId'-'modelName'-'specs',0,0,0,0,closed_flags,'','',coalesce(dev->>'description',''),actor) RETURNING * INTO u;
     IF imei_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei_v,uid,'imei1'); END IF;
     IF imei2_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES(imei2_v,uid,'imei2'); END IF;
    END IF;
    INSERT INTO loan_active_units(unit_id,order_id) VALUES(uid,oid);
    INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(uid,CASE WHEN u.status='returned' THEN 'returned' END,'borrowed_in','borrow_in',oid::text,actor,why);
   END IF;
   SELECT name INTO model_name FROM models WHERE id=u.model_id;
   iid:=gen_random_uuid();
   INSERT INTO loan_items(id,order_id,unit_id,snapshot) VALUES(iid,oid,uid,jsonb_build_object('modelId',u.model_id,'name',model_name,'imei1',u.imei1,'imei2',coalesce(u.imei2,''),'serialNo',u.serial_no,'ram',u.attributes->'ram'));
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
           OR (shop_field_public(u.template_snapshot, 'ram', v_aud) AND u.attributes ->> 'ram' ILIKE '%' || (p ->> 'keyword') || '%')
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
