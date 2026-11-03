const { transaction, one } = require("./db");
const {
  PERM,
  requirePerm,
  fail,
  id,
  text,
  json,
  audit,
  hash,
} = require("./core");
const { canSee } = require("./stock");
const { period } = require("./sales-stats");
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
module.exports = async function (app, { pool, route }) {
  function authorize(r) {
    requirePerm(r, PERM.EXPORT);
    requirePerm(r, PERM.STATS_VIEW, PERM.DASHBOARD_VIEW);
  }
  function metadata(row) {
    return {
      id: row.id,
      filename: "夏目数码_销售退款_" + row.id + ".csv",
      expiresAt: row.expires_at,
      rows: json(row.payload).rows.length,
    };
  }
  async function owned(db, target, r) {
    const row = await one(
      db,
      "SELECT * FROM report_exports WHERE id=? AND actor_id=?",
      [target, r.user.id],
    );
    if (!row) fail(404, "导出记录不存在");
    if (new Date(row.expires_at).getTime() <= Date.now())
      fail(410, "下载已过期，请重新导出");
    return row;
  }
  route(
    "POST",
    "/stats/export",
    async (r) => {
      authorize(r);
      const d = r.body || {},
        reason = text(d.reason, "导出原因", 500),
        key = text(d.requestKey, "提交标识", 80),
        { start, end } = period(d),
        digest = hash(
          JSON.stringify({
            range: d.range || "day",
            from: d.from || null,
            to: d.to || null,
            reason,
          }),
        );
      const create = () =>
        transaction(pool, async (db) => {
          const previous = await one(
            db,
            "SELECT * FROM report_exports WHERE actor_id=? AND request_key=?",
            [r.user.id, key],
          );
          if (previous) {
            if (previous.request_hash !== digest)
              fail(409, "导出标识已用于其他内容");
            await owned(db, previous.id, r);
            return metadata(previous);
          }
          const sql =
            "SELECT o.created_at time,'收款' kind,o.no,i.name,i.spec,i.store,1 qty,0 returned,i.price amount,0 refund,i.cost cost FROM sales_items i JOIN sales_orders o ON o.id=i.order_id WHERE o.created_at>=? AND o.created_at<? UNION ALL SELECT rf.created_at time,IF(rf.kind='return','退货退款','差价退款') kind,o.no,i.name,i.spec,i.store,0 qty,IF(rf.kind='return',1,0) returned,-ri.amount amount,ri.amount refund,-ri.cost_reversal cost FROM sales_refund_items ri JOIN sales_refunds rf ON rf.id=ri.refund_id JOIN sales_items i ON i.id=ri.sale_item_id JOIN sales_orders o ON o.id=i.order_id WHERE rf.created_at>=? AND rf.created_at<? ORDER BY time,no LIMIT 10001";
          const [records] = await db.execute(sql, [start, end, start, end]);
          if (records.length > 10000)
            fail(400, "明细超过10000行，请缩小日期范围后导出");
          const costAccess = canSee(r.user, "cost"),
            profitAccess =
              canSee(r.user, "profit") &&
              r.user.permissions.includes(PERM.PROFIT_VIEW);
          const rows = records.map((row) => ({
            ...row,
            time: new Date(new Date(row.time).getTime() + 8 * 3600000)
              .toISOString()
              .replace("T", " ")
              .slice(0, 19),
            amount: Number(row.amount),
            refund: Number(row.refund),
            cost: costAccess ? Number(row.cost) : undefined,
            profit: profitAccess
              ? Math.round((Number(row.amount) - Number(row.cost)) * 100) / 100
              : undefined,
          }));
          const payload = {
              from: start,
              to: end,
              rows,
              costAccess,
              profitAccess,
            },
            target = id();
          await db.execute(
            "INSERT INTO report_exports(id,actor_id,request_key,request_hash,payload,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 15 MINUTE))",
            [target, r.user.id, key, digest, JSON.stringify(payload)],
          );
          await audit(db, r, "导出销售退款报表", target, {
            after: {
              from: start,
              to: end,
              rows: rows.length,
              costAccess,
              profitAccess,
            },
            reason,
          });
          return metadata(
            await one(db, "SELECT * FROM report_exports WHERE id=?", [target]),
          );
        });
      try {
        return await create();
      } catch (e) {
        if (e.code === "ER_DUP_ENTRY") {
          const previous = await one(
            pool,
            "SELECT * FROM report_exports WHERE actor_id=? AND request_key=?",
            [r.user.id, key],
          );
          if (previous) {
            if (previous.request_hash !== digest) fail(409, "导出标识内容冲突");
            return metadata(await owned(pool, previous.id, r));
          }
        }
        throw e;
      }
    },
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  );
  route("GET", "/stats/exports/:id", async (r) => {
    authorize(r);
    const row = await owned(pool, r.params.id, r),
      payload = json(row.payload);
    return { ...metadata(row), csv: render(payload, r.user) };
  });
};
module.exports.render = render;
module.exports.csvCell = csvCell;
