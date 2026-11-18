-- 通过 verify-iteration-20261118.js 在已应用全部历史迁移的本机 PG 17 上执行。
BEGIN;
INSERT INTO users(id,openid) VALUES('de000000-0000-0000-0000-000000000001','iteration-demo-cleanup');
INSERT INTO units(id,model_id,imei1,status,condition_type,template_snapshot,cost,retail,wholesale,agent_base,inbound_operator_id)
SELECT ('de100000-0000-0000-0000-00000000000'||i)::uuid, (SELECT id FROM models LIMIT 1),
       '99000000000000'||i, 'in_stock', 'used', CASE WHEN i=3 THEN '{"version":1}'::jsonb ELSE '{}'::jsonb END,
       10,20,15,12,'de000000-0000-0000-0000-000000000001' FROM generate_series(1,4) i;
INSERT INTO sales_orders(id,no,seller_id,pay_method,amount,cost_total,request_key,request_hash)
VALUES('de200000-0000-0000-0000-000000000001','demo-cleanup-sales','de000000-0000-0000-0000-000000000001','现金',20,10,'demo-cleanup-sales',repeat('a',64));
INSERT INTO sales_items(id,order_id,unit_id,model_id,name,spec,price,cost,price_version,channel)
SELECT 'de200000-0000-0000-0000-000000000002','de200000-0000-0000-0000-000000000001',id,model_id,'演示','',20,10,1,'retail'
FROM units WHERE id='de100000-0000-0000-0000-000000000002';
INSERT INTO repair_orders(id,no,kind,unit_id,model,fault,creator_id,request_key,request_hash)
VALUES('de300000-0000-0000-0000-000000000001','demo-cleanup-repair','inventory','de100000-0000-0000-0000-000000000004',
       '演示','测试','de000000-0000-0000-0000-000000000001','demo-cleanup-repair',repeat('a',64));
INSERT INTO loan_orders(id,no,type,counterparty,phone,due_date,remark,creator_id,request_key,request_hash)
VALUES('de400000-0000-0000-0000-000000000001','demo-cleanup-loan','loan_out','演示','13900000000',CURRENT_DATE,'',
       'de000000-0000-0000-0000-000000000001','demo-cleanup-loan',repeat('a',64));
INSERT INTO loan_items(id,order_id,unit_id,snapshot)
VALUES('de400000-0000-0000-0000-000000000002','de400000-0000-0000-0000-000000000001','de100000-0000-0000-0000-000000000004','{}');
INSERT INTO loan_item_states(item_id) VALUES('de400000-0000-0000-0000-000000000002');

CREATE TEMP TABLE demo_preview AS /* PREVIEW_QUERY */;
DO $$ BEGIN
  IF (SELECT (preview->>'count')::int FROM demo_preview) <> 2 OR
     (SELECT jsonb_array_length(preview->'manualReview') FROM demo_preview) <> 1 THEN
    RAISE EXCEPTION '预览应包含 2 台待删、1 台有销售记录';
  END IF;
END $$;
SAVEPOINT changed_fixture;
UPDATE units SET template_snapshot='{"version":1}' WHERE id='de100000-0000-0000-0000-000000000001';
\set ON_ERROR_STOP off
/* APPLY_QUERY */
\if :ERROR
\else
  \echo 清理脚本错误接受变化后的数量
  \quit 1
\endif
\set ON_ERROR_STOP on
ROLLBACK TO changed_fixture;
/* APPLY_QUERY */

DO $$ BEGIN
  IF (SELECT array_agg(right(id::text,1) ORDER BY id) FROM units WHERE id::text LIKE 'de100000-%')
       IS DISTINCT FROM ARRAY['2','3'] OR
     NOT EXISTS (SELECT 1 FROM sales_items WHERE id='de200000-0000-0000-0000-000000000002') OR
     EXISTS (SELECT 1 FROM loan_items WHERE id='de400000-0000-0000-0000-000000000002') OR
     EXISTS (SELECT 1 FROM repair_orders WHERE id='de300000-0000-0000-0000-000000000001') THEN
    RAISE EXCEPTION '删除范围与预期不符';
  END IF;
END $$;
ROLLBACK;

-- 新迁移及 200 台库存分页。所有夹具在本事务回滚。
BEGIN;
INSERT INTO users(id,openid) VALUES
 ('de000000-0000-0000-0000-000000000001','iteration-test-employee'),
 ('de000000-0000-0000-0000-000000000002','iteration-test-customer');
INSERT INTO units(model_id,imei1,status,condition_type,cost,retail,wholesale,agent_base,inbound_operator_id)
SELECT (SELECT id FROM models LIMIT 1), '98'||lpad(i::text,13,'0'), 'in_stock','used',10,20,15,12,
  'de000000-0000-0000-0000-000000000001' FROM generate_series(1,200) i;
