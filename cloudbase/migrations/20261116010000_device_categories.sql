-- 设备分类扩充（docs/PLAN-DEVICE-TYPES-AND-SERIAL-INBOUND.md WP2）：
-- 1. 分类加排序和串码方式：imei=手机；serial=非手机，推荐序列号；serial_imei=非手机，可另填 IMEI（蜂窝版平板）。
-- 2. 预置平板、耳机耳麦、配件、其他设备四个分类，模板从当前手机模板按字段裁剪复制。
-- 3. 分类列表、型号、入库表单、顾客端目录带上排序与串码方式。
-- 已有分类默认 imei，保持原有手机入库规则。

ALTER TABLE categories ADD COLUMN sort_order int NOT NULL DEFAULT 100;
ALTER TABLE categories ADD COLUMN identifier_mode text NOT NULL DEFAULT 'imei'
  CHECK (identifier_mode IN ('imei','serial','serial_imei'));
UPDATE categories SET sort_order=10 WHERE id='phone';

-- 付费 TAC 查询已在 309b3f7 移除；若旧版迁移曾执行，清掉遗留对象。
DROP FUNCTION IF EXISTS public.api_imei_paid_lookup_reserve(text,integer);
DROP TABLE IF EXISTS public.imei_paid_lookup_budget;

