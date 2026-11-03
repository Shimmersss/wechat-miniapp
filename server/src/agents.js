const crypto = require("node:crypto");
const { transaction, one } = require("./db");
const {
  PERM,
  fail,
  text,
  id,
  json,
  page,
  list,
  requirePerm,
  audit,
} = require("./core");
const { cents, money } = require("./validation");
const { stockService, unitSelect } = require("./stock");
const { isPhone } = require("../../miniprogram/utils/validate");

/**
 * 代理（框架文档 七、十三.1/.7）：加价归代理、固定金额上限、按单记账线下转账；只做一级邀请。
 * 代理链接下单 = customer_requests(kind=order) + 短时锁库；门店收银按分享价快照成交后记一条收益，
 * 退货冲回：未转账的直接冲回，已转账的生成冲回记录在后续转账中抵扣。
 */
module.exports = async function (app, { pool, config, route, shareService }) {
  const stock = stockService({ config });
  const todayStart =
    "DATE_SUB(DATE(DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR)),INTERVAL 8 HOUR)";
  const login = (r) => {
    if (!r.user) fail(401, "请先登录");
  };
  function lockMinutes() {
    const m = Number(config.agent?.lockMinutes ?? 30);
    if (!Number.isInteger(m) || m < 5 || m > 1440)
      fail(503, "代理下单锁库时长配置无效");
    return m;
  }
  const maskPhone = (p) => (p ? p.slice(0, 3) + "****" + p.slice(-4) : "");
  const maskName = (n) =>
    n ? n.slice(0, 1) + "*".repeat(Math.max(1, n.length - 1)) : "";
  async function settings(db) {
    return one(db, "SELECT * FROM agent_settings WHERE id=1");
  }
  async function agentRow(db, userId, lock = false) {
    return one(
      db,
      "SELECT * FROM agents WHERE user_id=?" + (lock ? " FOR UPDATE" : ""),
      [userId],
    );
  }
  async function activeAgent(db, r) {
    login(r);
    const row = r.user.staffNo ? null : await agentRow(db, r.user.id);
    if (!row || row.status !== "active" || r.user.role !== "agent")
      fail(403, "仅已审核通过的代理可使用");
    return row;
  }
  function agentView(row, inviter) {
    if (!row) return { status: "none" };
    return {
      status: row.status,
      name: row.name,
      phone: row.phone,
      region: row.region,
      appliedAt: row.applied_at,
      ...(row.status === "active"
        ? {
            markupMax: Number(row.markup_max),
            inviteCode: row.invite_code,
          }
        : {}),
      ...(row.status === "rejected" ? { reviewRemark: row.review_remark } : {}),
      ...(inviter ? { inviterName: inviter.name } : {}),
    };
  }
  function adminView(row) {
    return {
      id: row.user_id,
      status: row.status,
      name: row.name,
      phone: row.phone,
      region: row.region,
      inviterId: row.inviter_id,
      inviterName: row.inviter_name || null,
      inviteCode: row.invite_code,
      markupMax: row.markup_max === null ? null : Number(row.markup_max),
      reviewRemark: row.review_remark,
      reviewedAt: row.reviewed_at,
      appliedAt: row.applied_at,
      version: row.version,
    };
  }
  async function inviteCode(db) {
    for (let i = 0; i < 10; i++) {
      const code = crypto
        .randomBytes(6)
        .toString("base64url")
        .replace(/[-_]/g, "")
        .slice(0, 8)
        .toUpperCase();
      if (
        code.length === 8 &&
        !(await one(db, "SELECT user_id FROM agents WHERE invite_code=?", [
          code,
        ]))
      )
        return code;
    }
    fail(503, "邀请码生成失败，请重试");
  }

  // ---------- 代理本人：申请、资料、邀请 ----------
  route(
    "POST",
    "/agent/applications",
    async (r) => {
      login(r);
      if (r.user.staffNo) fail(403, "员工账号不能申请代理");
      const d = r.body || {};
      if (
        Object.keys(d).some(
          (k) =>
            !["name", "phone", "region", "inviteCode", "agreed"].includes(k),
        )
      )
        fail(400, "申请参数无效");
      if (d.agreed !== true) fail(400, "请先阅读并同意代理协议");
      const name = text(d.name, "姓名/昵称", 50),
        phone = text(d.phone, "手机号", 30),
        region = text(d.region, "所在地区", 100),
        code = text(d.inviteCode, "邀请码", 8, true).toUpperCase();
      if (!isPhone(phone)) fail(400, "请填写11位手机号");
      return transaction(pool, async (db) => {
        const prior = await agentRow(db, r.user.id, true);
        if (prior && prior.status === "active") fail(409, "你已经是代理");
        if (prior && prior.status === "pending") fail(409, "申请正在审核中");
        if (prior && prior.status === "disabled")
          fail(409, "代理资格已停用，请联系门店");
        let inviter = null;
        if (code) {
          inviter = await one(
            db,
            "SELECT * FROM agents WHERE invite_code=? AND status='active'",
            [code],
          );
          if (!inviter || inviter.user_id === r.user.id)
            fail(400, "邀请码无效");
        }
        if (prior)
          await db.execute(
            "UPDATE agents SET status='pending',name=?,phone=?,region=?,inviter_id=?,review_remark='',reviewed_by=NULL,reviewed_at=NULL,applied_at=UTC_TIMESTAMP(3),version=version+1 WHERE user_id=?",
            [name, phone, region, inviter?.user_id || null, r.user.id],
          );
        else
          await db.execute(
            "INSERT INTO agents(user_id,name,phone,region,inviter_id) VALUES (?,?,?,?,?)",
            [r.user.id, name, phone, region, inviter?.user_id || null],
          );
        await audit(db, r, "提交代理申请", r.user.id, {
          after: { region, inviterId: inviter?.user_id || null },
        });
        return agentView(await agentRow(db, r.user.id), inviter);
      });
    },
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
  );
  route("GET", "/agent/me", async (r) => {
    login(r);
    const row = r.user.staffNo ? null : await agentRow(pool, r.user.id);
    const inviter = row?.inviter_id
      ? await agentRow(pool, row.inviter_id)
      : null;
    return agentView(row, inviter);
  });
  route("GET", "/agent/invite", async (r) => {
    const me = await activeAgent(pool, r);
    const [rows] = await pool.execute(
      "SELECT name,status,applied_at FROM agents WHERE inviter_id=? ORDER BY applied_at DESC LIMIT 200",
      [me.user_id],
    );
    return {
      inviteCode: me.invite_code,
      members: rows.map((m) => ({
        name: maskName(m.name),
        status: m.status,
        appliedAt: m.applied_at,
      })),
    };
  });

  // ---------- 代理本人：可转发库存与加价 ----------
  async function markupOf(db, agentId, unitId) {
    const m = await one(
      db,
      "SELECT markup FROM agent_markups WHERE agent_id=? AND unit_id=?",
      [agentId, unitId],
    );
    return m ? cents(m.markup) : 0;
  }
  async function unitView(db, me, u) {
    const markup = await markupOf(db, me.user_id, u.id),
      view = await shareService.publicView(db, u, { channel: "agent" }),
      sharePrice = cents(u.agent_base) + markup;
    return {
      id: u.id,
      name: view.name,
      storage: view.storage,
      color: view.color,
      grade: view.grade,
      cover: view.cover,
      retail: Number(u.retail),
      markup: markup / 100,
      markupMin: 0,
      markupMax: Number(me.markup_max),
      sharePrice: sharePrice / 100,
      aboveRetail: sharePrice > cents(u.retail),
      priceVersion: u.price_version,
    };
  }
  function shareable(u) {
    return (
      u &&
      u.status === "in_stock" &&
      u.ownership === "own" &&
      json(u.share_flags).shareAgent === true
    );
  }
  route("GET", "/agent/units", async (r) => {
    const me = await activeAgent(pool, r),
      p = page(r.query),
      args = [],
      where = [
        "u.status='in_stock'",
        "u.ownership='own'",
        "JSON_EXTRACT(u.share_flags,'$.shareAgent')=true",
      ];
    if (r.query.keyword) {
      where.push("m.name LIKE ?");
      args.push("%" + text(r.query.keyword, "搜索", 100) + "%");
    }
    const clause = " WHERE " + where.join(" AND "),
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM units u JOIN models m ON m.id=u.model_id" +
          clause,
        args,
      ),
      [rows] = await pool.query(
        unitSelect +
          clause +
          " ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      await Promise.all(rows.map((u) => unitView(pool, me, u))),
      count.n,
      p,
    );
  });
  route("PUT", "/agent/units/:id/markup", async (r) => {
    const d = r.body || {};
    if (Object.keys(d).some((k) => k !== "markup")) fail(400, "加价参数无效");
    const markup = cents(d.markup, "加价");
    return transaction(pool, async (db) => {
      const me = await activeAgent(db, r),
        u = await one(db, unitSelect + " WHERE u.id=? FOR SHARE", [
          r.params.id,
        ]);
      if (!shareable(u)) fail(409, "该设备当前不允许代理转发");
      if (markup > cents(me.markup_max))
        fail(400, "加价不能超过上限 ¥" + Number(me.markup_max));
      await db.execute(
        "INSERT INTO agent_markups(agent_id,unit_id,markup) VALUES (?,?,?) ON DUPLICATE KEY UPDATE markup=VALUES(markup),updated_at=UTC_TIMESTAMP(3)",
        [me.user_id, u.id, money(markup)],
      );
      await audit(db, r, "代理设置加价", u.id, {
        after: { markup: markup / 100 },
      });
      return unitView(db, me, u);
    });
  });

  // ---------- 代理本人：概览、订单、收益 ----------
  const ORDER_SELECT = `SELECT a.*,s.status lock_status,s.sale_order_id,s.release_reason,c.name customer_name,c.phone customer_phone,c.unit_snapshot,c.created_at requested_at,cs.status request_status
    FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id JOIN customer_requests c ON c.id=a.request_id JOIN customer_request_states cs ON cs.request_id=a.request_id`;
  function orderView(row, internal) {
    const unit = json(row.unit_snapshot) || {};
    return {
      id: row.request_id,
      unitId: row.unit_id,
      name: unit.name || "",
      storage: unit.storage || "",
      status: row.lock_status,
      requestStatus: row.request_status,
      sharePrice: Number(row.share_price),
      markup: Number(row.markup),
      lockExpiresAt: row.lock_expires_at,
      releaseReason: row.release_reason || "",
      createdAt: row.created_at,
      customerName: internal ? row.customer_name : maskName(row.customer_name),
      customerPhone: internal
        ? row.customer_phone
        : maskPhone(row.customer_phone),
      ...(internal
        ? {
            agentId: row.agent_id,
            agentName: row.agent_name || null,
            saleOrderId: row.sale_order_id,
            agentBase: Number(row.agent_base),
          }
        : {}),
    };
  }
  route("GET", "/agent/overview", async (r) => {
    await releaseExpired();
    const me = await activeAgent(pool, r);
    const visits = await one(
        pool,
        `SELECT COUNT(DISTINCT visitor_hash) uv,COUNT(*) pv FROM visit_events WHERE share_owner_id=? AND type='pv' AND created_at>=${todayStart}`,
        [me.user_id],
      ),
      shares = await one(
        pool,
        `SELECT COUNT(*) n FROM share_links WHERE owner_id=? AND channel='agent' AND created_at>=${todayStart}`,
        [me.user_id],
      ),
      [orders] = await pool.execute(
        "SELECT s.status,COUNT(*) n FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id WHERE a.agent_id=? GROUP BY s.status",
        [me.user_id],
      ),
      totals = await earningTotals(pool, me.user_id);
    const n = (k) => Number(orders.find((o) => o.status === k)?.n || 0);
    return {
      todayVisitors: Number(visits.uv),
      todayViews: Number(visits.pv),
      todayShares: Number(shares.n),
      lockedOrders: n("locked"),
      soldOrders: n("sold"),
      ...totals,
      markupMax: Number(me.markup_max),
    };
  });
  route("GET", "/agent/orders", async (r) => {
    await releaseExpired();
    const me = await activeAgent(pool, r),
      p = page(r.query),
      args = [me.user_id],
      where = ["a.agent_id=?"];
    if (r.query.status) {
      if (!["locked", "sold", "released"].includes(r.query.status))
        fail(400, "订单状态无效");
      where.push("s.status=?");
      args.push(r.query.status);
    }
    const clause = " WHERE " + where.join(" AND "),
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id" +
          clause,
        args,
      ),
      [rows] = await pool.query(
        ORDER_SELECT +
          clause +
          " ORDER BY a.created_at DESC,a.request_id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      rows.map((o) => orderView(o, false)),
      count.n,
      p,
    );
  });
  const EARNING_SELECT = `SELECT e.*,s.status,s.settled_at,s.settle_reason,c.unit_snapshot,g.name agent_name
    FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id JOIN customer_requests c ON c.id=e.request_id JOIN agents g ON g.user_id=e.agent_id`;
  function earningView(row, internal) {
    const unit = json(row.unit_snapshot) || {};
    return {
      id: row.id,
      kind: row.kind,
      amount: Number(row.amount) * (row.kind === "reversal" ? -1 : 1),
      status: row.status,
      orderId: row.request_id,
      saleOrderId: internal ? row.sale_order_id : undefined,
      name: unit.name || "",
      createdAt: row.created_at,
      settledAt: row.settled_at,
      ...(internal
        ? {
            agentId: row.agent_id,
            agentName: row.agent_name,
            settleReason: row.settle_reason,
          }
        : {}),
    };
  }
  async function earningTotals(db, agentId) {
    const [rows] = await db.execute(
      "SELECT e.kind,s.status,COALESCE(SUM(e.amount),0) amount FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id" +
        (agentId ? " WHERE e.agent_id=?" : "") +
        " GROUP BY e.kind,s.status",
      agentId ? [agentId] : [],
    );
    const sum = (status) =>
      rows
        .filter((x) => x.status === status)
        .reduce(
          (n, x) => n + (x.kind === "reversal" ? -1 : 1) * cents(x.amount),
          0,
        );
    return {
      pendingAmount: sum("pending") / 100,
      settledAmount: sum("settled") / 100,
    };
  }
  async function earnings(r, agentId, internal) {
    const p = page(r.query),
      args = [],
      where = [];
    if (agentId) {
      where.push("e.agent_id=?");
      args.push(agentId);
    }
    if (r.query.status) {
      if (!["pending", "settled", "reversed"].includes(r.query.status))
        fail(400, "收益状态无效");
      where.push("s.status=?");
      args.push(r.query.status);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id" +
          clause,
        args,
      ),
      [rows] = await pool.query(
        EARNING_SELECT +
          clause +
          " ORDER BY e.created_at DESC,e.id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return {
      ...list(
        rows.map((x) => earningView(x, internal)),
        count.n,
        p,
      ),
      summary: await earningTotals(pool, agentId),
    };
  }
  route("GET", "/agent/commissions", async (r) => {
    const me = await activeAgent(pool, r);
    return earnings(r, me.user_id, false);
  });

  // ---------- 员工：设置、审核、代理管理 ----------
  const reviewer = (r) => {
    requirePerm(r, PERM.AGENT_REVIEW);
    if (!r.user.staffNo) fail(403, "仅员工可操作");
  };
  route("GET", "/admin/agent-settings", async (r) => {
    requirePerm(r, PERM.AGENT_REVIEW, PERM.AGENT_SETTLE);
    const s = await settings(pool);
    return {
      defaultMarkupMax: Number(s.default_markup_max),
      lockMinutes: lockMinutes(),
      version: s.version,
    };
  });
  route("PUT", "/admin/agent-settings", async (r) => {
    reviewer(r);
    const d = r.body || {},
      max = cents(d.defaultMarkupMax, "默认加价上限"),
      reason = text(d.reason, "调整原因", 500);
    if (max > 10000000) fail(400, "加价上限过大");
    return transaction(pool, async (db) => {
      const s = await one(
        db,
        "SELECT * FROM agent_settings WHERE id=1 FOR UPDATE",
      );
      if (s.version !== Number(d.version))
        fail(409, "设置已被他人修改，请刷新");
      await db.execute(
        "UPDATE agent_settings SET default_markup_max=?,version=version+1,updated_by=?,updated_at=UTC_TIMESTAMP(3) WHERE id=1",
        [money(max), r.user.id],
      );
      await audit(db, r, "调整代理默认加价上限", "agent_settings", {
        before: { defaultMarkupMax: Number(s.default_markup_max) },
        after: { defaultMarkupMax: max / 100 },
        reason,
      });
      return {
        defaultMarkupMax: max / 100,
        lockMinutes: lockMinutes(),
        version: s.version + 1,
      };
    });
  });
  const ADMIN_SELECT =
    "SELECT g.*,i.name inviter_name FROM agents g LEFT JOIN agents i ON i.user_id=g.inviter_id";
  async function agentsList(r, defaultStatus) {
    const p = page(r.query),
      args = [],
      where = [],
      status = r.query.status || defaultStatus;
    if (status) {
      if (!["pending", "active", "rejected", "disabled"].includes(status))
        fail(400, "代理状态无效");
      where.push("g.status=?");
      args.push(status);
    }
    if (r.query.keyword) {
      const k = "%" + text(r.query.keyword, "搜索", 100) + "%";
      where.push("(g.name LIKE ? OR g.phone LIKE ? OR g.region LIKE ?)");
      args.push(k, k, k);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(pool, "SELECT COUNT(*) n FROM agents g" + clause, args),
      [rows] = await pool.query(
        ADMIN_SELECT +
          clause +
          " ORDER BY g.applied_at DESC,g.user_id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(rows.map(adminView), count.n, p);
  }
  route("GET", "/admin/agent-applications", async (r) => {
    reviewer(r);
    return agentsList(r, "pending");
  });
  route("GET", "/admin/agents", async (r) => {
    requirePerm(r, PERM.AGENT_REVIEW, PERM.AGENT_SETTLE);
    return agentsList(r, "");
  });
  route("POST", "/admin/agent-applications/:id/review", async (r) => {
    reviewer(r);
    const d = r.body || {};
    if (typeof d.approve !== "boolean") fail(400, "请选择通过或拒绝");
    const remark = text(d.remark, "审核说明", 500);
    return transaction(pool, async (db) => {
      const row = await agentRow(db, r.params.id, true);
      if (!row) fail(404, "申请不存在");
      if (row.status !== "pending" || row.version !== Number(d.version))
        fail(409, "申请已处理或已更新，请刷新");
      if (d.approve) {
        const s = await settings(db),
          max =
            d.markupMax === undefined ||
            d.markupMax === null ||
            d.markupMax === ""
              ? cents(s.default_markup_max)
              : cents(d.markupMax, "加价上限");
        if (max > 10000000) fail(400, "加价上限过大");
        await db.execute(
          "UPDATE agents SET status='active',markup_max=?,invite_code=COALESCE(invite_code,?),review_remark=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),version=version+1 WHERE user_id=?",
          [money(max), await inviteCode(db), remark, r.user.id, row.user_id],
        );
        await db.execute(
          "UPDATE users SET role='agent',agent_status='active' WHERE id=?",
          [row.user_id],
        );
      } else
        await db.execute(
          "UPDATE agents SET status='rejected',review_remark=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),version=version+1 WHERE user_id=?",
          [remark, r.user.id, row.user_id],
        );
      await audit(
        db,
        r,
        d.approve ? "通过代理申请" : "拒绝代理申请",
        row.user_id,
        {
          reason: remark,
          after: d.approve
            ? { markupMax: d.markupMax ?? "default" }
            : { status: "rejected" },
        },
      );
      return adminView(
        await one(db, ADMIN_SELECT + " WHERE g.user_id=?", [row.user_id]),
      );
    });
  });
  route("PATCH", "/admin/agents/:id", async (r) => {
    reviewer(r);
    const d = r.body || {};
    if (
      Object.keys(d).some(
        (k) => !["status", "markupMax", "reason", "version"].includes(k),
      )
    )
      fail(400, "参数无效");
    const reason = text(d.reason, "调整原因", 500);
    if (d.status !== undefined && !["active", "disabled"].includes(d.status))
      fail(400, "代理状态无效");
    const max =
      d.markupMax === undefined ? null : cents(d.markupMax, "加价上限");
    if (max !== null && max > 10000000) fail(400, "加价上限过大");
    return transaction(pool, async (db) => {
      const row = await agentRow(db, r.params.id, true);
      if (!row || !["active", "disabled"].includes(row.status))
        fail(404, "代理不存在");
      if (row.version !== Number(d.version))
        fail(409, "代理资料已更新，请刷新");
      const status = d.status || row.status;
      await db.execute(
        "UPDATE agents SET status=?,markup_max=COALESCE(?,markup_max),version=version+1 WHERE user_id=?",
        [status, max === null ? null : money(max), row.user_id],
      );
      await db.execute("UPDATE users SET agent_status=? WHERE id=?", [
        status,
        row.user_id,
      ]);
      await audit(db, r, "调整代理资格或加价上限", row.user_id, {
        before: { status: row.status, markupMax: Number(row.markup_max) },
        after: {
          status,
          markupMax: max === null ? Number(row.markup_max) : max / 100,
        },
        reason,
      });
      return adminView(
        await one(db, ADMIN_SELECT + " WHERE g.user_id=?", [row.user_id]),
      );
    });
  });

  // ---------- 员工：代理订单与收益转账 ----------
  route("GET", "/admin/agent-orders", async (r) => {
    requirePerm(r, PERM.AGENT_REVIEW, PERM.AGENT_SETTLE, PERM.SALES_CREATE);
    await releaseExpired();
    const p = page(r.query),
      args = [],
      where = [];
    if (r.query.status) {
      if (!["locked", "sold", "released"].includes(r.query.status))
        fail(400, "订单状态无效");
      where.push("s.status=?");
      args.push(r.query.status);
    }
    if (r.query.agentId) {
      where.push("a.agent_id=?");
      args.push(text(r.query.agentId, "代理", 36));
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id" +
          clause,
        args,
      ),
      [rows] = await pool.query(
        ORDER_SELECT.replace(
          " FROM agent_orders a",
          ",g.name agent_name FROM agent_orders a JOIN agents g ON g.user_id=a.agent_id",
        ) +
          clause +
          " ORDER BY a.created_at DESC,a.request_id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      rows.map((o) => orderView(o, true)),
      count.n,
      p,
    );
  });
  route("GET", "/admin/agent-earnings", async (r) => {
    requirePerm(r, PERM.AGENT_SETTLE, PERM.AGENT_REVIEW);
    return earnings(
      r,
      r.query.agentId ? text(r.query.agentId, "代理", 36) : null,
      true,
    );
  });
  route("POST", "/admin/agent-earnings/settle", async (r) => {
    requirePerm(r, PERM.AGENT_SETTLE);
    if (!r.user.staffNo) fail(403, "仅员工可操作");
    const d = r.body || {},
      reason = text(d.reason, "转账说明", 500);
    if (
      !Array.isArray(d.ids) ||
      !d.ids.length ||
      d.ids.length > 100 ||
      d.ids.some((x) => typeof x !== "string" || !x)
    )
      fail(400, "请选择1～100条收益记录");
    const ids = [...new Set(d.ids)].sort();
    return transaction(pool, async (db) => {
      for (const target of ids) {
        const s = await one(
          db,
          "SELECT * FROM agent_earning_states WHERE earning_id=? FOR UPDATE",
          [target],
        );
        if (!s) fail(404, "收益记录不存在");
        if (s.status !== "pending") fail(409, "所选记录已转账或已冲回，请刷新");
      }
      for (const target of ids) {
        await db.execute(
          "UPDATE agent_earning_states SET status='settled',settled_by=?,settled_at=UTC_TIMESTAMP(3),settle_reason=? WHERE earning_id=?",
          [r.user.id, reason, target],
        );
        await audit(db, r, "标记代理收益已转账", target, { reason });
      }
      return { settled: ids.length };
    });
  });

  // ---------- 服务：下单锁库、到期释放、成交记账、退货冲回 ----------
  async function lock(db, r, requestId, ctx, unitId) {
    if (!ctx || ctx.link.channel !== "agent")
      fail(400, "仅代理分享链接支持下单");
    if (ctx.link.owner_id === r.user.id)
      fail(400, "不能通过自己的分享链接下单");
    const u = await stock.get(db, unitId, true),
      item = ctx.items.find((i) => i.id === unitId);
    if (!item) fail(404, "商品不在本分享内");
    if (!shareable(u)) fail(409, "该设备已被锁定或售出");
    if (u.price_version !== item.price_version)
      fail(410, "商品价格已变化，请重新获取分享");
    const snapshot = await one(
        db,
        "SELECT price,markup FROM share_items WHERE share_id=? AND unit_id=?",
        [ctx.link.id, unitId],
      ),
      markup = cents(snapshot.markup ?? 0),
      sharePrice = cents(snapshot.price);
    if (cents(u.agent_base) + markup !== sharePrice)
      fail(410, "代理价已变化，请重新获取分享");
    const minutes = lockMinutes();
    await db.execute(
      "INSERT INTO agent_orders(request_id,agent_id,unit_id,share_id,agent_base,markup,share_price,price_version,lock_expires_at) VALUES (?,?,?,?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL ? MINUTE))",
      [
        requestId,
        ctx.link.owner_id,
        unitId,
        ctx.link.id,
        u.agent_base,
        money(markup),
        money(sharePrice),
        u.price_version,
        minutes,
      ],
    );
    await db.execute("INSERT INTO agent_order_states(request_id) VALUES (?)", [
      requestId,
    ]);
    await db.execute(
      "INSERT INTO agent_unit_locks(unit_id,request_id) VALUES (?,?)",
      [unitId, requestId],
    );
    await db.execute("UPDATE units SET status='locked' WHERE id=?", [unitId]);
    await stock.ledger(
      db,
      r,
      unitId,
      "in_stock",
      "locked",
      "agent_order",
      requestId,
      "代理链接下单锁定 " + minutes + " 分钟",
    );
  }
  async function unlock(db, r, requestId, reason, actor) {
    const s = await one(
      db,
      "SELECT s.*,a.unit_id,c.owner_id FROM agent_order_states s JOIN agent_orders a ON a.request_id=s.request_id JOIN customer_requests c ON c.id=s.request_id WHERE s.request_id=? FOR UPDATE OF s",
      [requestId],
    );
    if (!s || s.status !== "locked") return false;
    const u = await stock.get(db, s.unit_id, true);
    await db.execute(
      "DELETE FROM agent_unit_locks WHERE unit_id=? AND request_id=?",
      [s.unit_id, requestId],
    );
    await db.execute(
      "UPDATE agent_order_states SET status='released',release_reason=?,updated_at=UTC_TIMESTAMP(3) WHERE request_id=?",
      [reason, requestId],
    );
    if (u.status === "locked") {
      await db.execute("UPDATE units SET status='in_stock' WHERE id=?", [u.id]);
      await stock.ledger(
        db,
        r || { user: { id: actor || s.owner_id } },
        u.id,
        "locked",
        "in_stock",
        "agent_order",
        requestId,
        reason,
      );
    }
    return true;
  }
  async function release(db, r, requestId, reason) {
    return unlock(db, r, requestId, reason);
  }
  let sweeping = null;
  async function releaseExpired() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const [rows] = await pool.execute(
        "SELECT a.request_id FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id WHERE s.status='locked' AND a.lock_expires_at<=UTC_TIMESTAMP(3) LIMIT 100",
      );
      for (const row of rows)
        await transaction(pool, async (db) => {
          const due = await one(
            db,
            "SELECT a.request_id FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id WHERE a.request_id=? AND s.status='locked' AND a.lock_expires_at<=UTC_TIMESTAMP(3) FOR UPDATE OF s",
            [row.request_id],
          );
          if (due)
            await unlock(db, null, row.request_id, "下单锁定到期自动释放");
        });
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }
  const timer = setInterval(() => releaseExpired().catch(() => {}), 60000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  async function orderFor(db, requestId) {
    return one(
      db,
      "SELECT a.*,s.status lock_status,g.name agent_name FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id JOIN agents g ON g.user_id=a.agent_id WHERE a.request_id=?",
      [requestId],
    );
  }
  /** 收银核价：代理订单设备须仍由本单锁定，成交价固定为分享价快照 */
  async function saleItem(db, requestId, unitId, lockRows) {
    const o = await one(
      db,
      "SELECT a.*,s.status lock_status FROM agent_orders a JOIN agent_order_states s ON s.request_id=a.request_id WHERE a.request_id=?" +
        (lockRows ? " FOR UPDATE OF s" : ""),
      [requestId],
    );
    if (!o || o.unit_id !== unitId) fail(400, "代理订单与设备不符");
    if (o.lock_status !== "locked")
      fail(409, "代理订单锁定已释放，不能按代理价成交");
    if (new Date(o.lock_expires_at).getTime() <= Date.now())
      fail(409, "代理订单锁定已到期，请让顾客重新下单");
    return o;
  }
  async function recordSale(db, r, requestId, saleOrderId) {
    const o = await saleItem(
      db,
      requestId,
      (await orderFor(db, requestId))?.unit_id,
      true,
    );
    await db.execute(
      "DELETE FROM agent_unit_locks WHERE unit_id=? AND request_id=?",
      [o.unit_id, requestId],
    );
    await db.execute(
      "UPDATE agent_order_states SET status='sold',sale_order_id=?,updated_at=UTC_TIMESTAMP(3) WHERE request_id=?",
      [saleOrderId, requestId],
    );
    const earning = id();
    await db.execute(
      "INSERT INTO agent_earnings(id,agent_id,request_id,sale_order_id,kind,amount) VALUES (?,?,?,?,'earning',?)",
      [earning, o.agent_id, requestId, saleOrderId, o.markup],
    );
    await db.execute(
      "INSERT INTO agent_earning_states(earning_id) VALUES (?)",
      [earning],
    );
    await audit(db, r, "代理订单成交记收益", requestId, {
      after: { saleOrderId, markup: Number(o.markup), agentId: o.agent_id },
    });
  }
  /** 退货：未转账收益直接冲回；已转账的生成冲回记录，后续转账时抵扣 */
  async function onReturn(db, r, saleOrderId, unitId, refundId) {
    const e = await one(
      db,
      "SELECT e.*,s.status FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id JOIN agent_orders a ON a.request_id=e.request_id WHERE e.sale_order_id=? AND a.unit_id=? AND e.kind='earning' FOR UPDATE OF s",
      [saleOrderId, unitId],
    );
    if (!e) return;
    if (e.status === "pending") {
      await db.execute(
        "UPDATE agent_earning_states SET status='reversed',settle_reason=? WHERE earning_id=?",
        ["退货冲回 " + refundId, e.id],
      );
      await audit(db, r, "退货冲回代理收益", e.id, { reason: refundId });
    } else if (e.status === "settled") {
      const reversal = id();
      await db.execute(
        "INSERT INTO agent_earnings(id,agent_id,request_id,sale_order_id,kind,amount,reversal_of) VALUES (?,?,?,?,'reversal',?,?)",
        [reversal, e.agent_id, e.request_id, saleOrderId, e.amount, e.id],
      );
      await db.execute(
        "INSERT INTO agent_earning_states(earning_id) VALUES (?)",
        [reversal],
      );
      await audit(db, r, "已转账收益退货生成冲回记录", reversal, {
        reason: refundId,
      });
    }
  }
  async function requestView(db, requestId, internal) {
    const o = await orderFor(db, requestId);
    if (!o) return null;
    return {
      status: o.lock_status,
      sharePrice: Number(o.share_price),
      priceVersion: o.price_version,
      lockExpiresAt: o.lock_expires_at,
      ...(internal
        ? {
            markup: Number(o.markup),
            agentId: o.agent_id,
            agentName: o.agent_name,
          }
        : {}),
    };
  }
  async function pending(r) {
    const out = {};
    if (r.user.permissions.includes(PERM.AGENT_REVIEW))
      out.applications = Number(
        (
          await one(
            pool,
            "SELECT COUNT(*) n FROM agents WHERE status='pending'",
          )
        ).n,
      );
    if (
      r.user.permissions.some((p) =>
        [PERM.SALES_CREATE, PERM.AGENT_REVIEW].includes(p),
      )
    )
      out.lockedOrders = Number(
        (
          await one(
            pool,
            "SELECT COUNT(*) n FROM agent_order_states WHERE status='locked'",
          )
        ).n,
      );
    if (r.user.permissions.includes(PERM.AGENT_SETTLE))
      out.pendingEarnings = Number(
        (
          await one(
            pool,
            "SELECT COUNT(*) n FROM agent_earning_states WHERE status='pending'",
          )
        ).n,
      );
    return out;
  }
  return {
    lock,
    release,
    releaseExpired,
    saleItem,
    recordSale,
    onReturn,
    requestView,
    pending,
    shareable,
    markupOf,
  };
};
