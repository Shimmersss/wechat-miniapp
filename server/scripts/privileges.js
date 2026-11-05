/** Local provisioning only. API never imports this module or reads admin credentials. */
const immutable = new Set([
  "audit_logs",
  "template_versions",
  "inventory_ledger",
  "unit_inspections",
  "acceptance_batches",
  "stocktakes",
  "stocktake_resolutions",
  "visit_events",
  "report_exports",
  "share_items",
  "customer_requests",
  "customer_request_events",
  "sales_attributions",
  "loan_orders",
  "agent_orders",
  "agent_earnings",
  "loan_items",
  "loan_events",
  "loan_files",
  "repair_events",
  "repair_files",
  "repair_part_ledger",
  "repair_payments",
  "repair_cost_allocations",
  "sales_orders",
  "sales_items",
  "sales_refunds",
  "sales_refund_items",
  "sales_files",
]);
const deletable = new Set([
  "sessions",
  "repair_external_slots",
  "loan_active_units",
  "agent_unit_locks",
  "sms_challenges",
  "tac_mappings",
  "purchase_lines",
  "unit_identifiers",
  "unit_files",
]);
async function grantRuntime(db, database, user) {
  if (
    !["xiamu", "xiamu_verification"].includes(database) ||
    !["erp_runtime", "erp_test_runtime"].includes(user)
  )
    throw new Error("拒绝操作非项目数据库或账号");
  const [tables] = await db.execute(
    "SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema=? AND TABLE_TYPE='BASE TABLE'",
    [database],
  );
  for (const { name } of tables) {
    if (!/^[a-z_]+$/.test(name)) throw new Error("表名不符合约定");
    const privileges = immutable.has(name)
      ? "SELECT, INSERT"
      : name === "schema_migrations"
        ? "SELECT"
        : deletable.has(name)
          ? "SELECT, INSERT, UPDATE, DELETE"
          : "SELECT, INSERT, UPDATE";
    await db.query(
      `GRANT ${privileges} ON \`${database}\`.\`${name}\` TO '${user}'@'127.0.0.1'`,
    );
  }
}
module.exports = { grantRuntime };
