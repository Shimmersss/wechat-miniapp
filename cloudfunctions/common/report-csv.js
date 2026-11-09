const { canSee } = require("./stock-view");
const { PERM } = require("./roles");
function csvCell(value) {
  if (typeof value === "number") return String(value);
  let s = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function render(payload, user) {
  const cost = payload.costAccess && canSee(user, "cost"),
    profit =
      payload.profitAccess &&
      canSee(user, "profit") &&
      user.permissions.includes(PERM.PROFIT_VIEW);
  const columns = [
    ["time", "北京时间"],
    ["kind", "业务"],
    ["no", "销售单号"],
    ["name", "型号快照"],
    ["spec", "规格快照"],
    ["store", "门店快照"],
    ["qty", "销售台次"],
    ["returned", "退货台次"],
    ["amount", "收入净额（元）"],
    ["refund", "退款金额（元）"],
    ...(cost ? [["cost", "净成本（元）"]] : []),
    ...(profit ? [["profit", "净毛利（元）"]] : []),
  ];
  return (
    "\uFEFF" +
    [
      columns.map((c) => csvCell(c[1])).join(","),
      ...payload.rows.map((row) =>
        columns.map(([key]) => csvCell(row[key])).join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
module.exports = { render, csvCell };