CREATE FUNCTION stock_identifier_mode(v text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER AS $$
BEGIN
 IF v IS NULL OR v NOT IN ('imei','serial','serial_imei') THEN PERFORM stock_error('P0400','串码方式无效'); END IF;
 RETURN v;
END $$;

-- 型号所属分类的串码方式；型号不存在时按手机处理，由调用方报型号错误。
CREATE FUNCTION stock_unit_mode(mid text) RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT coalesce((SELECT c.identifier_mode FROM models m JOIN categories c ON c.id=m.category_id WHERE m.id=mid),'imei')
$$;

-- 预置分类。标签已被其他分类占用时跳过，需人工核对。
DO $$
DECLARE
  phone_tpl jsonb;
  presets jsonb;
  spec record;
  fields_v jsonb;
BEGIN
  SELECT v.fields, v.description_presets INTO phone_tpl, presets
  FROM categories c JOIN templates t ON t.id=c.template_id
  JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version
  WHERE c.id='phone';
  IF phone_tpl IS NULL THEN
    SELECT v.fields, v.description_presets INTO phone_tpl, presets
    FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version
    WHERE t.id='t_phone';
  END IF;
  IF phone_tpl IS NULL THEN
    -- 全新环境：先建手机分类，模板沿用初始手机模板
    phone_tpl := '[{"key":"version","label":"版本型号","type":"select","options":["国行","港澳台版","美版","日版","韩版","其他海外版"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"networkLock","label":"网络锁","type":"select","options":["无锁","有锁"],"required":true,"visibility":["customer","peer"],"filterable":true,"default":"无锁"},{"key":"storage","label":"存储容量","type":"select","options":["64G","128G","256G","512G","1T","2T"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"color","label":"机身颜色","type":"select","options":["黑色","白色","银色","金色","蓝色","紫色","绿色","红色","粉色","橙色","其他"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"grade","label":"成色","type":"select","options":["准新","99新","98新","97新","95新","9成新"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"peerGrade","label":"同行标准","type":"select","options":["L1-靓机","L2-小花靓","Y1-小花","Y2-南宁花"],"required":false,"visibility":["peer"],"filterable":true},{"key":"activation","label":"激活状态","type":"select","options":["未激活","已激活"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"warrantyUntil","label":"官方保修到期（无则不填）","type":"date","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"idLock","label":"ID 锁","type":"select","options":["已退出（无锁）","有锁"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"repairStatus","label":"拆修情况","type":"select","options":["无拆修","有拆修"],"required":true,"visibility":["customer","peer"],"filterable":true},{"key":"repairNote","label":"拆修说明（换过的部件、非原装件）","type":"text","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"refurbishment","label":"是否整备","type":"select","options":["无需整备","正在整备","整备完成"],"required":true,"visibility":["internal"],"filterable":true,"default":"无需整备"},{"key":"store","label":"所属门店","type":"text","required":false,"visibility":["internal"],"filterable":false},{"key":"system","label":"系统版本","type":"text","required":false,"visibility":["customer","peer"],"filterable":false},{"key":"allGreen","label":"是否全绿","type":"select","options":["爱思全绿","沙漏全绿","未检测","检测异常"],"required":false,"visibility":["customer","peer"],"filterable":true},{"key":"battery","label":"电池健康（%）","type":"number","required":true,"visibility":["customer","peer"],"filterable":false,"min":0,"max":100},{"key":"shopWarranty","label":"店保期限（天）","type":"number","required":false,"visibility":["customer","peer"],"filterable":false,"min":0},{"key":"warrantyLength","label":"保修时长","type":"select","options":["无","30天","90天","180天","365天"],"required":false,"visibility":["customer","peer"],"filterable":true},{"key":"supplier","label":"供应商","type":"ref","required":true,"visibility":["internal"],"filterable":false},{"key":"receipt","label":"收货凭证","type":"image","required":true,"visibility":["internal"],"filterable":false}]'::jsonb;
    presets := '{"peer":[],"customer":[]}'::jsonb;
    IF NOT EXISTS(SELECT 1 FROM categories WHERE id='phone') AND NOT EXISTS(SELECT 1 FROM categories WHERE label='手机') THEN
      INSERT INTO categories(id,label,sort_order,identifier_mode) VALUES('phone','手机',10,'imei');
      INSERT INTO templates(id,name,category_id,current_version) VALUES('t_phone','手机通用模板','phone',1) ON CONFLICT (id) DO NOTHING;
      INSERT INTO template_versions(template_id,version,fields,description_presets) VALUES('t_phone',1,phone_tpl,presets) ON CONFLICT DO NOTHING;
      UPDATE categories SET template_id='t_phone' WHERE id='phone';
    END IF;
  END IF;

  FOR spec IN SELECT * FROM (VALUES
    ('tablet','平板',20,'serial_imei',
      ARRAY['version','networkLock','storage','color','grade','peerGrade','activation','warrantyUntil','idLock','repairStatus','repairNote','refurbishment','store','system','allGreen','battery','shopWarranty','warrantyLength','supplier','receipt'],
      '[]'::jsonb),
    ('audio','耳机耳麦',30,'serial',
      ARRAY['color','grade','peerGrade','activation','repairStatus','repairNote','refurbishment','store','shopWarranty','warrantyLength','supplier','receipt'],
      '[{"key":"kitStatus","label":"配件情况","type":"select","options":["配件齐全","缺少配件","仅主机"],"required":true,"visibility":["customer","peer"],"filterable":true}]'::jsonb),
    ('accessory','配件',40,'serial',
      ARRAY['color','grade','store','shopWarranty','supplier','receipt'],
      '[{"key":"spec","label":"规格（功率、长度、接口等）","type":"text","required":false,"visibility":["customer","peer"],"filterable":false}]'::jsonb),
    ('other','其他设备',50,'serial',
      ARRAY['storage','color','grade','peerGrade','activation','warrantyUntil','repairStatus','repairNote','refurbishment','store','system','shopWarranty','warrantyLength','supplier','receipt'],
      '[{"key":"spec","label":"配置规格","type":"text","required":false,"visibility":["customer","peer"],"filterable":false}]'::jsonb)
  ) AS s(id,label,sort_order,mode,keys,extra) LOOP
    IF EXISTS(SELECT 1 FROM categories WHERE id=spec.id) THEN
      UPDATE categories SET sort_order=spec.sort_order, identifier_mode=spec.mode WHERE id=spec.id
        AND NOT EXISTS(SELECT 1 FROM units un JOIN models mm ON mm.id=un.model_id WHERE mm.category_id=spec.id);
      CONTINUE;
    END IF;
    IF EXISTS(SELECT 1 FROM categories WHERE label=spec.label) THEN
      RAISE NOTICE '分类名称“%”已存在，跳过预置分类 %', spec.label, spec.id;
      CONTINUE;
    END IF;
    -- 按指定顺序取手机模板字段；补充字段放在供应商、凭证之前。
    SELECT coalesce(jsonb_agg(f ORDER BY array_position(spec.keys, f->>'key')),'[]'::jsonb) INTO fields_v
    FROM jsonb_array_elements(phone_tpl) f WHERE f->>'key' = ANY(spec.keys) AND f->>'key' NOT IN ('supplier','receipt');
    fields_v := fields_v || spec.extra || coalesce((SELECT jsonb_agg(f ORDER BY f->>'key' DESC) FROM jsonb_array_elements(phone_tpl) f WHERE f->>'key' IN ('supplier','receipt') AND f->>'key' = ANY(spec.keys)),'[]'::jsonb);
    INSERT INTO categories(id,label,sort_order,identifier_mode) VALUES(spec.id,spec.label,spec.sort_order,spec.mode);
    INSERT INTO templates(id,name,category_id,current_version) VALUES('t_'||spec.id,spec.label||'通用模板',spec.id,1);
    INSERT INTO template_versions(template_id,version,fields,description_presets) VALUES('t_'||spec.id,1,fields_v,coalesce(presets,'{"peer":[],"customer":[]}'::jsonb));
    UPDATE categories SET template_id='t_'||spec.id WHERE id=spec.id;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION stock_catalog(action text,p jsonb,d jsonb,u jsonb,req text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE tid text:=p->>'id'; target text; cat categories; old models; t templates; base jsonb; result jsonb; spec jsonb; brand_v text; ver int; x text; lbl text; tac_v text; lim int:=(p->>'limit')::int; off_v int:=(p->>'offset')::int;
BEGIN
 CASE action
 WHEN 'categories.list' THEN SELECT jsonb_build_object('list',coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label,'templateId',template_id,'identifierMode',identifier_mode,'sortOrder',sort_order,'unitCount',(SELECT count(*) FROM units un JOIN models mm ON mm.id=un.model_id WHERE mm.category_id=c.id)) ORDER BY sort_order,created_at,id),'[]'),'total',count(*),'page',1,'pageSize',count(*)) INTO result FROM categories c;
 WHEN 'categories.create' THEN
  lbl:=stock_text(d->'label','分类名称',50); base:=stock_template(stock_text(d->'copyTemplateId','基础模板',60)); target:=gen_random_uuid()::text; tid:=gen_random_uuid()::text;
  INSERT INTO categories(id,label,identifier_mode) VALUES(target,lbl,stock_identifier_mode(coalesce(d->>'identifierMode','serial'))); INSERT INTO templates(id,name,category_id,current_version) VALUES(tid,lbl||'通用模板',target,1);
  INSERT INTO template_versions(template_id,version,fields,description_presets,operator_id) VALUES(tid,1,base->'fields',base->'descriptionPresets',(u->>'id')::uuid);
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

