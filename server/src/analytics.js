const { transaction, one } = require("./db");
const { PERM, fail, text, hmac, requirePerm, list, page } = require("./core");
const { integer } = require("./validation");
const { canSee, stockService, unitSelect } = require("./stock");
const { period } = require("./sales-stats");
const appConfig = require("../../miniprogram/app.json");
const paths = new Set(
  appConfig.pages
    .filter((p) => p !== "pages/login/index")
    .concat(
      appConfig.subPackages
        .filter((s) => s.name !== "staff")
        .flatMap((s) => s.pages.map((p) => s.root + "/" + p)),
    ),
);
module.exports = async function (
  app,
  { pool, config, route, salesStats, shareService, repair },
) {
  const read = (r) => requirePerm(r, PERM.DASHBOARD_VIEW, PERM.STATS_VIEW),
    stock = stockService({ config });
  async function visits(r) {
    read(r);
    const { start, end } = period(r.query || {});
    const row = await one(
      pool,
      "SELECT COUNT(DISTINCT CASE WHEN type='pv' THEN visitor_hash END) uv,SUM(type='pv') pv,SUM(type='pv' AND route='packages/shop/product/index') productViews,SUM(type='pv' AND source<>'natural') shareVisits,COUNT(DISTINCT CASE WHEN name='consult_click' THEN visitor_hash END) consultClicks FROM visit_events WHERE created_at>=? AND created_at<?",
      [start, end],
    );
    const [sources] = await pool.execute(
      "SELECT source,COUNT(DISTINCT visitor_hash) n FROM visit_events WHERE type='pv' AND created_at>=? AND created_at<? GROUP BY source",
      [start, end],
    );
    const submitted = await one(
      pool,
      "SELECT COUNT(DISTINCT owner_id) people,COUNT(*) requests,SUM(kind='appointment') appointments FROM customer_requests WHERE created_at>=? AND created_at<?",
      [start, end],
    );
    const [requestSources] = await pool.execute(
      "SELECT source,COUNT(DISTINCT owner_id) n FROM customer_requests WHERE created_at>=? AND created_at<? GROUP BY source",
      [start, end],
    );
    return {
      uv: Number(row.uv),
      pv: Number(row.pv || 0),
      productViews: Number(row.productViews || 0),
      shareVisits: Number(row.shareVisits || 0),
      consultClicks: Number(row.consultClicks || 0),
      consults: Number(submitted.people),
      consultRequests: Number(submitted.requests),
      appointments: Number(submitted.appointments || 0),
      consultBySource: {
        natural: 0,
        customer: 0,
        peer: 0,
        agent: 0,
        ...Object.fromEntries(
          requestSources.map((s) => [s.source, Number(s.n)]),
        ),
      },
      bySource: {
        natural: 0,
        customer: 0,
        peer: 0,
        agent: 0,
        unverified: 0,
        ...Object.fromEntries(sources.map((s) => [s.source, Number(s.n)])),
      },
      definition:
        "UV按匿名标识去重；员工经营页不计入；咨询人数按实际提交账号去重（含预约）；取消仍保留提交统计；未核验分享来源单列。",
    };
  }
  route(
    "POST",
    "/visits/batch",
    async (r) => {
      const d = r.body || {},
        visitor = text(d.visitorId, "匿名标识", 100);
      if (
        !/^[A-Za-z0-9_-]{8,100}$/.test(visitor) ||
        !Array.isArray(d.events) ||
        !d.events.length ||
        d.events.length > 100
      )
        fail(400, "访问上报格式无效");
      const visitorHash = hmac(config.otpKey, "visitor:" + visitor),
        share = r.headers["x-channel"];
      if (share && (typeof share !== "string" || share.length > 100))
        fail(400, "分享标识无效");
      // Invalid/revoked sources are counted separately; no client channel claim is trusted.
      let verified = null;
      if (share) {
        try {
          verified = await shareService.resolve(pool, share, r.user);
        } catch (error) {
          if (![403, 404, 410, 503].includes(error.statusCode)) throw error;
        }
      }
      const planned = [];
      for (const e of d.events) {
        if (!e || !["pv", "event"].includes(e.type)) fail(400, "事件类型无效");
        const eventId = text(e.eventId, "事件标识", 100);
        if (!/^[A-Za-z0-9_-]{8,100}$/.test(eventId)) fail(400, "事件标识无效");
        const path = e.route
          ? text(e.route, "页面路径", 150).replace(/^\//, "")
          : "";
        if (e.type === "pv" && !paths.has(path)) continue;
        const name = e.type === "event" ? text(e.name, "事件名称", 40) : "";
        if (name && !["consult_click", "share", "poster_save"].includes(name))
          continue;
        const unitId = e.unitId ? text(e.unitId, "设备编号", 60) : null;
        if (
          unitId &&
          !(await one(pool, "SELECT id FROM units WHERE id=?", [unitId]))
        )
          continue;
        planned.push({ eventId, type: e.type, name, path, unitId });
      }
      let accepted = 0;
      await transaction(pool, async (db) => {
        for (const e of planned) {
          const [result] = await db.execute(
            "INSERT IGNORE INTO visit_events(visitor_hash,event_id,type,name,route,unit_id,source,share_hash,share_id,share_owner_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [
              visitorHash,
              e.eventId,
              e.type,
              e.name,
              e.path,
              e.unitId,
              verified
                ? verified.link.channel
                : share
                  ? "unverified"
                  : "natural",
              share ? hmac(config.otpKey, "share:" + share) : null,
              verified ? verified.link.id : null,
              verified ? verified.link.owner_id : null,
            ],
          );
          accepted += result.affectedRows;
        }
      });
      return { accepted, ignored: d.events.length - accepted };
    },
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  );
  route("GET", "/stats/visits", visits);
  route("GET", "/stats/visit-trend", async (r) => {
    read(r);
    const { start, end } = period(r.query);
    const [rows] = await pool.execute(
      "SELECT DATE_FORMAT(DATE_ADD(created_at,INTERVAL 8 HOUR),'%Y-%m-%d') day,COUNT(DISTINCT CASE WHEN type='pv' THEN visitor_hash END) uv,SUM(type='pv') pv FROM visit_events WHERE created_at>=? AND created_at<? GROUP BY day",
      [start, end],
    );
    const result = [];
    for (let at = +start; at < +end; at += 86400000) {
      const day = new Date(at + 8 * 3600000).toISOString().slice(0, 10),
        row = rows.find((r) => r.day === day);
      result.push({ day, uv: Number(row?.uv || 0), pv: Number(row?.pv || 0) });
    }
    return list(result, result.length, { page: 1, pageSize: result.length });
  });
  route("GET", "/stats/ageing", async (r) => {
    read(r);
    requirePerm(r, PERM.INVENTORY_VIEW);
    const days = integer(r.query.days ?? 30, "库龄", 0, 36500),
      p = page(r.query);
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM units WHERE status='in_stock' AND TIMESTAMPDIFF(DAY,created_at,UTC_TIMESTAMP(3))>=?",
      [days],
    );
    const [rows] = await pool.query(
      unitSelect +
        " WHERE u.status='in_stock' AND TIMESTAMPDIFF(DAY,u.created_at,UTC_TIMESTAMP(3))>=? ORDER BY u.created_at,u.id LIMIT ? OFFSET ?",
      [days, p.pageSize, p.offset],
    );
    return list(
      await Promise.all(rows.map((u) => stock.view(pool, u, r))),
      count.n,
      p,
    );
  });
  route("GET", "/staff/dashboard", async (r) => {
    requirePerm(r, PERM.DASHBOARD_VIEW);
    const day = { ...r, query: { range: "day" } },
      sales = await salesStats.overview(day),
      vis = await visits(day),
      { start, end } = period(day.query);
    const [counts] = await pool.execute(
      "SELECT status,COUNT(*) n FROM units GROUP BY status",
    );
    const map = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
    const added = await one(
      pool,
      "SELECT COUNT(*) n FROM units WHERE ownership='own' AND created_at>=? AND created_at<?",
      [start, end],
    );
    const pending = await one(
      pool,
      "SELECT COALESCE(SUM(l.quantity-l.received_count),0) n FROM purchase_lines l JOIN purchase_orders p ON p.id=l.purchase_id WHERE p.status IN ('arrived','accepting','exception')",
    );
    const transit = await one(
      pool,
      "SELECT COALESCE(SUM(l.quantity-l.received_count),0) n FROM purchase_lines l JOIN purchase_orders p ON p.id=l.purchase_id WHERE p.status='in_transit'",
    );
    const age = await one(
      pool,
      "SELECT COUNT(*) n FROM units WHERE status='in_stock' AND TIMESTAMPDIFF(DAY,created_at,UTC_TIMESTAMP(3))>30",
    );
    const inventory = {
      inStock: map.in_stock || 0,
      inTransit: Number(transit.n),
      repairing: map.repairing || 0,
      loanedOut: map.loaned_out || 0,
      recheck: map.recheck || 0,
      todayInbound: Number(added.n),
      pendingAcceptance: Number(pending.n),
    };
    if (canSee(r.user, "cost"))
      inventory.stockCost = Number(
        (
          await one(
            pool,
            "SELECT COALESCE(SUM(cost),0) n FROM units WHERE status='in_stock'",
          )
        ).n,
      );
    const todos = [];
    if (r.user.permissions.includes(PERM.CONSULT_MANAGE)) {
      const pending = await one(
        pool,
        "SELECT COUNT(*) n FROM customer_request_states WHERE status='new'",
      );
      todos.push({
        key: "customerRequests",
        text: "待跟进咨询预约",
        count: Number(pending.n),
        url: "/packages/staff/consults/index?status=new",
      });
    }
    if (r.user.permissions.includes(PERM.ACCEPTANCE))
      todos.push({
        key: "acceptance",
        text: "待验收台数",
        count: Number(pending.n),
        url: "/packages/staff/purchase/list?status=arrived",
      });
    if (r.user.permissions.includes(PERM.INVENTORY_VIEW))
      todos.push(
        {
          key: "recheck",
          text: "待复检",
          count: inventory.recheck,
          url: "/packages/staff/inventory/list?status=recheck",
        },
        {
          key: "ageing",
          text: "库龄超过30天",
          count: Number(age.n),
          url: "/packages/staff/inventory/list?ageingOver=31",
        },
      );
    if (r.user.permissions.includes(PERM.LOAN_MANAGE)) {
      const overdue = await one(
          pool,
          "SELECT COUNT(*) n FROM loan_orders o JOIN loan_states s ON s.order_id=o.id WHERE s.status='active' AND o.due_date<DATE(DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))",
        ),
        returned = await one(
          pool,
          "SELECT COUNT(*) n FROM loan_item_states WHERE status='returned_recheck'",
        );
      todos.push(
        {
          key: "loanOverdue",
          text: "借还已逾期（单）",
          count: Number(overdue.n),
          url: "/packages/staff/loans/index?status=overdue",
        },
        {
          key: "loanRecheck",
          text: "出借归还待复检（台）",
          count: Number(returned.n),
          url: "/packages/staff/loans/index?status=returned_recheck",
        },
      );
    }
    const repairRead = r.user.permissions.some((p) =>
      [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH].includes(p),
    );
    const repairStats =
      repairRead || r.user.permissions.includes(PERM.STATS_VIEW)
        ? await repair.stats.stats(day)
        : undefined;
    if (repairRead) {
      const q = await repair.stats.queue(r);
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
      ...(repairStats ? { repair: repairStats } : {}),
      sales: { ...sales, count: sales.qty },
      inventory,
      visits: vis,
      todos,
      unavailable: ["借还逾期与代理待结算将随单据模块接通"],
    };
  });
};
