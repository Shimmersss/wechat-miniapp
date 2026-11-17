-- 仅用于独立本机验证库；完整业务函数执行，结束回滚所有夹具。
BEGIN;
INSERT INTO roles(role_key,label,permissions,visible_fields) VALUES('boss','本机验证老板','["inbound:do","acceptance:do","inventory:view","repair:handle","repair:assign","repair:cash","repair:quote","dashboard:view","stats:view"]','["cost","supplier","fullImei","internalNote","profit","wholesalePrice"]') ON CONFLICT DO NOTHING;
DO $$
DECLARE actor uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); u jsonb; limited jsonb; form jsonb; attrs jsonb; f jsonb; base jsonb; result jsonb; o jsonb; closed_v jsonb; uid uuid; oid uuid; state_v text; before_n int; key_v text; report jsonb; count_v int;
BEGIN
 INSERT INTO users(id,openid,nickname) VALUES(actor,'iteration-local-'||actor,'本机验证');
 INSERT INTO staff(id,user_id,phone,name,role_key) VALUES(gen_random_uuid(),actor,'19900000001','本机验证','boss');
 SELECT jsonb_build_object('id',actor,'staffNo','local','role','boss','permissions',permissions,'visibleFields',visible_fields) INTO u FROM roles WHERE role_key='boss';
 -- 老板默认可见字段在前端常量里展开；直接RPC时明确传入。
 u:=u||'{"visibleFields":["cost","supplier","internalNote","fullImei","profit","wholesalePrice"]}';
 INSERT INTO suppliers(id,name) VALUES(sid,'本机验证供应商');
 INSERT INTO models(id,category_id,brand,brand_label,series,name,template_id,specs) VALUES('iteration-local-phone','phone','test','验证','验证','本机验证手机','t_phone','{}');
 form:=stock_form('iteration-local-phone');attrs:='{}';
 FOR f IN SELECT value FROM jsonb_array_elements(form->'fields') LOOP
  IF f->>'key'='refurbishment' THEN RAISE EXCEPTION '新模板仍含整备'; END IF;
  IF f->>'key'='receipt' AND f->'required'='true' THEN RAISE EXCEPTION '凭证仍必填'; END IF;
  IF f->>'type'='select' THEN attrs:=attrs||jsonb_build_object(f->>'key',f->'options'->0);
  ELSIF f->>'type'='number' THEN attrs:=attrs||jsonb_build_object(f->>'key',90);
  ELSIF f->>'type'='boolean' THEN attrs:=attrs||jsonb_build_object(f->>'key',false);
  ELSIF f->>'type'='image' THEN attrs:=attrs||jsonb_build_object(f->>'key','[]'::jsonb);
  ELSE attrs:=attrs||jsonb_build_object(f->>'key',''); END IF;
 END LOOP;
 attrs:=attrs||jsonb_build_object('grade',' 7成新 屏有划痕 ','supplier','本机验证供应商');
 base:=jsonb_build_object('modelId','iteration-local-phone','templateVersion',form->'version','attributes',attrs,'supplierId',sid,'cost','4000','retail','4600','wholesale','4300','agentBase','4300','flags','{"showInShop":true,"sharePeer":true,"shareAgent":false}'::jsonb);
 result:=api_stock('inbound.single','{}',base||'{"imei1":"490154203237518"}',u,'local-inbound'); uid:=(result->>'id')::uuid;
 IF (SELECT status FROM units WHERE id=uid)<>'in_stock' OR (SELECT attributes->>'grade' FROM units WHERE id=uid)<>'7成新 屏有划痕' THEN RAISE EXCEPTION '入库/自定义成色失败'; END IF;
 -- 检验旧模板快照的整备值不会阻止复检。
 UPDATE units SET status='recheck',attributes=attributes||'{"refurbishment":"正在整备"}' WHERE id=uid;
 result:=api_stock('units.recheck',jsonb_build_object('id',uid),'{"result":"pass","reason":"本机复检","inspectionVersion":1,"attributes":{}}',u,'local-recheck');
 IF (SELECT status FROM units WHERE id=uid)<>'in_stock' THEN RAISE EXCEPTION '旧整备设备复检失败'; END IF;
 -- 批量、无串码数量入库。
 result:=api_stock('inbound.batch','{}',jsonb_build_object('common',base,'units','[{"imei1":"356938035643809"}]'::jsonb),u,'local-batch');
 IF (result->>'created')::int<>1 THEN RAISE EXCEPTION '批量入库失败'; END IF;
 INSERT INTO models(id,category_id,brand,brand_label,series,name,template_id,specs) VALUES('iteration-local-other','other','test','验证','验证','本机验证其他设备','t_other','{}');
 form:=stock_form('iteration-local-other');
 result:=api_stock('inbound.single','{}',base||jsonb_build_object('modelId','iteration-local-other','templateVersion',form->'version','quantity',2,'noSerialReason','配件无串码'),u,'local-quantity');
 IF (result->>'created')::int<>2 THEN RAISE EXCEPTION '数量入库失败'; END IF;
 FOR state_v IN SELECT unnest(ARRAY['pending_check','checking','pending_confirm','repairing','pending_pickup']) LOOP
  key_v:=gen_random_uuid()::text;
  o:=api_repairs('create',NULL,jsonb_build_object('kind','external','model','验证手机','customer','验证','phone','19900000001','fault','本机维修','requestKey',key_v,'signature',repeat('a',64)),u,'local-repair','capitalize');
  IF o->>'status'<>'repairing' THEN RAISE EXCEPTION '新单不是维修中'; END IF;
  oid:=(o->>'id')::uuid; UPDATE repair_orders SET status=state_v WHERE id=oid;
  base:=jsonb_build_object('requestKey',gen_random_uuid()::text,'signature',repeat('b',64),'version',1,'reason','确认结单','amount','100.01','cost','20.02','method','现金','confirmed',true,'note','已修复','proof','[]'::jsonb);
  closed_v:=api_repairs('close',oid,base,u,'local-close','capitalize');
  result:=api_repairs('close',oid,base,u,'local-retry','capitalize');
  IF closed_v->>'status'<>'completed' OR (closed_v#>>'{totals,received}')::numeric<>100.01 OR jsonb_array_length(result->'payments')<>2 THEN RAISE EXCEPTION '结单/收款/幂等失败'; END IF;
 END LOOP;
 o:=api_repairs('create',NULL,jsonb_build_object('kind','inventory','unitId',uid,'fault','库存送修','requestKey',gen_random_uuid()::text,'signature',repeat('c',64)),u,'local-inventory','capitalize');
 oid:=(o->>'id')::uuid;limited:=u||'{"visibleFields":[]}';
 BEGIN
  PERFORM api_repairs('close',oid,base,limited,'local-forbidden','capitalize');RAISE EXCEPTION '无成本权限居然可提交费用';
 EXCEPTION WHEN SQLSTATE 'P0403' THEN NULL; END;
 result:=api_repairs('close',oid,base||'{"amount":"0","cost":"10"}',u,'local-zero','capitalize');
 IF result->>'status'<>'completed' OR (SELECT status FROM units WHERE id=uid)<>'recheck' OR (SELECT cost FROM units WHERE id=uid)<>4010 THEN RAISE EXCEPTION '库存机结单/费用分摊错误'; END IF;
 SELECT count(*) INTO before_n FROM repair_orders WHERE status NOT IN ('completed','cancelled');
 o:=api_repairs('create',NULL,jsonb_build_object('kind','external','model','验证','customer','验证','phone','19900000001','fault','验证','requestKey',gen_random_uuid()::text,'signature',repeat('d',64)),u,'local-dashboard','capitalize');
 report:=api_reports('dashboard',NULL,jsonb_build_object('start',date_trunc('day',now()),'end',date_trunc('day',now())+interval '1 day'),u,'local-report');
 IF (report#>>'{counts,repairActive}')::int<>before_n+1 OR report->'counts' ? 'repairConfirm' OR report->'counts' ? 'repairParts' THEN RAISE EXCEPTION '新维修待办错误'; END IF;
 RAISE NOTICE 'PASS: 入库3种模式、自定义成色、旧整备复检、5种存量维修状态、零元结单、费用权限、幂等、库存复检与待办';
END $$;
ROLLBACK;
