-- 与 repair-service.totals 的 money() 一致：工单累计收款/费用/配件净成本须在金额范围内。
CREATE OR REPLACE FUNCTION repair_totals(oid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE received_v numeric(14,2); expenses_v numeric(14,2); parts_v numeric(14,2);
BEGIN
 SELECT coalesce(sum(CASE kind WHEN 'receipt' THEN amount WHEN 'refund' THEN -amount ELSE 0 END),0),coalesce(sum(CASE kind WHEN 'expense' THEN amount WHEN 'expense_refund' THEN -amount ELSE 0 END),0) INTO received_v,expenses_v FROM repair_payments WHERE order_id=oid;
 SELECT coalesce(sum(CASE kind WHEN 'issue' THEN cost_amount ELSE -cost_amount END),0) INTO parts_v FROM repair_part_ledger WHERE order_id=oid;
 IF received_v<0 OR expenses_v<0 OR parts_v<0 THEN PERFORM stock_error('P0400','金额合计超出允许范围'); END IF;
 RETURN jsonb_build_object('received',received_v,'expenses',expenses_v,'parts',parts_v);
END $$;
REVOKE ALL ON FUNCTION repair_totals(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION repair_totals(uuid) TO service_role;