CREATE OR REPLACE FUNCTION stock_model(mid text,include_tac boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('id',id,'category',category_id,'identifierMode',stock_unit_mode(m.id),'brand',brand,'brandLabel',brand_label,'series',series,'name',name,'templateId',template_id,'specs',coalesce(specs,'{"storage":[],"color":[]}')) || CASE WHEN include_tac THEN jsonb_build_object('tacs',coalesce((SELECT jsonb_agg(tac ORDER BY tac) FROM tac_mappings WHERE model_id=m.id),'[]'),'tacSource',coalesce((SELECT source FROM tac_mappings WHERE model_id=m.id ORDER BY tac LIMIT 1),'')) ELSE '{}'::jsonb END FROM models m WHERE id=mid
$$;

CREATE OR REPLACE FUNCTION stock_form(mid text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
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
 RETURN t||jsonb_build_object('fields',fields,'modelId',m.id,'modelName',m.name,'specs',coalesce(m.specs,'{"storage":[],"color":[]}'),'identifierMode',stock_unit_mode(m.id));
END $$;

CREATE OR REPLACE FUNCTION api_shop_catalog() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('categories',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label,'identifierMode',identifier_mode) ORDER BY sort_order,created_at,id),'[]') FROM categories),
 'models',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'category_id',category_id,'brand',brand,'brand_label',brand_label,'series',series,'name',name) ORDER BY brand_label,series,name),'[]') FROM models))
$$;

DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname IN ('stock_identifier_mode','stock_unit_mode','stock_catalog','stock_model','stock_form','api_shop_catalog') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
 END LOOP;
END $$;
