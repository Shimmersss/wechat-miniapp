const { canSee, unit } = require("./stock-view");
const { view: repairView } = require("./repair-view");
const audit = require("./audit-view");
const definition =
  "按收款/退款发生时间统计净收入；退货冲回原成本，差价退款仅减收入；动销率分母为起日0点可售库存。";
const visitsDefinition =
  "UV按匿名标识去重；员工经营页不计入；咨询人数按实际提交账号去重（含预约）；取消仍保留提交统计；未核验分享来源单列。";
function metric(r, u) {
  const amount = Number(r.amount || 0),
    cost = Number(r.cost || 0),
    sold = Number(r.sold || 0);
  return {
    amount,
    qty: sold,
    returnedQty: Number(r.returned || 0),
    refundAmount: Number(r.refund || 0),
    ...(canSee(u, "profit") && u.permissions.includes("profit:view")
      ? {
          profit: Math.round((amount - cost) * 100) / 100,
          margin: amount ? (amount - cost) / amount : 0,
          avgProfit: sold ? (amount - cost) / sold : 0,
        }
      : {}),
  };
}
function overview(r, u, d) {
  return {
    ...metric(r, u),
    orders: Number(r.orders),
    avgOrder: Number(r.orders) ? Number(r.amount) / Number(r.orders) : 0,
    openingStock: Number(r.opening),
    sellThrough: Number(r.opening) ? Number(r.sold) / Number(r.opening) : null,
    from: d.start,
    to: d.end,
    definition,
  };
}
const visits = (r) => ({
  ...Object.fromEntries(
    [
      "uv",
      "pv",
      "productViews",
      "shareVisits",
      "consultClicks",
      "consults",
      "consultRequests",
      "appointments",
    ].map((k) => [k, Number(r[k])]),
  ),
  bySource: r.bySource,
  consultBySource: r.consultBySource,
  definition: visitsDefinition,
});
function view(a, r, u, d) {
  if (a === "overview") return overview(r, u, d);
  if (a === "visits") return visits(r);
  if (a === "trend" || a === "visit-trend" || a === "breakdown") {
    const list = r.map((x) =>
      a === "visit-trend"
        ? { day: x.day, uv: Number(x.uv), pv: Number(x.pv) }
        : {
            ...(a === "trend"
              ? { day: x.day }
              : { key: x.key, label: x.label }),
            ...metric(x, u),
          },
    );
    return { list, total: list.length, page: 1, pageSize: list.length };
  }
  if (a === "agent-earnings")
    return {
      ...r,
      from: d.start,
      to: d.end,
      definition:
        "成交收益按收款时间，退货冲回按退货时间，已转账按标记时间；待转账为当前累计（含已转账后退货生成的负数冲回）。",
    };
  if (a === "ageing")
    return {
      list: r.rows.map((x) => unit(x, u)),
      total: Number(r.total),
      page: d.page,
      pageSize: d.pageSize,
    };
  if (a === "audit.list") return audit.list(r, u, d);
  if (a === "audit.filters") return { actions: r.actions, actors: r.actors };
  if (a === "dashboard") {
    const inventory = Object.fromEntries(
      [
        "inStock",
        "inTransit",
        "repairing",
        "loanedOut",
        "recheck",
        "todayInbound",
        "pendingAcceptance",
      ].map((k) => [k, Number(r.inventory[k])]),
    );
    if (canSee(u, "cost")) inventory.stockCost = Number(r.inventory.stockCost);
    const defs = [
      [
        "customerRequests",
        "待跟进咨询预约",
        "/packages/staff/consults/index?status=new",
        ["consult:manage"],
      ],
      [
        "acceptance",
        "待验收台数",
        "/packages/staff/purchase/list?status=arrived",
        ["acceptance:do"],
      ],
      [
        "recheck",
        "待复检",
        "/packages/staff/inventory/list?status=recheck",
        ["inventory:view"],
      ],
      [
        "ageing",
        "库龄超过30天",
        "/packages/staff/inventory/list?ageingOver=31",
        ["inventory:view"],
      ],
      [
        "agentApplications",
        "代理申请待审核",
        "/packages/staff/agents/review",
        ["agent:review"],
      ],
      [
        "agentOrders",
        "代理订单待确认成交",
        "/packages/staff/agents/orders?status=locked",
        ["sales:create", "agent:review"],
      ],
      [
        "agentEarnings",
        "代理收益待转账（笔）",
        "/packages/staff/agents/settlement?status=pending",
        ["agent:settle"],
      ],
      [
        "loanOverdue",
        "借还已逾期（单）",
        "/packages/staff/loans/index?status=overdue",
        ["loan:manage"],
      ],
      [
        "loanRecheck",
        "出借归还待复检（台）",
        "/packages/staff/loans/index?status=returned_recheck",
        ["loan:manage"],
      ],
      [
        "repairOverdue",
        "超期维修",
        "/packages/staff/repair/board?overdue=true",
        ["repair:handle", "repair:quote", "repair:cash"],
      ],
      [
        "repairConfirm",
        "维修待确认",
        "/packages/staff/repair/board?status=pending_confirm",
        ["repair:handle", "repair:quote", "repair:cash"],
      ],
      [
        "repairParts",
        "维修待配件",
        "/packages/staff/repair/board?waitingParts=true",
        ["repair:handle", "repair:quote", "repair:cash"],
      ],
    ];
    const todos = defs
      .filter(([, , , p]) => p.some((k) => u.permissions.includes(k)))
      .map(([key, text, url]) => ({
        key,
        text,
        url,
        count:
          key === "acceptance"
            ? inventory.pendingAcceptance
            : key === "recheck"
              ? inventory.recheck
              : Number(r.counts[key]),
      }));
    return {
      sales: { ...overview(r.sales, u, d), count: Number(r.sales.sold) },
      inventory,
      visits: visits(r.visits),
      todos,
      ...(r.repair ? { repair: repairView("stats", r.repair, u, {}) } : {}),
      unavailable: [],
    };
  }
  return r;
}
module.exports = { view, metric };