DO $verify$
DECLARE
   y uuid:='de000000-0000-0000-0000-000000000001';
   c uuid:='de000000-0000-0000-0000-000000000002';
   u jsonb:=jsonb_build_object('id',y,'staffNo',y,'permissions',jsonb_build_array('inbound:do','consult:manage'));
   p jsonb;
   row_v jsonb;
   request_id_v uuid;
   upload_id uuid;
   poster uuid;
   ids uuid[]:='{}';
BEGIN
   FOR index_v IN 0..10 LOOP
      p:=stock_inventory('units.list',jsonb_build_object('limit',20,'offset',index_v*20),'{}',u,'iteration-stock');
      IF (p->>'total')::int<>200 OR jsonb_array_length(p->'rows')<>(CASE WHEN index_v<10 THEN 20 ELSE 0 END) THEN
        RAISE EXCEPTION '库存分页计数错误';
      END IF;
      FOR row_v IN SELECT value FROM jsonb_array_elements(p->'rows') LOOP
        IF (row_v->>'id')::uuid=ANY(ids) THEN RAISE EXCEPTION '分页设备重复'; END IF;
        ids:=array_append(ids,(row_v->>'id')::uuid);
      END LOOP;
   END LOOP;
   IF cardinality(ids)<>200 THEN RAISE EXCEPTION '分页丢失设备'; END IF;

   request_id_v:=(api_customer_requests('consult.create',NULL,
      jsonb_build_object('requestKey','consult-1','signature',repeat('a',64),'content','夹具','name','匿名','phone','13900000000'),
      jsonb_build_object('id',c),'create','{}')->>'id')::uuid;
   PERFORM api_customer_requests('staff.status',request_id_v,
      jsonb_build_object('requestKey','follow-1','signature',repeat('b',64),'version',1,'status','contacted','reason','跟进状态变更'),
      u,'follow','{}');
   BEGIN
     PERFORM api_customer_requests('staff.status',request_id_v,
       jsonb_build_object('requestKey','undo-invalid','signature',repeat('c',64),'version',2,'status','new','reason','任意','undoOf','follow-1'),
       u||jsonb_build_object('id',c),'wrong-user','{}');
     RAISE EXCEPTION '其他员工不能撤销';
   EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;
   END;
   p:=api_customer_requests('staff.status',request_id_v,
      jsonb_build_object('requestKey','undo-1','signature',repeat('d',64),'version',2,'status','new','reason','任意','undoOf','follow-1'),
      u,'undo','{}');
   IF p->>'status'<>'new' OR (SELECT count(*) FROM audit_logs WHERE object_id=request_id_v::text
        AND reason IN ('跟进状态变更','撤销跟进状态变更'))<>2 THEN
     RAISE EXCEPTION '跟进撤销或审计错误';
   END IF;

   BEGIN
      PERFORM api_file_upload('intent',NULL,
        '{"scope":"public","size":5242881,"mediaType":"image","bizType":"unit","requestKey":"limit-image"}',u,'upload-limit');
      RAISE EXCEPTION '图片必须受限';
   EXCEPTION WHEN SQLSTATE 'P0413' THEN NULL;
   END;
   BEGIN
      PERFORM api_file_upload('intent',NULL,
        '{"scope":"public","size":26214401,"mediaType":"video","bizType":"unit","requestKey":"limit-video"}',u,'upload-limit');
      RAISE EXCEPTION '视频必须受限';
   EXCEPTION WHEN SQLSTATE 'P0413' THEN NULL;
   END;
   INSERT INTO files(id,scope,stored_name,mime,byte_size,sha256,owner_id,upload_purpose)
      VALUES(gen_random_uuid(),'public','xiamu-public/test-cover','image/jpeg',1024,repeat('0',64),y,'unit_poster') RETURNING id INTO poster;
   p:=api_file_upload('intent',NULL,
      jsonb_build_object('scope','public','size',1024,'mediaType','video','bizType','unit','requestKey','valid-video','posterId',poster),
      u,'upload-valid');
   upload_id:=(p->'upload'->>'id')::uuid;
   IF (SELECT poster_id FROM file_uploads WHERE id=upload_id) IS DISTINCT FROM poster THEN
     RAISE EXCEPTION '视频封面未关联';
   END IF;
   BEGIN
     PERFORM api_file_upload('intent',NULL,
       jsonb_build_object('scope','public','size',1024,'mediaType','video','bizType','unit','requestKey','foreign-poster','posterId',poster),
       u||jsonb_build_object('id',c),'upload-denied');
     RAISE EXCEPTION '不能引用其他员工的封面';
   EXCEPTION WHEN SQLSTATE 'P0400' THEN NULL;
   END;
   IF NOT EXISTS(SELECT 1 FROM storage.buckets WHERE id='xiamu-brand-assets' AND public AND allowed_mime_types=ARRAY['image/png']) OR
      EXISTS(SELECT 1 FROM storage.buckets WHERE id IN ('xiamu-public','xiamu-internal') AND public) THEN
     RAISE EXCEPTION '公开插画和业务附件的桶权限配置不符';
   END IF;
END
$verify$;
ROLLBACK;
