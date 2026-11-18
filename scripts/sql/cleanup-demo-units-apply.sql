DO $cleanup$
DECLARE
  current_preview jsonb;
  targets uuid[];
  removed integer;
  repairs uuid[];
BEGIN
  -- Prevent new financial or protected references between classification and deletion.
  LOCK TABLE units, sales_items, agent_orders, repair_orders, repair_payments,
    acceptance_items, customer_requests, stocktake_session_units, stocktake_extras
    IN SHARE ROW EXCLUSIVE MODE;

  SELECT preview, eligible_ids INTO current_preview, targets FROM (
    /* PREVIEW_QUERY */
  ) AS current_candidates;
  IF (current_preview->>'count')::integer <> /* EXPECTED_COUNT */
     OR current_preview->>'fingerprint' <> /* EXPECTED_FINGERPRINT */ THEN
    RAISE EXCEPTION '待删清单已变化，请重新预览';
  END IF;
  SELECT coalesce(array_agg(id), '{}') INTO repairs FROM repair_orders WHERE unit_id=ANY(targets);

  DELETE FROM loan_item_states WHERE item_id IN (SELECT id FROM loan_items WHERE unit_id=ANY(targets));
  DELETE FROM loan_active_units WHERE unit_id=ANY(targets);
  DELETE FROM loan_items WHERE unit_id=ANY(targets);
  DELETE FROM repair_cost_allocations WHERE order_id=ANY(repairs) OR unit_id=ANY(targets);
  DELETE FROM repair_events WHERE order_id=ANY(repairs);
  DELETE FROM repair_external_slots WHERE order_id=ANY(repairs);
  DELETE FROM repair_files WHERE order_id=ANY(repairs);
  DELETE FROM repair_part_ledger WHERE order_id=ANY(repairs);
  DELETE FROM repair_orders WHERE id=ANY(repairs);
  DELETE FROM agent_markups WHERE unit_id=ANY(targets);
  DELETE FROM share_items WHERE unit_id=ANY(targets);
  DELETE FROM inventory_ledger WHERE unit_id=ANY(targets);
  DELETE FROM unit_inspections WHERE unit_id=ANY(targets);
  DELETE FROM unit_files WHERE unit_id=ANY(targets);
  UPDATE unit_identifiers SET unit_id=NULL WHERE unit_id=ANY(targets) AND acceptance_item_id IS NOT NULL;
  DELETE FROM unit_identifiers WHERE unit_id=ANY(targets);
  DELETE FROM units WHERE id=ANY(targets);
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> cardinality(targets) THEN
    RAISE EXCEPTION '删除数量不符，事务已回滚';
  END IF;
END
$cleanup$;
