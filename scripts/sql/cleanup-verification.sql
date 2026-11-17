-- 清理验证脚本留下的测试分类及其全部业务数据（docs/PLAN-DEVICE-TYPES-AND-SERIAL-INBOUND.md 6.2）。
-- 由 scripts/cleanup-verification-data.js 临时创建、调用后删除；不是迁移，不要放进 cloudbase/migrations。
--
-- 保留：预置分类 phone / tablet / audio / accessory / other 及其型号、设备和关联单据。
-- 删除：其余分类、这些分类下的型号与模板、型号下的设备，以及只涉及这些设备的单据链。
-- 不删：audit_logs（只追加）、用户、员工、角色、会话、供应商、文件记录与云存储对象，只在预览里列出。
-- 一张单据同时含保留设备和待删设备时整体中止，交人工处理。
--
-- p_apply=false 只返回预览；true 在同一事务里删除并返回删除前的计数。
CREATE OR REPLACE FUNCTION public.xiamu_cleanup_verification(p_apply boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  keep_categories text[] := ARRAY['phone','tablet','audio','accessory','other'];
  t_cat text[]; t_model text[]; t_tpl text[]; t_unit uuid[];
  t_po uuid[]; t_line uuid[]; t_acc uuid[]; t_sale uuid[]; t_loan uuid[]; t_share text[];
  t_req uuid[]; t_agent uuid[]; t_repair uuid[]; t_session uuid[]; t_stocktake uuid[];
  mixed jsonb := '{}'::jsonb; preview jsonb; n int;
BEGIN
  SELECT coalesce(array_agg(id),'{}') INTO t_cat FROM categories WHERE NOT id = ANY(keep_categories);
  SELECT coalesce(array_agg(id),'{}') INTO t_model FROM models WHERE category_id = ANY(t_cat);
  SELECT coalesce(array_agg(id),'{}') INTO t_unit FROM units WHERE model_id = ANY(t_model);
  SELECT coalesce(array_agg(t.id),'{}') INTO t_tpl FROM templates t WHERE t.category_id = ANY(t_cat)
    AND NOT EXISTS(SELECT 1 FROM categories c WHERE c.template_id=t.id AND NOT c.id = ANY(t_cat))
    AND NOT EXISTS(SELECT 1 FROM models m WHERE m.template_id=t.id AND NOT m.id = ANY(t_model));

  -- 采购：明细全部是待删型号的采购单
  SELECT coalesce(array_agg(DISTINCT purchase_id),'{}') INTO t_po FROM purchase_lines WHERE model_id = ANY(t_model);
  SELECT coalesce(jsonb_agg(DISTINCT purchase_id),'[]') INTO preview FROM purchase_lines WHERE purchase_id = ANY(t_po) AND NOT model_id = ANY(t_model);
  IF jsonb_array_length(preview)>0 THEN mixed := mixed || jsonb_build_object('purchaseOrders',preview); END IF;
  SELECT coalesce(array_agg(id),'{}') INTO t_line FROM purchase_lines WHERE purchase_id = ANY(t_po);
  SELECT coalesce(array_agg(id),'{}') INTO t_acc FROM acceptance_items WHERE purchase_line_id = ANY(t_line) OR model_id = ANY(t_model) OR unit_id = ANY(t_unit);

  -- 销售：明细全部是待删设备的销售单
  SELECT coalesce(array_agg(DISTINCT order_id),'{}') INTO t_sale FROM sales_items WHERE unit_id = ANY(t_unit);
  SELECT coalesce(jsonb_agg(DISTINCT order_id),'[]') INTO preview FROM sales_items WHERE order_id = ANY(t_sale) AND NOT unit_id = ANY(t_unit);
  IF jsonb_array_length(preview)>0 THEN mixed := mixed || jsonb_build_object('salesOrders',preview); END IF;

  -- 借还
  SELECT coalesce(array_agg(DISTINCT order_id),'{}') INTO t_loan FROM loan_items WHERE unit_id = ANY(t_unit);
  SELECT coalesce(jsonb_agg(DISTINCT order_id),'[]') INTO preview FROM loan_items WHERE order_id = ANY(t_loan) AND NOT unit_id = ANY(t_unit);
  IF jsonb_array_length(preview)>0 THEN mixed := mixed || jsonb_build_object('loanOrders',preview); END IF;

  -- 分享
  SELECT coalesce(array_agg(DISTINCT share_id::text),'{}') INTO t_share FROM share_items WHERE unit_id = ANY(t_unit);
  SELECT coalesce(jsonb_agg(DISTINCT share_id),'[]') INTO preview FROM share_items WHERE share_id::text = ANY(t_share) AND NOT unit_id = ANY(t_unit);
  IF jsonb_array_length(preview)>0 THEN mixed := mixed || jsonb_build_object('shareLinks',preview); END IF;

  -- 顾客意向、代理订单、维修
  SELECT coalesce(array_agg(id),'{}') INTO t_req FROM customer_requests WHERE unit_id = ANY(t_unit) OR share_id::text = ANY(t_share);
  -- agent_orders 以 request_id（顾客意向）为主键
  SELECT coalesce(array_agg(request_id),'{}') INTO t_agent FROM agent_orders WHERE unit_id = ANY(t_unit) OR request_id = ANY(t_req) OR share_id::text = ANY(t_share);
  SELECT coalesce(array_agg(id),'{}') INTO t_repair FROM repair_orders WHERE unit_id = ANY(t_unit);

  -- 盘点：快照里只有待删设备的盘点单整单删除；同时含保留设备的只删待删设备那几行
  SELECT coalesce(array_agg(s.id),'{}') INTO t_session FROM stocktake_sessions s
   WHERE EXISTS(SELECT 1 FROM stocktake_session_units x WHERE x.session_id=s.id AND x.unit_id = ANY(t_unit))
     AND NOT EXISTS(SELECT 1 FROM stocktake_session_units x WHERE x.session_id=s.id AND NOT x.unit_id = ANY(t_unit));
  SELECT coalesce(array_agg(DISTINCT stocktake_id),'{}') INTO t_stocktake FROM stocktake_sessions WHERE id = ANY(t_session) AND stocktake_id IS NOT NULL;

  preview := jsonb_build_object(
    'categories', (SELECT coalesce(jsonb_agg(label ORDER BY label),'[]') FROM categories WHERE id = ANY(t_cat)),
    'keptCategories', (SELECT coalesce(jsonb_agg(label ORDER BY sort_order),'[]') FROM categories WHERE id = ANY(keep_categories)),
    'counts', jsonb_build_object(
      'categories', cardinality(t_cat), 'models', cardinality(t_model), 'templates', cardinality(t_tpl), 'units', cardinality(t_unit),
      'keptUnits', (SELECT count(*) FROM units WHERE NOT id = ANY(t_unit)),
      'purchaseOrders', cardinality(t_po), 'acceptanceItems', cardinality(t_acc), 'salesOrders', cardinality(t_sale),
      'refunds', (SELECT count(*) FROM sales_refunds WHERE order_id = ANY(t_sale)),
      'loanOrders', cardinality(t_loan), 'shareLinks', cardinality(t_share), 'customerRequests', cardinality(t_req),
      'agentOrders', cardinality(t_agent), 'agentEarnings', (SELECT count(*) FROM agent_earnings WHERE sale_order_id = ANY(t_sale) OR request_id = ANY(t_agent)),
      'repairOrders', cardinality(t_repair), 'stocktakeSessions', cardinality(t_session),
      'partialStocktakeRows', (SELECT count(*) FROM stocktake_session_units WHERE unit_id = ANY(t_unit) AND NOT session_id = ANY(t_session)),
      'inventoryLedger', (SELECT count(*) FROM inventory_ledger WHERE unit_id = ANY(t_unit)),
      'visitEvents', (SELECT count(*) FROM visit_events WHERE share_id::text = ANY(t_share) OR lower(unit_id) = ANY(t_unit::text[]))),
    'mixed', mixed,
    'notDeleted', jsonb_build_object(
      'suppliers', (SELECT coalesce(jsonb_agg(name ORDER BY name),'[]') FROM suppliers),
      'unreferencedFilesAfter', (SELECT count(*) FROM files f WHERE
         NOT EXISTS(SELECT 1 FROM unit_files x WHERE x.file_id=f.id AND NOT x.unit_id = ANY(t_unit))
         AND NOT EXISTS(SELECT 1 FROM sales_files x WHERE x.file_id=f.id AND NOT x.order_id = ANY(t_sale))
         AND NOT EXISTS(SELECT 1 FROM loan_files x WHERE x.file_id=f.id AND NOT x.order_id = ANY(t_loan))
         AND NOT EXISTS(SELECT 1 FROM repair_files x WHERE x.file_id=f.id AND NOT x.order_id = ANY(t_repair))
         AND NOT EXISTS(SELECT 1 FROM shipments x WHERE x.receipt_file_id=f.id AND NOT x.purchase_id = ANY(t_po))),
      'auditLogs', '保留，只追加'));

  IF NOT p_apply THEN RETURN preview; END IF;
  IF mixed <> '{}'::jsonb THEN RAISE EXCEPTION '存在同时含保留与待删设备的单据，已中止：%', mixed; END IF;

  -- 代理、意向、分享
  DELETE FROM agent_earning_states WHERE earning_id IN (SELECT id FROM agent_earnings WHERE sale_order_id = ANY(t_sale) OR request_id = ANY(t_agent));
  DELETE FROM agent_earnings WHERE sale_order_id = ANY(t_sale) OR request_id = ANY(t_agent);
  DELETE FROM agent_order_states WHERE request_id = ANY(t_agent) OR sale_order_id = ANY(t_sale);
  DELETE FROM agent_unit_locks WHERE request_id = ANY(t_agent) OR unit_id = ANY(t_unit);
  DELETE FROM agent_orders WHERE request_id = ANY(t_agent);
  DELETE FROM agent_markups WHERE unit_id = ANY(t_unit);
  DELETE FROM sales_attributions WHERE order_id = ANY(t_sale) OR customer_request_id = ANY(t_req) OR share_id::text = ANY(t_share);
  DELETE FROM customer_request_events WHERE request_id = ANY(t_req);
  DELETE FROM customer_request_states WHERE request_id = ANY(t_req);
  DELETE FROM customer_requests WHERE id = ANY(t_req);
  DELETE FROM visit_events WHERE share_id::text = ANY(t_share) OR lower(unit_id) = ANY(t_unit::text[]);
  DELETE FROM share_items WHERE share_id::text = ANY(t_share);
  DELETE FROM share_links WHERE id::text = ANY(t_share);
  -- 销售
  DELETE FROM sales_refund_items WHERE refund_id IN (SELECT id FROM sales_refunds WHERE order_id = ANY(t_sale));
  DELETE FROM sales_refunds WHERE order_id = ANY(t_sale);
  DELETE FROM sales_files WHERE order_id = ANY(t_sale);
  DELETE FROM sales_order_locks WHERE order_id = ANY(t_sale);
  DELETE FROM sales_items WHERE order_id = ANY(t_sale);
  DELETE FROM sales_orders WHERE id = ANY(t_sale);
  -- 借还
  DELETE FROM loan_files WHERE order_id = ANY(t_loan);
  DELETE FROM loan_item_states WHERE item_id IN (SELECT id FROM loan_items WHERE order_id = ANY(t_loan));
  DELETE FROM loan_active_units WHERE order_id = ANY(t_loan) OR unit_id = ANY(t_unit);
  DELETE FROM loan_items WHERE order_id = ANY(t_loan);
  DELETE FROM loan_events WHERE order_id = ANY(t_loan);
  DELETE FROM loan_states WHERE order_id = ANY(t_loan);
  DELETE FROM loan_orders WHERE id = ANY(t_loan);
  -- 维修
  DELETE FROM repair_cost_allocations WHERE order_id = ANY(t_repair) OR unit_id = ANY(t_unit);
  DELETE FROM repair_events WHERE order_id = ANY(t_repair);
  DELETE FROM repair_external_slots WHERE order_id = ANY(t_repair);
  DELETE FROM repair_files WHERE order_id = ANY(t_repair);
  DELETE FROM repair_part_ledger WHERE order_id = ANY(t_repair);
  DELETE FROM repair_payments WHERE order_id = ANY(t_repair);
  DELETE FROM repair_orders WHERE id = ANY(t_repair);
  -- 盘点
  DELETE FROM stocktake_extras WHERE session_id = ANY(t_session) OR unit_id = ANY(t_unit);
  DELETE FROM stocktake_session_units WHERE session_id = ANY(t_session) OR unit_id = ANY(t_unit);
  DELETE FROM stocktake_resolutions WHERE stocktake_id = ANY(t_stocktake);
  DELETE FROM stocktake_sessions WHERE id = ANY(t_session);
  DELETE FROM stocktakes WHERE id = ANY(t_stocktake) AND NOT EXISTS(SELECT 1 FROM stocktake_sessions s WHERE s.stocktake_id=stocktakes.id);
  -- 设备
  DELETE FROM inventory_ledger WHERE unit_id = ANY(t_unit);
  DELETE FROM unit_files WHERE unit_id = ANY(t_unit);
  DELETE FROM unit_inspections WHERE unit_id = ANY(t_unit);
  DELETE FROM unit_identifiers WHERE unit_id = ANY(t_unit) OR acceptance_item_id = ANY(t_acc);
  DELETE FROM units WHERE id = ANY(t_unit);
  -- 采购
  DELETE FROM acceptance_items WHERE id = ANY(t_acc);
  DELETE FROM acceptance_batches WHERE purchase_id = ANY(t_po);
  DELETE FROM shipments WHERE purchase_id = ANY(t_po);
  DELETE FROM purchase_lines WHERE purchase_id = ANY(t_po);
  DELETE FROM purchase_orders WHERE id = ANY(t_po);
  -- 型号、模板、分类
  DELETE FROM tac_mappings WHERE model_id = ANY(t_model);
  DELETE FROM imei_open_tac_mappings WHERE model_id = ANY(t_model);
  DELETE FROM models WHERE id = ANY(t_model);
  UPDATE categories SET template_id=NULL WHERE id = ANY(t_cat);
  DELETE FROM template_versions WHERE template_id = ANY(t_tpl);
  DELETE FROM templates WHERE id = ANY(t_tpl);
  DELETE FROM categories WHERE id = ANY(t_cat);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(t_cat) THEN RAISE EXCEPTION '分类删除数量不符：% / %', n, cardinality(t_cat); END IF;
  RETURN preview || jsonb_build_object('applied', true);
END $$;
REVOKE ALL ON FUNCTION public.xiamu_cleanup_verification(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xiamu_cleanup_verification(boolean) TO service_role;
