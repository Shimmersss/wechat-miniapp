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
