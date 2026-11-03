const { PERM, SENSITIVE_FIELDS } = require("../constants/roles");
const routes = require("../constants/routes");
const paths = new Set(
  Object.values(routes)
    .map((p) => p.replace(/^\//, ""))
    .filter(
      (p) => !p.startsWith("packages/staff/") && p !== "pages/login/index",
    ),
);
module.exports = function (
  db,
  {
    fail,
    requirePermission,
    paginate,
    currentRole,
    clone,
    staffUnit,
    resolveShare,
    repair,
    agents,
  },
) {
  const events = (db.visitEvents = db.visitEvents || []),
    read = () => requirePermission(PERM.DASHBOARD_VIEW, PERM.STATS_VIEW),
    visible = (k) =>
      !SENSITIVE_FIELDS[k] || SENSITIVE_FIELDS[k].includes(currentRole());
  function period(d = {}) {
    const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    let start = Date.parse(today + "T00:00:00+08:00"),
      end = start + 86400000;
    if (d.range === "week") {
      const day = new Date(start + 28800000).getUTCDay();
      start -= ((day + 6) % 7) * 86400000;
    }
    if (d.range === "month")
      start = Date.parse(today.slice(0, 8) + "01T00:00:00+08:00");
    if (d.from && d.to) {
      start = Date.parse(d.from + "T00:00:00+08:00");
      end = Date.parse(d.to + "T00:00:00+08:00") + 86400000;
    }
    return { start, end };
  }
  function transactions(d) {
    const { start, end } = period(d),
      out = [];
    for (const o of db.salesTransactions || []) {
      if (Date.parse(o.createdAt) >= start && Date.parse(o.createdAt) < end)
        for (const i of o.items)
          out.push({
            model: i.modelId,
            staff: o.sellerId,
            store: i.store,
            label: i.name,
            time: o.createdAt,
            amount: i.cents,
            cost: i.costCents,
            sold: 1,
            returned: 0,
            refund: 0,
          });
      for (const r of o.refunds)
        if (Date.parse(r.time) >= start && Date.parse(r.time) < end)
          for (const row of r.rows) {
            const i = o.items.find((i) => i.id === row.itemId);
            out.push({
              model: i.modelId,
              staff: o.sellerId,
              store: i.store,
              label: i.name,
              time: r.time,
              amount: -row.amountCents,
              cost: r.kind === "return" ? -row.costCents : 0,
              sold: 0,
              returned: r.kind === "return" ? 1 : 0,
              refund: row.amountCents,
            });
          }
    }
    return out;
  }
  function metric(rows) {
    const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0),
      amount = sum("amount") / 100,
      cost = sum("cost") / 100,
      qty = sum("sold");
    return {
      amount,
      qty,
      returnedQty: sum("returned"),
      refundAmount: sum("refund") / 100,
      ...(visible("profit")
        ? {
            profit: Math.round((amount - cost) * 100) / 100,
            margin: amount ? (amount - cost) / amount : 0,
            avgProfit: qty ? (amount - cost) / qty : 0,
          }
        : {}),
    };
  }
  function overview(d) {
    const { start, end } = period(d),
      rows = transactions(d),
      orders = (db.salesTransactions || []).filter(
        (o) =>
          Date.parse(o.createdAt) >= start && Date.parse(o.createdAt) < end,
      ).length;
    const ledger = db.inventoryLedger || [],
      opening = db.units.filter((u) => {
        const last = ledger
          .filter((l) => l.unitId === u.id && Date.parse(l.time) < start)
          .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))[0];
        return last && last.to === "in_stock";
      }).length;
    const m = metric(rows);
    return {
      ...m,
      orders,
      avgOrder: orders ? m.amount / orders : 0,
      openingStock: opening,
      sellThrough: opening ? m.qty / opening : null,
      definition:
        "按收款/退款事件统计；净额扣退款，退货冲回成本；期初库存按已有流水计算。",
    };
  }
  function visits(d) {
    const { start, end } = period(d),
      rows = events.filter((e) => e.time >= start && e.time < end),
      pv = rows.filter((e) => e.type === "pv"),
      distinct = (r) => new Set(r.map((e) => e.visitor)).size;
    return {
      uv: distinct(pv),
      pv: pv.length,
      productViews: pv.filter((e) => e.route === "packages/shop/product/index")
        .length,
      shareVisits: pv.filter((e) => e.source !== "natural").length,
      consultClicks: distinct(rows.filter((e) => e.name === "consult_click")),
      consults: new Set(
        (db.customerRequests || [])
          .filter(
            (r) =>
              Date.parse(r.createdAt) >= start && Date.parse(r.createdAt) < end,
          )
          .map((r) => r.ownerId),
      ).size,
      consultRequests: (db.customerRequests || []).filter(
        (r) =>
          Date.parse(r.createdAt) >= start && Date.parse(r.createdAt) < end,
      ).length,
      appointments: (db.customerRequests || []).filter(
        (r) =>
          r.kind === "appointment" &&
          Date.parse(r.createdAt) >= start &&
          Date.parse(r.createdAt) < end,
      ).length,
      consultBySource: Object.fromEntries(
        ["natural", "customer", "peer", "agent"].map((source) => [
          source,
          new Set(
            (db.customerRequests || [])
              .filter(
                (r) =>
                  r.source === source &&
                  Date.parse(r.createdAt) >= start &&
                  Date.parse(r.createdAt) < end,
              )
              .map((r) => r.ownerId),
          ).size,
        ]),
      ),
      bySource: Object.fromEntries(
        ["natural", "customer", "peer", "agent", "unverified"].map((source) => [
          source,
          distinct(pv.filter((e) => e.source === source)),
        ]),
      ),
      definition:
        "员工页不计访问；咨询人数按实际提交账号去重（含预约）；取消仍保留提交统计。",
    };
  }
  return [
    [
      "POST",
      "/visits/batch",
      (d, h) => {
        if (!d.visitorId || !Array.isArray(d.events) || d.events.length > 100)
          fail(400, "访问数据无效");
        let share = null;
        if (h["X-Channel"]) {
          try {
            share = resolveShare(h["X-Channel"]);
          } catch (e) {
            if (![403, 404, 410, 503].includes(e.code)) throw e;
          }
        }
        let accepted = 0;
        for (const e of d.events) {
          if (!e.eventId) fail(400, "事件编号无效");
          if (e.type === "pv" && !paths.has(e.route)) continue;
          if (
            e.type === "event" &&
            !["consult_click", "share", "poster_save"].includes(e.name)
          )
            continue;
          if (
            events.some(
              (x) => x.visitor === d.visitorId && x.eventId === e.eventId,
            )
          )
            continue;
          events.push({
            visitor: d.visitorId,
            eventId: e.eventId,
            type: e.type,
            name: e.name || "",
            route: e.route || "",
            time: Date.now(),
            source: share
              ? share.channel
              : h["X-Channel"]
                ? "unverified"
                : "natural",
            shareId: share ? share.shareId : null,
            shareOwnerId: share ? share.ownerId : null,
          });
          accepted++;
        }
        return { accepted, ignored: d.events.length - accepted };
      },
    ],
    [
      "GET",
      "/stats/overview",
      (d) => {
        read();
        return overview(d);
      },
    ],
    [
      "GET",
      "/stats/visits",
      (d) => {
        read();
        return visits(d);
      },
    ],
    [
      "GET",
      "/stats/breakdown",
      (d) => {
        read();
        const dimension = d.dimension || "model";
        if (!["model", "staff", "store"].includes(dimension))
          fail(400, "维度无效");
        const rows = transactions(d),
          keys = [...new Set(rows.map((r) => r[dimension]))],
          result = keys.map((key) => ({
            key,
            label:
              dimension === "model"
                ? rows.find((r) => r[dimension] === key).label
                : key || "未指定门店",
            ...metric(rows.filter((r) => r[dimension] === key)),
          }));
        return {
          list: result,
          total: result.length,
          page: 1,
          pageSize: result.length,
        };
      },
    ],
    [
      "GET",
      "/stats/trend",
      (d) => {
        read();
        const { start, end } = period(d),
          rows = transactions(d),
          list = [];
        for (let t = start; t < end; t += 86400000) {
          const day = new Date(t + 28800000).toISOString().slice(0, 10);
          list.push({
            day,
            ...metric(
              rows.filter(
                (r) =>
                  Date.parse(r.time) >= t && Date.parse(r.time) < t + 86400000,
              ),
            ),
          });
        }
        return { list, total: list.length, page: 1, pageSize: list.length };
      },
    ],
    [
      "GET",
      "/stats/visit-trend",
      (d) => {
        read();
        const { start, end } = period(d),
          list = [];
        for (let t = start; t < end; t += 86400000) {
          const day = new Date(t + 28800000).toISOString().slice(0, 10),
            pv = events.filter(
              (e) => e.time >= t && e.time < t + 86400000 && e.type === "pv",
            );
          list.push({
            day,
            uv: new Set(pv.map((e) => e.visitor)).size,
            pv: pv.length,
          });
        }
        return { list, total: list.length, page: 1, pageSize: list.length };
      },
    ],
    [
      "GET",
      "/stats/ageing",
      (d) => {
        read();
        requirePermission(PERM.INVENTORY_VIEW);
        return paginate(
          db.units
            .filter(
              (u) =>
                u.status === "in_stock" && u.ageDays >= Number(d.days ?? 30),
            )
            .map(staffUnit),
          d,
        );
      },
    ],
    [
      "GET",
      "/staff/dashboard",
      () => {
        requirePermission(PERM.DASHBOARD_VIEW);
        const sales = overview({ range: "day" }),
          count = (s) => db.units.filter((u) => u.status === s).length,
          pending = db.purchaseOrders
            .filter((p) =>
              ["arrived", "accepting", "exception"].includes(p.status),
            )
            .reduce(
              (n, p) =>
                n +
                (p.lines || []).reduce(
                  (s, l) => s + l.quantity - l.received,
                  0,
                ),
              0,
            ),
          perms =
            require("../constants/roles").ROLE_PERMISSIONS[currentRole()] || [],
          repairRead = [
            PERM.REPAIR_HANDLE,
            PERM.REPAIR_QUOTE,
            PERM.REPAIR_CASH,
          ].some((p) => perms.includes(p)),
          todos = [];
        if (perms.includes(PERM.CONSULT_MANAGE))
          todos.push({
            key: "customerRequests",
            text: "待跟进咨询预约",
            count: (db.customerRequests || []).filter((r) => r.status === "new")
              .length,
            url: "/packages/staff/consults/index?status=new",
          });
        const agentQueue = agents.pending(perms);
        if (agentQueue.applications !== undefined)
          todos.push({
            key: "agentApplications",
            text: "代理申请待审核",
            count: agentQueue.applications,
            url: "/packages/staff/agents/review",
          });
        if (agentQueue.lockedOrders !== undefined)
          todos.push({
            key: "agentOrders",
            text: "代理订单待确认成交",
            count: agentQueue.lockedOrders,
            url: "/packages/staff/agents/orders?status=locked",
          });
        if (agentQueue.pendingEarnings !== undefined)
          todos.push({
            key: "agentEarnings",
            text: "代理收益待转账（笔）",
            count: agentQueue.pendingEarnings,
            url: "/packages/staff/agents/settlement?status=pending",
          });
        if (perms.includes(PERM.LOAN_MANAGE)) {
          const loans = db.loanTransactions || [],
            today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
          todos.push(
            {
              key: "loanOverdue",
              text: "借还已逾期（单）",
              count: loans.filter(
                (o) =>
                  o.status === "active" &&
                  o.dueAt < today &&
                  o.items.some((i) => i.status === "active"),
              ).length,
              url: "/packages/staff/loans/index?status=overdue",
            },
            {
              key: "loanRecheck",
              text: "出借归还待复检（台）",
              count: loans.reduce(
                (n, o) =>
                  n +
                  o.items.filter((i) => i.status === "returned_recheck").length,
                0,
              ),
              url: "/packages/staff/loans/index?status=returned_recheck",
            },
          );
        }
        if (repairRead) {
          const q = repair.queue();
          todos.push(
            {
              key: "repairOverdue",
              text: "超期维修",
              count: q.overdue,
              url: "/packages/staff/repair/board?overdue=true",
            },
            {
              key: "repairConfirm",
              text: "维修待确认",
              count: q.pendingConfirm,
              url: "/packages/staff/repair/board?status=pending_confirm",
            },
            {
              key: "repairParts",
              text: "维修待配件",
              count: q.waitingParts,
              url: "/packages/staff/repair/board?waitingParts=true",
            },
          );
        }
        return {
          sales: { ...sales, count: sales.qty },
          visits: visits({ range: "day" }),
          ...(repairRead || perms.includes(PERM.STATS_VIEW)
            ? { repair: repair.stats({ range: "day" }) }
            : {}),
          inventory: {
            inStock: count("in_stock"),
            inTransit: db.purchaseOrders
              .filter((p) => p.status === "in_transit")
              .reduce((n, p) => n + p.qty, 0),
            repairing: count("repairing"),
            loanedOut: count("loaned_out"),
            recheck: count("recheck"),
            todayInbound: db.units.filter((u) => u.ageDays === 0).length,
            pendingAcceptance: pending,
            ...(visible("cost")
              ? {
                  stockCost: db.units
                    .filter((u) => u.status === "in_stock")
                    .reduce((n, u) => n + u.cost, 0),
                }
              : {}),
          },
          todos,
        };
      },
    ],
  ];
};
