-- 与 server/scripts/migrate.js 相同的分类模板初始值；不生成业务库存。
INSERT INTO templates(id,name,category_id,current_version) SELECT 't_'||id,label||'通用模板',id,1 FROM categories WHERE template_id IS NULL;
INSERT INTO template_versions(template_id,version,fields,description_presets) SELECT 't_'||id,1,'[{"key":"version","label":"版本型号","type":"select","options":["国行","港澳台版","美版","日版","韩版","其他海外版"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"networkLock","label":"网络锁","type":"select","options":["无锁","有锁"],"required":true,"visibility":["customer","peer"],"filterable":true,"default":"无锁"},{"key":"storage","label":"存储容量","type":"select","options":["64G","128G","256G","512G","1T","2T"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"color","label":"机身颜色","type":"select","options":["黑色","白色","银色","金色","蓝色","紫色","绿色","红色","粉色","橙色","其他"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"grade","label":"成色","type":"select","options":["准新","99新","98新","97新","95新","9成新"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"peerGrade","label":"同行标准","type":"select","options":["L1-靓机","L2-小花靓","Y1-小花","Y2-南宁花"],"required":false,"visibility":["peer"],"filterable":true},{"key":"activation","label":"激活状态","type":"select","options":["未激活","已激活"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"warrantyUntil","label":"官方保修到期（无则不填）","type":"date","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"idLock","label":"ID 锁","type":"select","options":["已退出（无锁）","有锁"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"repairStatus","label":"拆修情况","type":"select","options":["无拆修","有拆修"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"repairNote","label":"拆修说明（换过的部件、非原装件）","type":"text","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"refurbishment","label":"是否整备","type":"select","options":["无需整备","正在整备","整备完成"],"required":true,"visibility":["internal"],"filterable":true,"default":"无需整备"},{"key":"store","label":"所属门店","type":"text","required":false,"visibility":["internal"],"filterable":false},{"key":"system","label":"系统版本","type":"text","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"allGreen","label":"是否全绿","type":"select","options":["爱思全绿","沙漏全绿","未检测","检测异常"],"required":false,"visibility":["customer","peer"],"filterable":true},{"key":"battery","label":"电池健康（%）","type":"number","required":true,"visibility":["customer","peer"],"filterable":false,"min":0,"max":100},{"key":"shopWarranty","label":"店保期限（天）","type":"number","required":false,"visibility":["customer","peer"],"filterable":false,"min":0},{"key":"warrantyLength","label":"保修时长","type":"select","options":["无","30天","90天","180天","365天"],"required":false,"visibility":["customer","peer"],"filterable":true},{"key":"supplier","label":"供应商","type":"ref","required":true,"visibility":["internal"],"filterable":false},{"key":"receipt","label":"收货凭证","type":"image","required":true,"visibility":["internal"],"filterable":false}]'::jsonb,'{"peer":[],"customer":[]}'::jsonb FROM categories WHERE template_id IS NULL;
UPDATE categories SET template_id='t_'||id WHERE template_id IS NULL;
UPDATE models m SET template_id=c.template_id FROM categories c WHERE c.id=m.category_id AND m.template_id IS NULL;
ALTER TABLE categories ADD CONSTRAINT categories_template_fk FOREIGN KEY(template_id) REFERENCES templates(id);
ALTER TABLE models ADD CONSTRAINT models_template_fk FOREIGN KEY(template_id) REFERENCES templates(id);
-- 库存主链路：一次业务 RPC 对应一个数据库事务；权限/输出裁剪在 staff-stock。
-- 所有辅助函数同样仅限 service_role，禁止 SECURITY DEFINER。
CREATE FUNCTION stock_error(code text, message text) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN RAISE EXCEPTION USING ERRCODE=code,MESSAGE=message; END $$;
CREATE FUNCTION stock_text(v jsonb,label text,maxlen int,optional boolean DEFAULT false) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
BEGIN
 IF optional AND (v IS NULL OR v='""'::jsonb) THEN RETURN ''; END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'string' OR length(trim(v#>>'{}')) NOT BETWEEN 1 AND maxlen THEN PERFORM stock_error('P0400',label||'格式无效'); END IF;
 RETURN trim(v#>>'{}');
END $$;
CREATE FUNCTION stock_money(v jsonb) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
BEGIN
 IF jsonb_typeof(v) NOT IN ('number','string') OR v IS NULL OR (v#>>'{}') !~ '^\d{1,12}(\.\d{1,2})?$' THEN PERFORM stock_error('P0400','金额需为非负金额，最多两位小数'); END IF;
 RETURN (v#>>'{}')::numeric(14,2);
END $$;
CREATE FUNCTION stock_imei(v text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
DECLARE n int:=0; d int; i int;
BEGIN
 IF v IS NULL OR v !~ '^\d{15}$' THEN PERFORM stock_error('P0400','IMEI 格式或校验位无效'); END IF;
 FOR i IN 1..15 LOOP d:=substring(v,i,1)::int; IF i%2=0 THEN d:=d*2; END IF; n:=n+d/10+d%10; END LOOP;
 IF n%10<>0 THEN PERFORM stock_error('P0400','IMEI 格式或校验位无效'); END IF; RETURN v;
END $$;
CREATE FUNCTION stock_can(u jsonb,k text) RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $$
 SELECT CASE WHEN k='agentBase' THEN u->>'role' IN ('boss','manager','purchaser')
 WHEN k IN ('cost','supplier','internalNote','fullImei','wholesalePrice','profit') THEN coalesce(u->'visibleFields' ? k,false) ELSE true END
$$;
CREATE FUNCTION stock_audit(u jsonb,req text,act text,obj text,before_v jsonb DEFAULT NULL,after_v jsonb DEFAULT NULL,why text DEFAULT '') RETURNS void LANGUAGE sql SECURITY INVOKER AS $$
 INSERT INTO audit_logs(actor_id,action,object_id,before_data,after_data,reason,request_id) VALUES((u->>'id')::uuid,act,obj,before_v,after_v,why,req)
$$;
CREATE FUNCTION stock_operator(who uuid) RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT coalesce(s.name,u.nickname,'') FROM users u LEFT JOIN staff s ON s.user_id=u.id WHERE u.id=who
$$;
CREATE FUNCTION stock_template(tid text,ver int DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE r jsonb;
BEGIN
 SELECT jsonb_build_object('id',t.id,'name',t.name,'category',t.category_id,'version',v.version,'fields',v.fields,'descriptionPresets',v.description_presets,'operator',stock_operator(v.operator_id),'publishedAt',v.published_at)
 INTO r FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=coalesce(ver,t.current_version) WHERE t.id=tid;
 IF r IS NULL THEN PERFORM stock_error('P0404','模板不存在'); END IF; RETURN r;
END $$;
CREATE FUNCTION stock_form(mid text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE m models; t jsonb; f jsonb; fields jsonb:='[]'; opts jsonb;
BEGIN
 SELECT * INTO m FROM models WHERE id=mid; IF NOT FOUND THEN PERFORM stock_error('P0404','型号不存在'); END IF;
 t:=stock_template(m.template_id);
 FOR f IN SELECT value FROM jsonb_array_elements(t->'fields') LOOP
  opts:=m.specs->(f->>'key');
  IF f->>'key' IN ('storage','color') AND f->>'type'='select' AND jsonb_array_length(coalesce(opts,'[]'))>0 THEN
   f:=f||jsonb_build_object('options',opts); IF f ? 'default' AND NOT opts @> jsonb_build_array(f->'default') THEN f:=f-'default'; END IF;
  END IF; fields:=fields||jsonb_build_array(f);
 END LOOP;
 RETURN t||jsonb_build_object('fields',fields,'modelId',m.id,'modelName',m.name,'specs',coalesce(m.specs,'{"storage":[],"color":[]}'));
END $$;
CREATE FUNCTION stock_values(fields jsonb,attrs jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE f jsonb; v jsonb; typ text; empty_v boolean; num numeric;
BEGIN
 IF jsonb_typeof(attrs) IS DISTINCT FROM 'object' THEN PERFORM stock_error('P0400','请填写模板参数'); END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(fields) LOOP
  v:=attrs->(f->>'key'); typ:=f->>'type';
  empty_v:= v IS NULL OR v='null'::jsonb OR (jsonb_typeof(v)='string' AND trim(v#>>'{}')='') OR v='[]'::jsonb;
  IF empty_v THEN IF (f->>'required')::boolean THEN PERFORM stock_error('P0400','请填写'||(f->>'label')); END IF; CONTINUE; END IF;
  IF typ IN ('text','ref','select','date') AND jsonb_typeof(v)<>'string' THEN PERFORM stock_error('P0400',(f->>'label')||'必须为文本'); END IF;
  IF typ='select' AND NOT (f->'options' @> jsonb_build_array(v)) THEN PERFORM stock_error('P0400','请选择有效的'||(f->>'label')); END IF;
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
CREATE FUNCTION stock_files(input jsonb,scope_v text,u jsonb,images_only boolean DEFAULT false,trusted jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE result jsonb:='[]'; fid uuid; f files; x jsonb;
BEGIN
 IF input IS NULL THEN RETURN result; END IF;
 IF jsonb_typeof(input)<>'array' OR jsonb_array_length(input)>9 THEN PERFORM stock_error('P0400','每个相册最多九个文件'); END IF;
 -- 全局按 ID 锁文件，后续销售/维修/借还认领必须使用相同锁顺序。
 PERFORM 1 FROM files WHERE id IN (SELECT (value->>'fileId')::uuid FROM jsonb_array_elements(input)) ORDER BY id FOR UPDATE;
 FOR x IN SELECT value FROM jsonb_array_elements(input) LOOP
  fid:=stock_text(x->'fileId','文件标识',36)::uuid;
  IF result @> jsonb_build_array(jsonb_build_object('fileId',fid)) THEN PERFORM stock_error('P0400','相册中存在重复文件'); END IF;
  SELECT * INTO f FROM files WHERE id=fid;
  IF NOT FOUND OR f.scope<>scope_v THEN PERFORM stock_error('P0400','文件不存在或上传范围不符'); END IF;
  IF scope_v='internal' THEN
   IF EXISTS(SELECT 1 FROM repair_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM loan_files WHERE file_id=fid) OR EXISTS(SELECT 1 FROM sales_files WHERE file_id=fid) THEN PERFORM stock_error('P0400','其他业务附件不能用作入库凭证'); END IF;
   IF NOT trusted ? fid::text AND f.owner_id<>(u->>'id')::uuid AND u->>'role' NOT IN ('boss','manager','purchaser') THEN PERFORM stock_error('P0403','无权引用该内部凭证'); END IF;
  END IF;
  IF images_only AND f.mime NOT LIKE 'image/%' THEN PERFORM stock_error('P0400','该模板字段只接受图片'); END IF;
  result:=result||jsonb_build_array(jsonb_build_object('fileId',fid));
 END LOOP; RETURN result;
END $$;
CREATE FUNCTION stock_flags(d jsonb,base jsonb DEFAULT '{"showInShop":false,"sharePeer":false,"shareAgent":false}') RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_each(d) WHERE key NOT IN ('showInShop','sharePeer','shareAgent') OR jsonb_typeof(value)<>'boolean') THEN PERFORM stock_error('P0400','分享开关格式无效'); END IF; RETURN base||d;
END $$;
-- 单台准备、锁版本、串码占用、附件绑定、首次复检与流水在同一事务内。
CREATE FUNCTION stock_insert(d jsonb,u jsonb,ctx jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE form jsonb; attrs jsonb:='{}'; f jsonb; supplier suppliers; mid text; sid uuid; uid uuid:=gen_random_uuid(); imei text; imei2_v text; status_v text; flags_v jsonb; receipt jsonb; public_v jsonb; item uuid:=(ctx->>'acceptanceItemId')::uuid; reserved uuid:=(ctx->>'reservedItemId')::uuid; k text; values_v jsonb; n int;
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
 imei:=stock_imei(stock_text(d->'imei1','IMEI1',15)); imei2_v:=nullif(stock_text(d->'imei2','IMEI2',15,true),'');
 IF imei2_v IS NOT NULL THEN PERFORM stock_imei(imei2_v); IF imei=imei2_v THEN PERFORM stock_error('P0400','本次提交存在重复串码'); END IF; END IF;
 IF EXISTS(SELECT 1 FROM repair_external_slots WHERE identifier IN (imei,imei2_v)) THEN PERFORM stock_error('P0409','串码正在外部维修中，不能作为本店库存入库'); END IF;
 IF EXISTS(SELECT 1 FROM unit_identifiers WHERE unit_identifiers.imei IN (imei,imei2_v) AND NOT (reserved IS NOT NULL AND acceptance_item_id=reserved AND unit_id IS NULL)) THEN PERFORM stock_error('P0409','串码已入库或正在异常验收中'); END IF;
 IF EXISTS(SELECT 1 FROM tac_mappings WHERE tac=left(imei,8) AND model_id<>mid) THEN PERFORM stock_error('P0400','串码识别型号与所选型号不一致'); END IF;
 IF coalesce(d->>'condition','used') NOT IN ('used','new') THEN PERFORM stock_error('P0400','设备类型无效'); END IF;
 status_v:=CASE WHEN attrs->>'refurbishment'='正在整备' THEN 'recheck' ELSE 'in_stock' END;
 flags_v:=stock_flags(coalesce(d->'flags','{}')); IF status_v<>'in_stock' THEN flags_v:='{"showInShop":false,"sharePeer":false,"shareAgent":false}'; END IF;
 receipt:=stock_files(d->'receiptImages','internal',u,true,coalesce(ctx->'trustedReceiptIds','[]')); public_v:=stock_files(d->'publicImages','public',u);
 INSERT INTO units(id,model_id,imei1,imei2,status,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,purchase_line_id,acceptance_item_id,inbound_operator_id,supplier_id)
 VALUES(uid,mid,imei,imei2_v,status_v,coalesce(d->>'condition','used'),attrs,form-'modelId'-'modelName'-'specs',stock_money(coalesce(ctx->'cost',d->'cost')),stock_money(d->'retail'),stock_money(d->'wholesale'),stock_money(d->'agentBase'),flags_v,stock_text(d->'peerDesc','同行描述',4000,true),stock_text(d->'customerDesc','顾客描述',4000,true),stock_text(d->'internalNote','内部备注',4000,true),(ctx->>'purchaseLineId')::uuid,item,(u->>'id')::uuid,supplier.id);
 FOR k,values_v IN SELECT 'imei1',to_jsonb(imei) UNION ALL SELECT 'imei2',to_jsonb(imei2_v) WHERE imei2_v IS NOT NULL LOOP
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
CREATE FUNCTION stock_raw(uid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(u)||jsonb_build_object('name',m.name,'brand',m.brand,'category_id',m.category_id,'supplier_name',s.name,'attached',coalesce((SELECT jsonb_agg(to_jsonb(f)||jsonb_build_object('field_key',uf.field_key) ORDER BY uf.field_key,uf.position) FROM unit_files uf JOIN files f ON f.id=uf.file_id WHERE uf.unit_id=u.id),'[]'),'inspectionVersion',(SELECT count(*) FROM unit_inspections WHERE unit_id=u.id),'loan',(SELECT jsonb_build_object('id',o.id,'no',o.no,'type',o.type) FROM loan_active_units a JOIN loan_orders o ON o.id=a.order_id WHERE a.unit_id=u.id)) FROM units u JOIN models m ON m.id=u.model_id LEFT JOIN suppliers s ON s.id=u.supplier_id WHERE u.id=uid
$$;
CREATE FUNCTION stock_model(mid text,include_tac boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('id',id,'category',category_id,'brand',brand,'brandLabel',brand_label,'series',series,'name',name,'templateId',template_id,'specs',coalesce(specs,'{"storage":[],"color":[]}')) || CASE WHEN include_tac THEN jsonb_build_object('tacs',coalesce((SELECT jsonb_agg(tac ORDER BY tac) FROM tac_mappings WHERE model_id=m.id),'[]'),'tacSource',coalesce((SELECT source FROM tac_mappings WHERE model_id=m.id ORDER BY tac LIMIT 1),'')) ELSE '{}'::jsonb END FROM models m WHERE id=mid
$$;
CREATE FUNCTION stock_catalog(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE tid text:=p->>'id'; target text; cat categories; old models; t templates; base jsonb; result jsonb; spec jsonb; brand_v text; ver int; x text; lbl text; tac_v text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'categories.list' THEN SELECT jsonb_build_object('list',coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label,'templateId',template_id) ORDER BY created_at,id),'[]'),'total',count(*),'page',1,'pageSize',count(*)) INTO result FROM categories;
 WHEN 'categories.create' THEN
  lbl:=stock_text(d->'label','分类名称',50); base:=stock_template(stock_text(d->'copyTemplateId','基础模板',60)); target:=gen_random_uuid()::text; tid:=gen_random_uuid()::text;
  INSERT INTO categories(id,label) VALUES(target,lbl); INSERT INTO templates(id,name,category_id,current_version) VALUES(tid,lbl||'通用模板',target,1);
  INSERT INTO template_versions(template_id,version,fields,description_presets,operator_id) VALUES(tid,1,base->'fields',base->'descriptionPresets',(u->>'id')::uuid);
  UPDATE categories SET template_id=tid WHERE id=target;
  PERFORM stock_audit(u,req,'新增分类',target,NULL,jsonb_build_object('label',lbl,'templateId',tid,'copiedFrom',d->'copyTemplateId'));
  result:=jsonb_build_object('value',target,'label',lbl,'templateId',tid);
 WHEN 'categories.update' THEN
  SELECT * INTO cat FROM categories WHERE id=tid FOR UPDATE; IF NOT FOUND THEN PERFORM stock_error('P0404','分类不存在'); END IF;
  lbl:=stock_text(d->'label','分类名称',50); UPDATE categories SET label=lbl WHERE id=tid;
  PERFORM stock_audit(u,req,'修改分类',tid,jsonb_build_object('label',cat.label),jsonb_build_object('label',lbl)); result:=jsonb_build_object('value',tid,'label',lbl,'templateId',cat.template_id);
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
CREATE FUNCTION stock_purchase_status(pid uuid) RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE qty int; received int; unresolved int; ships int; signed int; state text;
BEGIN
 SELECT sum(quantity),sum(received_count) INTO qty,received FROM purchase_lines WHERE purchase_id=pid;
 SELECT count(*) INTO unresolved FROM acceptance_items a JOIN acceptance_batches b ON b.id=a.batch_id WHERE b.purchase_id=pid AND a.result='fail' AND a.resolution IN ('none','dispute');
 SELECT count(*),count(*) FILTER(WHERE status='signed') INTO ships,signed FROM shipments WHERE purchase_id=pid;
 state:=CASE WHEN unresolved>0 THEN 'exception' WHEN received=qty AND signed=ships THEN 'completed' WHEN received>0 THEN 'accepting' WHEN signed>0 THEN 'arrived' WHEN ships>0 THEN 'in_transit' ELSE 'pending_ship' END;
 UPDATE purchase_orders SET status=state WHERE id=pid; RETURN state;
END $$;
CREATE FUNCTION stock_purchase_raw(pid uuid,detail boolean DEFAULT true) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(o)||jsonb_build_object('supplier_name',s.name,'owner',stock_operator(o.owner_id),'shipments',coalesce((SELECT jsonb_agg(to_jsonb(sh) ORDER BY sh.shipped_at,sh.id) FROM shipments sh WHERE sh.purchase_id=o.id),'[]'))|| CASE WHEN detail THEN jsonb_build_object('lines',coalesce((SELECT jsonb_agg(to_jsonb(l)||jsonb_build_object('name',m.name,'template_id',m.template_id) ORDER BY l.id) FROM purchase_lines l JOIN models m ON m.id=l.model_id WHERE l.purchase_id=o.id),'[]'),'exceptions',coalesce((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('name',m.name) ORDER BY a.created_at,a.id) FROM acceptance_items a JOIN acceptance_batches b ON b.id=a.batch_id JOIN models m ON m.id=a.model_id WHERE b.purchase_id=o.id AND a.result='fail'),'[]')) ELSE '{}' END FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id WHERE o.id=pid
$$;
CREATE FUNCTION stock_purchase(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
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
 WHEN 'shipment.tracks' THEN PERFORM stock_error('P0400','首期不提供快递轨迹查询，请在实际收货后登记签收');
 ELSE PERFORM stock_error('P0404','接口尚未迁移到云开发'); END CASE; RETURN result;
END $$;
CREATE FUNCTION stock_check_specs(line purchase_lines,d jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE k text; v jsonb;
BEGIN
 IF d->>'modelId' IS DISTINCT FROM line.model_id THEN PERFORM stock_error('P0400','验收型号与采购明细不符，应记录异常'); END IF;
 FOR k,v IN SELECT * FROM jsonb_each(line.expected_attributes) LOOP IF d->'attributes'->k IS DISTINCT FROM v THEN PERFORM stock_error('P0400','验收'||k||'与采购规格不符，应记录异常'); END IF; END LOOP;
END $$;
CREATE FUNCTION stock_accept(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE po purchase_orders; prev acceptance_batches; line purchase_lines; ai acceptance_items; item_v jsonb; proof jsonb; attrs jsonb; batch uuid:=gen_random_uuid(); iid uuid; uid uuid; planned jsonb:='[]'; ids jsonb:='[]'; itemids jsonb:='[]'; accepted int:=0; rejected int:=0; remaining int; reason_v text:=''; request_key_v text; digest text:=md5(d::text||coalesce(p->>'id','')); result_v jsonb; imei_v text; imei2_v text; state text; original jsonb;
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
   iid:=gen_random_uuid(); uid:=NULL; imei_v:=stock_imei(stock_text(item_v->'imei1','IMEI1',15)); imei2_v:=nullif(stock_text(item_v->'imei2','IMEI2',15,true),''); IF imei2_v IS NOT NULL THEN PERFORM stock_imei(imei2_v); END IF;
   IF item_v->>'result'='pass' THEN
    PERFORM stock_check_specs(line,item_v); attrs:=coalesce(item_v->'attributes','{}');
   ELSIF item_v->>'result'='fail' THEN attrs:=jsonb_build_object('_receiptImages',proof,'_observedModel',stock_text(item_v->'observedModel','实机型号说明',100,true));
   ELSE PERFORM stock_error('P0400','请填写验收结论'); END IF;
   INSERT INTO acceptance_items(id,batch_id,purchase_line_id,imei1,imei2,model_id,result,reason,attributes) VALUES(iid,batch,line.id,imei_v,imei2_v,coalesce(item_v->>'modelId',line.model_id),item_v->>'result',CASE WHEN item_v->>'result'='fail' THEN stock_text(coalesce(item_v->'remark',item_v->'reason'),'异常原因',500) ELSE '' END,attrs);
   IF item_v->>'result'='pass' THEN
    uid:=stock_insert(item_v||jsonb_build_object('receiptImages',proof),u,jsonb_build_object('purchaseLineId',line.id,'acceptanceItemId',iid,'cost',line.unit_cost,'supplierId',po.supplier_id));
    UPDATE acceptance_items SET unit_id=uid,attributes=(SELECT attributes FROM units WHERE id=uid) WHERE id=iid; ids:=ids||to_jsonb(uid); accepted:=accepted+1;
   ELSE
    INSERT INTO unit_identifiers(imei,acceptance_item_id,slot) VALUES(imei_v,iid,'imei1'); IF imei2_v IS NOT NULL THEN INSERT INTO unit_identifiers(imei,acceptance_item_id,slot) VALUES(imei2_v,iid,'imei2'); END IF; rejected:=rejected+1;
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
  IF (item_v->>'imei1' IS NOT NULL AND item_v->>'imei1'<>'' AND item_v->>'imei1'<>ai.imei1) OR (item_v->>'imei2' IS NOT NULL AND item_v->>'imei2'<>'' AND item_v->>'imei2' IS DISTINCT FROM ai.imei2) THEN PERFORM stock_error('P0400','复验不能替换原异常设备串码'); END IF;
  proof:=coalesce(item_v->'receiptImages',item_v->'attributes'->'receipt',ai.attributes->'_receiptImages','[]');
  uid:=stock_insert(item_v||jsonb_build_object('imei1',ai.imei1,'imei2',coalesce(ai.imei2,''),'receiptImages',proof),u,jsonb_build_object('purchaseLineId',line.id,'acceptanceItemId',ai.id,'reservedItemId',ai.id,'cost',line.unit_cost,'supplierId',po.supplier_id,'trustedReceiptIds',coalesce((SELECT jsonb_agg(value->>'fileId') FROM jsonb_array_elements(ai.attributes->'_receiptImages')),'[]'),'reason',reason_v));
  UPDATE acceptance_items SET resolution='reinspected',unit_id=uid,reason=reason_v WHERE id=ai.id; UPDATE purchase_lines SET accepted_count=accepted_count+1,rejected_count=rejected_count-1 WHERE id=line.id;
 ELSE PERFORM stock_error('P0400','异常处理方式无效'); END CASE;
 state:=stock_purchase_status(po.id); result_v:=jsonb_build_object('resolved',true,'unitId',uid,'purchaseStatus',state);
 PERFORM stock_audit(u,req,'处理验收异常',ai.id::text,jsonb_build_object('resolution',ai.resolution),jsonb_build_object('action',d->'action','unitId',uid,'status',state),reason_v); RETURN result_v;
END $$;
CREATE FUNCTION stock_inventory(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE uid uuid:=(p->>'id')::uuid; row_v units; x jsonb; common jsonb; ids jsonb:='[]'; result jsonb; before_v jsonb; after_v jsonb; k text; attrs jsonb; f jsonb; ver int; next_v text; iid uuid; why text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'inbound.check' THEN
  k:=stock_imei(stock_text(d->'imei','IMEI',15)); SELECT jsonb_build_object('unique',false)||CASE WHEN unit_id IS NOT NULL THEN jsonb_build_object('conflictUnitId',unit_id) ELSE '{}' END INTO result FROM unit_identifiers WHERE imei=k; result:=coalesce(result,'{"unique":true}');
 WHEN 'inbound.single','inbound.batch' THEN
  common:=CASE WHEN action='inbound.single' THEN d ELSE coalesce(d->'common','{}') END;
  IF common->'inspectionConfirmed' IS DISTINCT FROM 'true'::jsonb THEN PERFORM stock_error('P0400','独立入库必须确认已完成到货验收'); END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(CASE WHEN action='inbound.single' THEN jsonb_build_array(d) ELSE d->'units' END) LOOP
   uid:=stock_insert(common||x||jsonb_build_object('attributes',coalesce(common->'attributes','{}')||coalesce(x->'attributes','{}')),u); ids:=ids||to_jsonb(uid);
  END LOOP;
  PERFORM stock_audit(u,req,CASE WHEN action='inbound.single' THEN '单台验收入库' ELSE '批量验收入库' END,ids->>0,NULL,jsonb_build_object('unitIds',ids,'count',jsonb_array_length(ids)));
  result:=CASE WHEN action='inbound.single' THEN jsonb_build_object('id',ids->0) ELSE jsonb_build_object('created',jsonb_array_length(ids),'ids',ids) END;
 WHEN 'pricing.presets' THEN SELECT coalesce(jsonb_agg(cost ORDER BY cost),'[]') INTO result FROM (SELECT DISTINCT cost FROM units WHERE model_id=d->>'modelId' ORDER BY cost LIMIT 20) x;
 WHEN 'units.list' THEN
  WITH filtered AS(SELECT u.* FROM units u JOIN models m ON m.id=u.model_id WHERE (NOT d ? 'status' OR u.status=d->>'status') AND (NOT d ? 'modelId' OR u.model_id=d->>'modelId') AND (NOT d ? 'keyword' OR m.name ILIKE '%'||(d->>'keyword')||'%' OR u.id::text=d->>'keyword' OR u.imei1=d->>'keyword' OR u.imei2=d->>'keyword') AND (NOT d ? 'imei' OR u.imei1=d->>'imei' OR u.imei2=d->>'imei') AND (NOT d ? 'ageingOver' OR u.created_at<=now()-make_interval(days=>(d->>'ageingOver')::int)) AND (NOT d ? 'minPrice' OR u.retail>=stock_money(d->'minPrice')) AND (NOT d ? 'maxPrice' OR u.retail<=stock_money(d->'maxPrice'))), rows AS(SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT lim OFFSET off_v)
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
  WHEN 'units.label' THEN result:=jsonb_build_object('unitId',uid,'name',(SELECT name FROM models WHERE id=row_v.model_id),'storage',row_v.attributes->'storage','grade',row_v.attributes->'grade','retail',row_v.retail,'qrcodeText',uid,'imeiMasked',left(row_v.imei1,2)||'****'||right(row_v.imei1,4));
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
CREATE FUNCTION stock_session(sid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('id',s.id,'status',s.status,'scope',s.scope,'note',s.note,'operator',stock_operator(s.operator_id),'createdAt',s.created_at,'closedAt',s.closed_at,'stocktakeId',s.stocktake_id,'cancelReason',coalesce(s.cancel_reason,''),'expectedCount',(SELECT count(*) FROM stocktake_session_units WHERE session_id=s.id),'scannedCount',(SELECT count(scanned_at) FROM stocktake_session_units WHERE session_id=s.id),'extraCount',(SELECT count(*) FROM stocktake_extras WHERE session_id=s.id)) FROM stocktake_sessions s WHERE id=sid
$$;
CREATE FUNCTION stock_record(rid uuid,detail boolean DEFAULT true) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(t)||jsonb_build_object('operator',stock_operator(t.operator_id),'resolutions',coalesce((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('operator',stock_operator(r.operator_id)) ORDER BY r.created_at,r.id) FROM stocktake_resolutions r WHERE r.stocktake_id=t.id),'[]'))||CASE WHEN detail THEN jsonb_build_object('missing',coalesce((SELECT jsonb_agg(stock_raw(value::uuid)) FROM jsonb_array_elements_text(t.result->'missingIds')),'[]'),'changedUnits',coalesce((SELECT jsonb_agg(stock_raw((value->>'unitId')::uuid)) FROM jsonb_array_elements(t.result->'changed')),'[]')) ELSE '{}' END FROM stocktakes t WHERE id=rid
$$;
CREATE FUNCTION stock_count(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
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
   code_v:=stock_text(d->'code','设备编号或串码',80); SELECT * INTO unit_v FROM units WHERE id::text=code_v OR imei1=code_v OR imei2=code_v LIMIT 1;
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
-- 出库沿用旧 /sales/lookup、/sales/quote、POST /sales-orders。代理/意向归因留给第3步，明确拒绝。
CREATE FUNCTION stock_sale_raw(oid uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT to_jsonb(o)||jsonb_build_object('seller',stock_operator(o.seller_id),'items',coalesce((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM sales_items i WHERE order_id=o.id),'[]')) FROM sales_orders o WHERE id=oid
$$;
CREATE FUNCTION stock_sale(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE unit_v units; x jsonb; plan jsonb:='[]'; total numeric:=0; costs numeric:=0; price_v numeric; base_v numeric; uid uuid; oid uuid:=gen_random_uuid(); old sales_orders; key_v text; digest text:=md5(d::text); why text:=''; changed boolean:=false; fid uuid; files_v jsonb; result_v jsonb;
BEGIN
 IF d ? 'customerRequestId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d->'items','[]')) WHERE value->>'channel'='agent') THEN PERFORM stock_error('P0503','代理订单与意向归因尚未迁移到云开发'); END IF;
 IF action='sales.lookup' THEN
  SELECT * INTO unit_v FROM units WHERE id::text=d->>'code' OR imei1=d->>'code' OR imei2=d->>'code' LIMIT 1;
  IF NOT FOUND THEN PERFORM stock_error('P0404','未找到设备'); END IF; IF unit_v.status<>'in_stock' OR unit_v.ownership<>'own' THEN PERFORM stock_error('P0409','设备不可售'); END IF; RETURN stock_raw(unit_v.id);
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
 -- 固定设备ID顺序加锁，避免多台交叉销售死锁。
 FOR x IN SELECT value FROM jsonb_array_elements(d->'items') ORDER BY value->>'unitId' LOOP
  uid:=(x->>'unitId')::uuid;
  IF action='sales.create' THEN SELECT * INTO unit_v FROM units WHERE id=uid FOR UPDATE; ELSE SELECT * INTO unit_v FROM units WHERE id=uid FOR SHARE; END IF;
  IF NOT FOUND THEN PERFORM stock_error('P0404','设备不存在'); END IF;
  IF unit_v.ownership<>'own' OR unit_v.status<>'in_stock' THEN PERFORM stock_error('P0409','设备不可售，请刷新库存'); END IF;
  IF x->'priceVersion' IS DISTINCT FROM to_jsonb(unit_v.price_version) THEN PERFORM stock_error('P0409','设备价格已变化，请重新核对'); END IF;
  IF x->>'channel'='wholesale' AND NOT stock_can(u,'wholesalePrice') THEN PERFORM stock_error('P0403','无权限使用批发价格'); END IF;
  base_v:=CASE WHEN x->>'channel'='wholesale' THEN unit_v.wholesale ELSE unit_v.retail END; price_v:=CASE WHEN x ? 'price' THEN stock_money(x->'price') ELSE base_v END;
  IF price_v<>base_v THEN changed:=true; IF NOT u->'permissions' ? 'price:edit' THEN PERFORM stock_error('P0403','无权限执行该操作'); END IF; END IF;
  total:=total+price_v; costs:=costs+unit_v.cost;
  plan:=plan||jsonb_build_array(jsonb_build_object('unitId',uid,'price',price_v,'basePrice',base_v,'priceVersion',unit_v.price_version,'channel',coalesce(x->>'channel','retail')));
 END LOOP;
 IF total>999999999999.99 OR costs>999999999999.99 THEN PERFORM stock_error('P0400','金额合计超出允许范围'); END IF;
 IF action='sales.quote' THEN RETURN jsonb_build_object('total',total,'items',plan); END IF;
 IF changed THEN why:=stock_text(d->'priceReason','成交改价原因',500); END IF;
 INSERT INTO sales_orders(id,no,seller_id,pay_method,customer,phone,remark,amount,cost_total,request_key,request_hash) VALUES(oid,'SO'||replace(oid::text,'-',''),(u->>'id')::uuid,d->>'payMethod',stock_text(d->'customer','顾客',100,true),stock_text(d->'phone','电话',30,true),stock_text(d->'remark','备注',1000,true),total,costs,key_v,digest);
 FOR x IN SELECT value FROM jsonb_array_elements(plan) LOOP
  SELECT * INTO unit_v FROM units WHERE id=(x->>'unitId')::uuid;
  INSERT INTO sales_items(id,order_id,unit_id,model_id,name,spec,store,price,cost,price_version,channel) VALUES(gen_random_uuid(),oid,unit_v.id,unit_v.model_id,(SELECT name FROM models WHERE id=unit_v.model_id),concat_ws(' / ',nullif(unit_v.attributes->>'version',''),nullif(unit_v.attributes->>'storage',''),nullif(unit_v.attributes->>'color',''),nullif(unit_v.attributes->>'grade','')),coalesce(unit_v.attributes->>'store',''),(x->>'price')::numeric,unit_v.cost,unit_v.price_version,x->>'channel');
  UPDATE units SET status='sold',share_flags='{"showInShop":false,"sharePeer":false,"shareAgent":false}' WHERE id=unit_v.id;
  INSERT INTO inventory_ledger(unit_id,from_status,to_status,doc_type,doc_id,operator_id,reason) VALUES(unit_v.id,unit_v.status,'sold','sales_order',oid::text,(u->>'id')::uuid,coalesce(nullif(why,''),'实际收款确认'));
 END LOOP;
 INSERT INTO sales_files(order_id,file_id,added_by) SELECT oid,(value->>'fileId')::uuid,(u->>'id')::uuid FROM jsonb_array_elements(files_v);
 PERFORM stock_audit(u,req,'销售收款出库',oid::text,NULL,jsonb_build_object('unitIds',(SELECT jsonb_agg(value->'unitId') FROM jsonb_array_elements(plan)),'amount',total,'payMethod',d->'payMethod'),why);
 RETURN stock_sale_raw(oid);
END $$;
CREATE FUNCTION api_stock(p_action text,p_params jsonb,p_data jsonb,p_user jsonb,p_request_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
 CASE split_part(p_action,'.',1)
 WHEN 'categories','models','templates' THEN RETURN stock_catalog(p_action,p_params,p_data,p_user,p_request_id);
 WHEN 'suppliers','purchase','shipment' THEN RETURN stock_purchase(p_action,p_params,p_data,p_user,p_request_id);
 WHEN 'acceptance' THEN RETURN stock_accept(p_action,p_params,p_data,p_user,p_request_id);
 WHEN 'sessions','records' THEN RETURN stock_count(p_action,p_params,p_data,p_user,p_request_id);
 WHEN 'sales' THEN RETURN stock_sale(p_action,p_params,p_data,p_user,p_request_id);
 ELSE RETURN stock_inventory(p_action,p_params,p_data,p_user,p_request_id); END CASE;
EXCEPTION WHEN unique_violation THEN PERFORM stock_error('P0409','串码、名称或提交标识已存在，请刷新后核对');
 WHEN foreign_key_violation OR invalid_text_representation OR numeric_value_out_of_range OR check_violation OR not_null_violation OR string_data_right_truncation THEN PERFORM stock_error('P0400','参数无效或关联记录不存在');
 WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN PERFORM stock_error('P0409','记录正被其他操作更新，请刷新后重试');
END $$;
DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'stock\_%' ESCAPE '\' OR p.proname='api_stock') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
 END LOOP;
END $$;
