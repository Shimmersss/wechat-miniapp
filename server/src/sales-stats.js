const { one } = require("./db");
const { PERM, requirePerm, fail, list } = require("./core");
const { date } = require("./validation");
const { canSee } = require("./stock");
const DAY = 86400000;
function period(q) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    now = new Date(today + "T00:00:00+08:00");
  let start = new Date(now);
  if (q.from || q.to) {
    if (!q.from || !q.to) fail(400, "请同时填写起止日期");
    start = new Date(date(q.from) + "T00:00:00+08:00");
    const end = new Date(Date.parse(date(q.to) + "T00:00:00+08:00") + DAY);
    if (end <= start || end - start > 366 * DAY)
      fail(400, "统计范围需为1～366天");
    return { start, end };
  }
  const range = q.range || "day";
  if (!["day", "week", "month"].includes(range)) fail(400, "统计周期无效");
  if (range === "week") {
    const weekday = new Date(now.getTime() + 8 * 3600000).getUTCDay();
    start = new Date(now.getTime() - ((weekday + 6) % 7) * DAY);
  }
  if (range === "month")
    start = new Date(today.slice(0, 8) + "01T00:00:00+08:00");
  return { start, end: new Date(now.getTime() + DAY) };
}
const events =
  "SELECT o.created_at time,i.model_id modelId,i.name modelName,o.seller_id sellerId,i.store,i.price revenue,i.cost cost,1 sold,0 returned,0 refund FROM sales_items i JOIN sales_orders o ON o.id=i.order_id UNION ALL SELECT r.created_at time,i.model_id modelId,i.name modelName,o.seller_id sellerId,i.store,-ri.amount revenue,-ri.cost_reversal cost,0 sold,IF(r.kind='return',1,0) returned,ri.amount refund FROM sales_refund_items ri JOIN sales_refunds r ON r.id=ri.refund_id JOIN sales_items i ON i.id=ri.sale_item_id JOIN sales_orders o ON o.id=i.order_id";
module.exports = async function (app, { pool, route }) {
  const read = (r) => requirePerm(r, PERM.STATS_VIEW, PERM.DASHBOARD_VIEW);
  function metric(row, r) {
    const amount = Number(row.amount || 0),
      cost = Number(row.cost || 0),
      sold = Number(row.sold || 0);
    return {
      amount,
      qty: sold,
      returnedQty: Number(row.returned || 0),
      refundAmount: Number(row.refund || 0),
      ...(canSee(r.user, "profit") &&
      r.user.permissions.includes(PERM.PROFIT_VIEW)
        ? {
            profit: Math.round((amount - cost) * 100) / 100,
            margin: amount ? (amount - cost) / amount : 0,
            avgProfit: sold ? (amount - cost) / sold : 0,
          }
        : {}),
    };
  }
  async function overview(r) {
    read(r);
    const { start, end } = period(r.query),
      row = await one(
        pool,
        "SELECT SUM(revenue) amount,SUM(cost) cost,SUM(sold) sold,SUM(returned) returned,SUM(refund) refund FROM (" +
          events +
          ") e WHERE e.time>=? AND e.time<?",
        [start, end],
      );
    const orders = await one(
      pool,
      "SELECT COUNT(*) n FROM sales_orders WHERE created_at>=? AND created_at<?",
      [start, end],
    );
    const opening = await one(
      pool,
      "SELECT COUNT(*) n FROM units u WHERE u.created_at<? AND (SELECT l.to_status FROM inventory_ledger l WHERE l.unit_id=u.id AND l.created_at<? ORDER BY l.created_at DESC,l.id DESC LIMIT 1)='in_stock'",
      [start, start],
    );
    return {
      ...metric(row, r),
      orders: Number(orders.n),
      avgOrder: Number(orders.n)
        ? Number(row.amount || 0) / Number(orders.n)
        : 0,
      openingStock: Number(opening.n),
      sellThrough: Number(opening.n)
        ? Number(row.sold || 0) / Number(opening.n)
        : null,
      from: start,
      to: end,
      definition:
        "按收款/退款发生时间统计净收入；退货冲回原成本，差价退款仅减收入；动销率分母为起日0点可售库存。",
    };
  }
  route("GET", "/stats/overview", overview);
  route("GET", "/stats/breakdown", async (r) => {
    read(r);
    const { start, end } = period(r.query),
      dimension = r.query.dimension || "model",
      columns = { model: "modelId", staff: "sellerId", store: "store" };
    if (!Object.hasOwn(columns, dimension)) fail(400, "统计维度无效");
    const key = columns[dimension];
    const [rows] = await pool.query(
      "SELECT " +
        key +
        " dimensionKey,MAX(modelName) modelName,SUM(revenue) amount,SUM(cost) cost,SUM(sold) sold,SUM(returned) returned,SUM(refund) refund FROM (" +
        events +
        ") e WHERE time>=? AND time<? GROUP BY " +
        key +
        " ORDER BY amount DESC",
      [start, end],
    );
    const result = [];
    for (const row of rows) {
      let label =
        dimension === "model"
          ? row.modelName
          : row.dimensionKey || "未指定门店";
      if (dimension === "staff") {
        const user = await one(
          pool,
          "SELECT COALESCE(s.name,u.nickname) name FROM users u LEFT JOIN staff s ON s.user_id=u.id WHERE u.id=?",
          [row.dimensionKey],
        );
        label = user?.name || "未知员工";
      }
      result.push({ key: row.dimensionKey, label, ...metric(row, r) });
    }
    return list(result, result.length, { page: 1, pageSize: result.length });
  });
  route("GET", "/stats/trend", async (r) => {
    read(r);
    const { start, end } = period(r.query);
    const [rows] = await pool.query(
      "SELECT DATE_FORMAT(DATE_ADD(time,INTERVAL 8 HOUR),'%Y-%m-%d') day,SUM(revenue) amount,SUM(cost) cost,SUM(sold) sold,SUM(returned) returned,SUM(refund) refund FROM (" +
        events +
        ") e WHERE time>=? AND time<? GROUP BY day ORDER BY day",
      [start, end],
    );
    const result = [];
    for (let at = start.getTime(); at < end.getTime(); at += DAY) {
      const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10),
        row = rows.find((r) => r.day === day) || {};
      result.push({ day, ...metric(row, r) });
    }
    return list(result, result.length, { page: 1, pageSize: result.length });
  });
  return { overview };
};
module.exports.period = period;
