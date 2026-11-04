const { one, transaction } = require("./db");
const {
  PERM,
  fail,
  text,
  id,
  hash,
  json,
  page,
  list,
  requirePerm,
  audit,
} = require("./core");
const { isPhone } = require("../../miniprogram/utils/validate");
const {
  TRANSITIONS,
  ACTIVE,
} = require("../../miniprogram/constants/customer-requests");
const { unitSelect } = require("./stock");
const select = `SELECT c.*,s.status,s.version,s.updated_at FROM customer_requests c JOIN customer_request_states s ON s.request_id=c.id`;
module.exports = async function (
  app,
  { pool, config, route, shareService, agents },
) {
  const login = (r) => {
    if (!r.user) fail(401, "请先登录");
  };
  const staff = (r) => {
    requirePerm(r, PERM.CONSULT_MANAGE);
    if (!r.user.staffNo) fail(403, "仅员工可跟进顾客资料");
  };
  const today = () =>
    new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  function options() {
    const c = config.contact;
    if (
      !Number.isInteger(c.days) ||
      c.days < 1 ||
      c.days > 90 ||
      !Array.isArray(c.slots) ||
      !c.slots.length ||
      c.slots.length > 12 ||
      new Set(c.slots).size !== c.slots.length ||
      c.slots.some(
        (s) =>
          typeof s !== "string" || !s.trim() || s.length > 60 || s !== s.trim(),
      )
    )
      fail(503, "预约时段配置无效");
    const start = today();
    return {
      timeSlots: c.slots,
      minDate: start,
      maxDate: new Date(
        Date.parse(start + "T00:00:00+08:00") + c.days * 86400000 + 28800000,
      )
        .toISOString()
        .slice(0, 10),
      notice: "提交后由门店确认时间；预约不锁库存或价格。",
    };
  }
  function validDate(value) {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + "T00:00:00Z")) ||
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
    )
      fail(400, "预约日期无效");
    return value;
  }
  async function get(db, target) {
    const row = await one(db, select + " WHERE c.id=?", [target]);
    if (!row) fail(404, "记录不存在");
    return row;
  }
  async function view(db, row, r, internal = false) {
    let unit = json(row.unit_snapshot);
    if (unit && unit.priceType === "wholesale" && !shareService.canPeer(r.user))
      unit = { id: unit.id, name: unit.name, imeiMasked: unit.imeiMasked };
    const [events] = await db.execute(
      "SELECT e.*,u.nickname FROM customer_request_events e JOIN users u ON u.id=e.actor_id WHERE request_id=? ORDER BY version,e.id",
      [row.id],
    );
    const sale = await one(
      db,
      "SELECT order_id FROM sales_attributions WHERE customer_request_id=?",
      [row.id],
    );
    const state = TRANSITIONS[row.kind][row.status] || [];
    const agentOrder =
      row.kind === "order"
        ? await agents.requestView(db, row.id, internal, r?.user)
        : null;
    let canStartSale = false;
    if (
      internal &&
      ACTIVE.includes(row.status) &&
      !sale &&
      row.unit_id &&
      r.user.permissions.includes(PERM.SALES_CREATE)
    ) {
      const u = await one(db, "SELECT status,ownership FROM units WHERE id=?", [
        row.unit_id,
      ]);
      // 代理订单只能在本单锁定期间按分享价成交
      canStartSale =
        row.kind === "order"
          ? agentOrder?.status === "locked" &&
            new Date(agentOrder.lockExpiresAt).getTime() > Date.now()
          : u?.status === "in_stock" && u.ownership === "own";
    }
    const shareOwner =
      internal && row.share_owner_id
        ? await one(db, "SELECT nickname FROM users WHERE id=?", [
            row.share_owner_id,
          ])
        : null;
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      version: row.version,
      unitId: row.unit_id,
      unit,
      content: row.content,
      phone: row.phone,
      name: row.name,
      date: row.appointment_date,
      timeSlot: row.time_slot,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      saleRecorded: !!sale,
      ...(agentOrder ? { agentOrder } : {}),
      ...(internal
        ? {
            ownerId: row.owner_id,
            shareId: row.share_id,
            shareOwnerId: row.share_owner_id,
            shareOwnerName: shareOwner?.nickname || null,
            actions: state,
            canStartSale,
            ...(r.user.permissions.some((p) =>
              [PERM.SALES_CREATE, PERM.STATS_VIEW, PERM.REFUND].includes(p),
            )
              ? { salesOrderId: sale?.order_id }
              : {}),
          }
        : { canCancel: ACTIVE.includes(row.status) }),
      timeline: events.map((e) => ({
        id: e.id,
        status: e.to_status,
        time: e.created_at,
        actor: e.actor_kind === "staff" ? "门店" : "本人",
        ...(internal
          ? { operator: e.nickname, note: e.note }
          : e.actor_kind === "customer"
            ? { note: e.note }
            : {}),
      })),
    };
  }
  async function duplicate(db, owner, key, digest) {
    const old = await one(
      db,
      "SELECT id,request_hash FROM customer_requests WHERE owner_id=? AND request_key=?",
      [owner, key],
    );
    if (!old) return null;
    if (old.request_hash !== digest) fail(409, "提交标识内容冲突");
    return old.id;
  }
  async function submit(r, kind) {
    login(r);
    const d = r.body || {},
      allowed = [
        "unitId",
        "content",
        "phone",
        "name",
        "date",
        "timeSlot",
        "requestKey",
      ];
    if (Object.keys(d).some((k) => !allowed.includes(k)))
      fail(400, "提交参数无效");
    const key = text(d.requestKey, "提交标识", 100),
      unitId = text(d.unitId, "设备编号", 36, true) || null,
      content = text(d.content, "咨询内容", 2000, kind !== "consult"),
      phone = text(d.phone, "联系电话", 30),
      name = text(d.name, "称呼", 100, kind === "consult");
    if (kind === "order" && !unitId) fail(400, "请选择要下单的设备");
    if (!isPhone(phone)) fail(400, "请填写11位手机号");
    const date = kind === "appointment" ? validDate(d.date) : null,
      slot = kind === "appointment" ? text(d.timeSlot, "预约时段", 60) : null;
    if (kind !== "appointment" && (d.date || d.timeSlot))
      fail(400, "咨询或下单无需预约日期");
    const source = r.headers["x-channel"] || "";
    if (typeof source !== "string" || source.length > 100)
      fail(400, "分享标识无效");
    const digest = hash(
      JSON.stringify({
        kind,
        unitId,
        content,
        phone,
        name,
        date,
        slot,
        source,
      }),
    );
    const prior = await duplicate(pool, r.user.id, key, digest);
    if (prior) return view(pool, await get(pool, prior), r);
    try {
      return await transaction(pool, async (db) => {
        if (kind === "appointment") {
          const o = options();
          if (
            date < o.minDate ||
            date > o.maxDate ||
            !o.timeSlots.includes(slot)
          )
            fail(400, "请选择有效的预约日期和时段");
        }
        if (unitId) {
          const locked = await one(
            db,
            unitSelect +
              " WHERE u.id=? " +
              (kind === "order" ? "FOR UPDATE" : "FOR SHARE"),
            [unitId],
          );
          if (!locked) fail(404, "商品不存在或已下架");
        }
        const ctx = await shareService.context(db, r),
          unit = unitId ? await shareService.unit(db, unitId, r, ctx) : null;
        const target = id();
        await db.execute(
          "INSERT INTO customer_requests(id,owner_id,kind,unit_id,unit_snapshot,content,phone,name,appointment_date,time_slot,source,share_id,share_owner_id,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            target,
            r.user.id,
            kind,
            unitId,
            unit ? JSON.stringify(unit) : null,
            content,
            phone,
            name,
            date,
            slot,
            ctx ? ctx.link.channel : "natural",
            ctx?.link.id || null,
            ctx?.link.owner_id || null,
            key,
            digest,
          ],
        );
        await db.execute(
          "INSERT INTO customer_request_states(request_id) VALUES (?)",
          [target],
        );
        if (kind === "order") await agents.lock(db, r, target, ctx, unitId);
        await event(db, r, target, "customer", null, "new", 1, "", key, digest);
        await audit(
          db,
          r,
          kind === "appointment"
            ? "提交到店预约"
            : kind === "order"
              ? "代理链接下单"
              : "提交商品咨询",
          target,
          { after: { kind, unitId, shareId: ctx?.link.id || null } },
        );
        return view(db, await get(db, target), r);
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        const old = await duplicate(pool, r.user.id, key, digest);
        if (old) return view(pool, await get(pool, old), r);
      }
      throw error;
    }
  }
  async function event(
    db,
    r,
    target,
    actorKind,
    from,
    to,
    version,
    note,
    key,
    digest,
  ) {
    await db.execute(
      "INSERT INTO customer_request_events(id,request_id,actor_id,actor_kind,from_status,to_status,version,note,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [
        id(),
        target,
        r.user.id,
        actorKind,
        from,
        to,
        version,
        note,
        key,
        digest,
      ],
    );
  }
  async function change(r, internal) {
    internal ? staff(r) : login(r);
    const d = r.body || {},
      key = text(d.requestKey, "操作标识", 100),
      note = text(d.reason, "处理说明", 500),
      status = internal ? text(d.status, "目标状态", 20) : "cancelled",
      version = Number(d.version);
    if (!Number.isInteger(version) || version < 1) fail(400, "记录版本无效");
    const digest = hash(JSON.stringify({ status, version, note }));
    return transaction(pool, async (db) => {
      const state = await one(
        db,
        "SELECT * FROM customer_request_states WHERE request_id=? FOR UPDATE",
        [r.params.id],
      );
      if (!state) fail(404, "记录不存在");
      const row = {
        ...(await get(db, r.params.id)),
        status: state.status,
        version: state.version,
        updated_at: state.updated_at,
      };
      if (!internal && row.owner_id !== r.user.id) fail(404, "记录不存在");
      const prior = await one(
        db,
        "SELECT request_hash,to_status,version FROM customer_request_events WHERE request_id=? AND actor_id=? AND request_key=? FOR SHARE",
        [row.id, r.user.id, key],
      );
      if (prior) {
        if (prior.request_hash !== digest) fail(409, "操作标识内容冲突");
        return { id: row.id, status: prior.to_status, version: prior.version };
      }
      if (row.version !== version) fail(409, "记录已更新，请刷新后处理");
      if (
        !(TRANSITIONS[row.kind][row.status] || []).includes(status) ||
        (!internal && status !== "cancelled")
      )
        fail(409, "当前状态不能执行此操作");
      await db.execute(
        "UPDATE customer_request_states SET status=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE request_id=?",
        [status, row.id],
      );
      await event(
        db,
        r,
        row.id,
        internal ? "staff" : "customer",
        row.status,
        status,
        version + 1,
        note,
        key,
        digest,
      );
      if (row.kind === "order" && ["closed", "cancelled"].includes(status))
        await agents.release(
          db,
          r,
          row.id,
          internal ? "门店关闭代理订单：" + note : "顾客取消代理订单",
        );
      await audit(db, r, internal ? "跟进咨询预约" : "取消咨询预约", row.id, {
        reason: note,
        after: { status, version: version + 1 },
      });
      return { id: row.id, status, version: version + 1 };
    });
  }
  async function rows(r, internal) {
    internal ? staff(r) : login(r);
    const p = page(r.query),
      where = [],
      args = [];
    if (!internal) {
      where.push("c.owner_id=?");
      args.push(r.user.id);
    }
    for (const key of ["kind", "status"])
      if (r.query[key]) {
        const values =
          key === "kind"
            ? ["consult", "appointment", "order"]
            : [
                "new",
                "contacted",
                "confirmed",
                "completed",
                "closed",
                "cancelled",
              ];
        if (!values.includes(r.query[key])) fail(400, "筛选条件无效");
        where.push((key === "kind" ? "c." : "s.") + key + "=?");
        args.push(r.query[key]);
      }
    if (internal && r.query.keyword) {
      const k = "%" + text(r.query.keyword, "搜索", 100) + "%";
      where.push("(c.name LIKE ? OR c.phone LIKE ? OR c.id=?)");
      args.push(k, k, r.query.keyword);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM customer_requests c JOIN customer_request_states s ON s.request_id=c.id" +
          clause,
        args,
      ),
      [items] = await pool.query(
        select + clause + " ORDER BY c.created_at DESC,c.id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      await Promise.all(items.map((i) => view(pool, i, r, internal))),
      count.n,
      p,
    );
  }
  route("GET", "/shop/contact-options", async () => options());
  route("POST", "/shop/consults", (r) => submit(r, "consult"), {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  });
  route("POST", "/shop/appointments", (r) => submit(r, "appointment"), {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  });
  route("POST", "/shop/orders", (r) => submit(r, "order"), {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  });
  route("GET", "/shop/requests", (r) => rows(r, false));
  route("GET", "/shop/requests/:id", async (r) => {
    login(r);
    const row = await get(pool, r.params.id);
    if (row.owner_id !== r.user.id) fail(404, "记录不存在");
    return view(pool, row, r);
  });
  route("PATCH", "/shop/requests/:id/cancel", (r) => change(r, false));
  route("GET", "/customer-requests", (r) => rows(r, true));
  route("GET", "/customer-requests/:id", async (r) => {
    staff(r);
    return view(pool, await get(pool, r.params.id), r, true);
  });
  route("PATCH", "/customer-requests/:id/status", (r) => change(r, true));
  async function forSale(db, r, requestId, items) {
    staff(r);
    const target = text(requestId, "咨询预约编号", 36),
      state = await one(
        db,
        "SELECT * FROM customer_request_states WHERE request_id=? FOR UPDATE",
        [target],
      );
    if (!state) fail(404, "咨询预约不存在");
    const row = {
      ...(await get(db, target)),
      status: state.status,
      version: state.version,
      updated_at: state.updated_at,
    };
    if (!ACTIVE.includes(row.status)) fail(409, "咨询预约已结束或取消");
    if (!row.unit_id || !items.some((i) => i.unit.id === row.unit_id))
      fail(400, "销售单需包含意向设备");
    if (row.kind === "order")
      await agents.saleItem(db, row.id, row.unit_id, true);
    if (
      await one(
        db,
        "SELECT order_id FROM sales_attributions WHERE customer_request_id=? FOR SHARE",
        [target],
      )
    )
      fail(409, "此意向已关联成交");
    return row;
  }
  async function recordSale(db, r, row, orderId) {
    if (!row) return;
    if (row.kind === "order") await agents.recordSale(db, r, row.id, orderId);
    await db.execute(
      "INSERT INTO sales_attributions(order_id,customer_request_id,customer_id,source,share_id,share_owner_id) VALUES (?,?,?,?,?,?)",
      [
        orderId,
        row.id,
        row.owner_id,
        row.source,
        row.share_id,
        row.share_owner_id,
      ],
    );
    const status = row.kind === "appointment" ? "completed" : "closed";
    await db.execute(
      "UPDATE customer_request_states SET status=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE request_id=?",
      [status, row.id],
    );
    const key = "sale_" + orderId;
    await event(
      db,
      r,
      row.id,
      "staff",
      row.status,
      status,
      row.version + 1,
      "已登记销售单 " + orderId,
      key,
      hash(key),
    );
  }
  return { forSale, recordSale };
};
