-- 机型库扩充到两千多个型号后（20261117030000），按需加载：
-- 1. 员工端选型号：新增 models.brands 列出分类下各品牌型号数；models.list 支持按品牌、关键词筛选。
-- 2. 顾客端分类目录：只列出当前有在库且对外展示（店铺或同行）设备的型号。
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
 WHEN 'models.brands' THEN
  -- 型号多时先列品牌，选型号页按品牌分批加载
  SELECT coalesce(jsonb_agg(jsonb_build_object('brand',brand,'brandLabel',brand_label,'count',n) ORDER BY brand_label),'[]') INTO result
  FROM (SELECT brand, min(brand_label) AS brand_label, count(*) AS n FROM models WHERE NOT d ? 'category' OR category_id=d->>'category' GROUP BY brand) x;
 WHEN 'models.list' THEN
  -- 可按品牌、关键词（型号名或系列）筛选；关键词搜索最多返回 200 个
  SELECT coalesce(jsonb_agg(stock_model(x.id,(u->'permissions') ? 'template:manage') ORDER BY x.brand_label,x.series,x.name),'[]') INTO result
  FROM (SELECT id, brand_label, series, name FROM models
        WHERE (NOT d ? 'category' OR category_id=d->>'category') AND (NOT d ? 'brand' OR brand=d->>'brand')
          AND (NOT d ? 'keyword' OR name ILIKE '%'||(d->>'keyword')||'%' OR series ILIKE '%'||(d->>'keyword')||'%')
        ORDER BY brand_label, series, name LIMIT CASE WHEN d ? 'keyword' THEN 200 ELSE NULL END) x;
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

CREATE OR REPLACE FUNCTION api_shop_catalog() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS $$
 SELECT jsonb_build_object('categories',(SELECT coalesce(jsonb_agg(jsonb_build_object('value',id,'label',label,'identifierMode',identifier_mode) ORDER BY sort_order,created_at,id),'[]') FROM categories),
 'models',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'category_id',category_id,'brand',brand,'brand_label',brand_label,'series',series,'name',name) ORDER BY brand_label,series,name),'[]') FROM models m WHERE EXISTS(SELECT 1 FROM units un WHERE un.model_id=m.id AND un.status='in_stock' AND ((un.share_flags->>'showInShop')::boolean IS TRUE OR (un.share_flags->>'sharePeer')::boolean IS TRUE))))
$$;

REVOKE ALL ON FUNCTION stock_catalog(text,jsonb,jsonb,jsonb,text), api_shop_catalog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION stock_catalog(text,jsonb,jsonb,jsonb,text), api_shop_catalog() TO service_role;
