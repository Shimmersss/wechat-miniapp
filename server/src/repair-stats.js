const { one } = require("./db");
const { PERM, requirePerm, text } = require("./core");
const { canSee } = require("./stock");
const { period } = require("./sales-stats");
module.exports = async function (app, { pool, route, scope }) {
  async function stats(r) {
    requirePerm(
      r,
      PERM.REPAIR_HANDLE,
      PERM.REPAIR_QUOTE,
      PERM.REPAIR_CASH,
      PERM.STATS_VIEW,
    );
    const { start, end } = period(r.query || {}),
      s = r.user.permissions.some((p) =>
        [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH].includes(p),
      )
        ? scope(r)
        : { where: [], args: [] },
      where = s.where.map((w) => "o." + w);
    if (r.query?.engineerId) {
      where.push("o.engineer_id=?");
      s.args.push(text(r.query.engineerId, "工程师", 36));
    }
    const scopedClause = where.length ? " AND " + where.join(" AND ") : "";
    const count = await one(
      pool,
      "SELECT SUM(created_at>=? AND created_at<?) created,SUM(created_at>=? AND created_at<? AND status='completed') cohort_completed,SUM(completed_at>=? AND completed_at<?) completed,AVG(CASE WHEN completed_at>=? AND completed_at<? THEN TIMESTAMPDIFF(SECOND,created_at,completed_at)/3600 END) avg_hours FROM repair_orders o WHERE 1=1" +
        scopedClause,
      [start, end, start, end, start, end, start, end, ...s.args],
    );
    const cash = await one(
      pool,
      "SELECT COALESCE(SUM(CASE p.kind WHEN 'receipt' THEN p.amount WHEN 'refund' THEN -p.amount ELSE 0 END),0) revenue,COALESCE(SUM(CASE p.kind WHEN 'expense' THEN p.amount WHEN 'expense_refund' THEN -p.amount ELSE 0 END),0) expenses FROM repair_payments p JOIN repair_orders o ON o.id=p.order_id WHERE o.kind='external' AND p.created_at>=? AND p.created_at<?" +
        scopedClause,
      [start, end, ...s.args],
    );
    const parts = await one(
      pool,
      "SELECT COALESCE(SUM(CASE l.kind WHEN 'issue' THEN l.cost_amount WHEN 'return' THEN -l.cost_amount ELSE 0 END),0) cost FROM repair_part_ledger l JOIN repair_orders o ON o.id=l.order_id WHERE o.kind='external' AND l.created_at>=? AND l.created_at<?" +
        scopedClause,
      [start, end, ...s.args],
    );
    const own = await one(
      pool,
      "SELECT COALESCE(SUM(total_cost),0) cost FROM repair_cost_allocations a JOIN repair_orders o ON o.id=a.order_id WHERE a.created_at>=? AND a.created_at<?" +
        scopedClause,
      [start, end, ...s.args],
    );
    const revenue = Number(cash.revenue),
      partsCost = Number(parts.cost),
      expenses = Number(cash.expenses);
    return {
      created: Number(count.created || 0),
      completed: Number(count.completed || 0),
      completionRate: Number(count.created)
        ? Number(count.cohort_completed) / Number(count.created)
        : 0,
      avgHours: Number(count.avg_hours || 0),
      revenue,
      ...(canSee(r.user, "cost")
        ? { partsCost, expenses, internalRepairCost: Number(own.cost) }
        : {}),
      ...(canSee(r.user, "profit") &&
      r.user.permissions.includes(PERM.PROFIT_VIEW)
        ? { profit: Math.round((revenue - partsCost - expenses) * 100) / 100 }
        : {}),
      definition:
        "开单完成率按本期开单队列；均时按本期完工。收入/退款、配件领退和费用按发生期统计；自有机成本另列，避免重复计入对客维修毛利。",
    };
  }
  async function queue(r) {
    const s = scope(r),
      clause = s.where.length ? " AND " + s.where.join(" AND ") : "";
    const row = await one(
      pool,
      "SELECT SUM(expected_date<DATE(DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))) overdue,SUM(status='pending_confirm') pending_confirm,SUM(waiting_parts=TRUE) waiting_parts FROM repair_orders WHERE status NOT IN ('completed','cancelled')" +
        clause,
      s.args,
    );
    return {
      overdue: Number(row.overdue || 0),
      pendingConfirm: Number(row.pending_confirm || 0),
      waitingParts: Number(row.waiting_parts || 0),
    };
  }
  route("GET", "/repair-orders/stats", stats);
  return { stats, queue };
};
