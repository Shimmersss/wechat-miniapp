const { transaction, one } = require("./db");
const {
  PERM,
  fail,
  id,
  text,
  page,
  list,
  json,
  requirePerm,
  audit,
  hash,
} = require("./core");
const { cents, money } = require("./validation");
const { stockService, canSee } = require("./stock");
const PAY = ["微信", "支付宝", "现金", "银行卡", "分期"];
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
module.exports = async function (
  app,
  { pool, config, route, customerRequests },
) {
  const stock = stockService({ config }),
    read = (r) =>
      requirePerm(r, PERM.SALES_CREATE, PERM.REFUND, PERM.STATS_VIEW);
  async function order(db, target, lock = false) {
    if (lock) {
      if (
        !(await one(db, "SELECT id FROM sales_orders WHERE id=? FOR SHARE", [
          target,
        ]))
      )
        fail(404, "销售单不存在");
      await db.execute(
        "INSERT INTO sales_order_locks(order_id) VALUES (?) ON DUPLICATE KEY UPDATE order_id=VALUES(order_id)",
        [target],
      );
      await one(
        db,
        "SELECT order_id FROM sales_order_locks WHERE order_id=? FOR UPDATE",
        [target],
      );
    }
    const r = await one(
      db,
      "SELECT o.*,COALESCE(s.name,u.nickname) seller FROM sales_orders o JOIN users u ON u.id=o.seller_id LEFT JOIN staff s ON s.user_id=u.id WHERE o.id=?",
      [target],
    );
    if (!r) fail(404, "销售单不存在");
    return r;
  }
  async function view(db, o, r) {
    const [items] = await db.execute(
      "SELECT i.*,COALESCE((SELECT SUM(ri.amount) FROM sales_refund_items ri WHERE ri.sale_item_id=i.id),0) refunded,EXISTS(SELECT 1 FROM sales_refund_items ri JOIN sales_refunds rf ON rf.id=ri.refund_id WHERE ri.sale_item_id=i.id AND rf.kind='return') returned,COALESCE((SELECT SUM(ri.cost_reversal) FROM sales_refund_items ri WHERE ri.sale_item_id=i.id),0) reversed FROM sales_items i WHERE i.order_id=? ORDER BY i.id",
      [o.id],
    );
    const [refunds] = await db.execute(
      "SELECT id,kind,reason,amount,created_at time FROM sales_refunds WHERE order_id=? ORDER BY created_at,id",
      [o.id],
    );
    const totalRefund = refunds.reduce((n, x) => n + cents(x.amount), 0),
      costReverse = items.reduce((n, x) => n + cents(x.reversed), 0);
    const full = items.length && items.every((i) => Number(i.returned) === 1);
    const attribution = await one(
      db,
      "SELECT customer_request_id,source,share_id,share_owner_id FROM sales_attributions WHERE order_id=?",
      [o.id],
    );
    return {
      ...(attribution
        ? {
            customerRequestId: attribution.customer_request_id,
            source: attribution.source,
            ...(r.user.permissions.includes(PERM.CONSULT_MANAGE)
              ? {
                  shareId: attribution.share_id,
                  shareOwnerId: attribution.share_owner_id,
                }
              : {}),
          }
        : {}),
      id: o.id,
      no: o.no,
      status: full
        ? "refunded"
        : refunds.length
          ? "partially_refunded"
          : "paid",
      seller: o.seller,
      sellerId: o.seller_id,
      payMethod: o.pay_method,
      customer: o.customer,
      phone: o.phone,
      remark: o.remark,
      createdAt: o.created_at,
      amount: Number(o.amount),
      refundAmount: totalRefund / 100,
      netAmount: (cents(o.amount) - totalRefund) / 100,
      unitName: items.map((i) => i.name).join("、"),
      quantity: items.length,
      ...(canSee(r.user, "profit") &&
      r.user.permissions.includes(PERM.PROFIT_VIEW)
        ? {
            profit:
              (cents(o.amount) -
                totalRefund -
                cents(o.cost_total) +
                costReverse) /
              100,
          }
        : {}),
      items: items.map((i) => ({
        id: i.id,
        unitId: i.unit_id,
        modelId: i.model_id,
        name: i.name,
        spec: i.spec,
        store: i.store,
        price: Number(i.price),
        refunded: Number(i.refunded),
        returnable: Number(i.returned) === 0,
        channel: i.channel,
        ...(canSee(r.user, "cost") ? { cost: Number(i.cost) } : {}),
      })),
      refunds: refunds.map((x) => ({ ...x, amount: Number(x.amount) })),
    };
  }
  function rows(d) {
    if (!Array.isArray(d.items) || !d.items.length || d.items.length > 100)
      fail(400, "销售需1～100台设备");
    const seen = new Set();
    return d.items
      .map((x) => {
        const unitId = text(x.unitId, "设备编号", 36);
        if (seen.has(unitId)) fail(400, "销售设备重复");
        seen.add(unitId);
        const channel = x.channel || "retail";
        if (!["retail", "wholesale"].includes(channel))
          fail(400, "销售渠道无效");
        return {
          unitId,
          channel,
          priceVersion: x.priceVersion,
          ...(x.price !== undefined ? { price: x.price } : {}),
        };
      })
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
  }
  async function plan(db, input, r, lock) {
    const items = [];
    let total = 0n,
      cost = 0n;
    for (const x of input) {
      const u = await stock.get(db, x.unitId, lock);
      if (u.status !== "in_stock" || u.ownership !== "own")
        fail(409, "设备不可售，请刷新库存");
      if (x.priceVersion !== u.price_version)
        fail(409, "设备价格已变化，请重新核对");
      if (x.channel === "wholesale" && !canSee(r.user, "wholesalePrice"))
        fail(403, "无权限使用批发价格");
      const base = cents(x.channel === "wholesale" ? u.wholesale : u.retail),
        price = x.price === undefined ? base : cents(x.price, "成交价");
      if (price !== base) requirePerm(r, PERM.PRICE_EDIT);
      total += BigInt(price);
      cost += BigInt(cents(u.cost));
      items.push({ id: id(), unit: u, channel: x.channel, price, base });
    }
    return { items, total: money(total), cost: money(cost) };
  }
  route("GET", "/sales/lookup", async (r) => {
    requirePerm(r, PERM.SALES_CREATE);
    const code = text(r.query.code, "设备编号或串码", 80);
    const u = await one(
      pool,
      "SELECT id FROM units WHERE id=? OR imei1=? OR imei2=?",
      [code, code, code],
    );
    if (!u) fail(404, "未找到设备");
    const row = await stock.get(pool, u.id);
    if (row.status !== "in_stock" || row.ownership !== "own")
      fail(409, "设备不可售");
    return stock.view(pool, row, r);
  });
  route("POST", "/sales/quote", async (r) => {
    requirePerm(r, PERM.SALES_CREATE);
    const result = await transaction(pool, (db) =>
      plan(db, rows(r.body || {}), r, false),
    );
    return {
      total: Number(result.total),
      items: result.items.map((i) => ({
        unitId: i.unit.id,
        price: i.price / 100,
        basePrice: i.base / 100,
        priceVersion: i.unit.price_version,
        channel: i.channel,
      })),
    };
  });
  route("POST", "/sales-orders", async (r) => {
    requirePerm(r, PERM.SALES_CREATE);
    const d = r.body || {},
      input = rows(d),
      key = text(d.requestKey, "提交标识", 80),
      pay = text(d.payMethod, "付款方式", 20),
      customer = text(d.customer, "顾客", 100, true),
      phone = text(d.phone, "电话", 30, true),
      remark = text(d.remark, "备注", 1000, true);
    if (!PAY.includes(pay) || d.paymentConfirmed !== true)
      fail(400, "请确认实际收款并选择付款方式");
    const digest = hash(JSON.stringify(canonical({ ...d, items: input })));
    return transaction(pool, async (db) => {
      const prior = await one(
        db,
        "SELECT id,request_hash FROM sales_orders WHERE request_key=?",
        [key],
      );
      if (prior) {
        if (prior.request_hash !== digest) fail(409, "提交标识内容冲突");
        return view(db, await order(db, prior.id), r);
      }
      const p = await plan(db, input, r, true),
        changed = p.items.some((i) => i.price !== i.base),
        reason = changed ? text(d.priceReason, "成交改价原因", 500) : "";
      const referral = d.customerRequestId
        ? await customerRequests.forSale(db, r, d.customerRequestId, p.items)
        : null;
      const target = id(),
        no = "SO" + target.replaceAll("-", "");
      await db.execute(
        "INSERT INTO sales_orders (id,no,seller_id,pay_method,customer,phone,remark,amount,cost_total,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
          target,
          no,
          r.user.id,
          pay,
          customer,
          phone,
          remark,
          p.total,
          p.cost,
          key,
          digest,
        ],
      );
      for (const i of p.items) {
        const u = i.unit,
          a = json(u.attributes);
        await db.execute(
          "INSERT INTO sales_items (id,order_id,unit_id,model_id,name,spec,store,price,cost,price_version,channel) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [
            i.id,
            target,
            u.id,
            u.model_id,
            u.name,
            [a.version, a.storage, a.color, a.grade]
              .filter(Boolean)
              .join(" / "),
            a.store || "",
            money(i.price),
            u.cost,
            u.price_version,
            i.channel,
          ],
        );
        await db.execute(
          "UPDATE units SET status='sold',share_flags=? WHERE id=?",
          [
            JSON.stringify({
              showInShop: false,
              sharePeer: false,
              shareAgent: false,
            }),
            u.id,
          ],
        );
        await stock.ledger(
          db,
          r,
          u.id,
          "in_stock",
          "sold",
          "sales_order",
          target,
          reason || "实际收款确认",
        );
      }
      await customerRequests.recordSale(db, r, referral, target);
      await audit(db, r, "销售收款出库", target, {
        after: {
          unitIds: input.map((x) => x.unitId),
          amount: Number(p.total),
          payMethod: pay,
          ...(referral ? { customerRequestId: referral.id } : {}),
        },
        reason,
      });
      return view(db, await order(db, target), r);
    });
  });
  route("GET", "/sales-orders", async (r) => {
    read(r);
    const p = page(r.query),
      where = [],
      params = [];
    if (r.query.sellerId) {
      where.push("o.seller_id=?");
      params.push(text(r.query.sellerId, "销售员", 36));
    }
    if (r.query.keyword) {
      where.push("(o.no LIKE ? OR o.customer LIKE ?)");
      const k = "%" + text(r.query.keyword, "搜索", 100) + "%";
      params.push(k, k);
    }
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<"],
    ])
      if (r.query[key]) {
        const date = require("./validation").date(r.query[key]);
        where.push("o.created_at" + op + "?");
        params.push(
          key === "to"
            ? new Date(Date.parse(date + "T00:00:00+08:00") + 86400000)
            : new Date(date + "T00:00:00+08:00"),
        );
      }
    // Status is derived from immutable refund records.
    if (r.query.status) {
      if (!["paid", "partially_refunded", "refunded"].includes(r.query.status))
        fail(400, "销售状态无效");
      const any =
          "EXISTS(SELECT 1 FROM sales_refunds rf WHERE rf.order_id=o.id)",
        full =
          "NOT EXISTS(SELECT 1 FROM sales_items si WHERE si.order_id=o.id AND NOT EXISTS(SELECT 1 FROM sales_refund_items ri JOIN sales_refunds rf ON rf.id=ri.refund_id WHERE ri.sale_item_id=si.id AND rf.kind='return'))";
      where.push(
        r.query.status === "paid"
          ? "NOT " + any
          : r.query.status === "refunded"
            ? full
            : "(" + any + " AND NOT " + full + ")",
      );
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM sales_orders o" + clause,
        params,
      );
    const [orders] = await pool.query(
      "SELECT o.*,COALESCE(s.name,u.nickname) seller FROM sales_orders o JOIN users u ON u.id=o.seller_id LEFT JOIN staff s ON s.user_id=u.id" +
        clause +
        " ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?",
      [...params, p.pageSize, p.offset],
    );
    return list(
      await Promise.all(orders.map((o) => view(pool, o, r))),
      count.n,
      p,
    );
  });
  route("GET", "/sales-orders/:id", async (r) => {
    read(r);
    return view(pool, await order(pool, r.params.id), r);
  });
  route("POST", "/sales-orders/:id/refund", async (r) => {
    requirePerm(r, PERM.REFUND);
    const d = r.body || {},
      reason = text(d.reason, "退款原因", 500),
      key = text(d.requestKey, "提交标识", 80),
      kind = d.kind || "return";
    if (
      !["return", "adjustment"].includes(kind) ||
      !Array.isArray(d.items) ||
      !d.items.length ||
      d.items.length > 100
    )
      fail(400, "退款项目无效");
    const digest = hash(
      JSON.stringify(canonical({ ...d, orderId: r.params.id })),
    );
    return transaction(pool, async (db) => {
      const o = await order(db, r.params.id, true),
        previous = await one(
          db,
          "SELECT * FROM sales_refunds WHERE request_key=?",
          [key],
        );
      if (previous) {
        if (previous.request_hash !== digest) fail(409, "退款提交标识冲突");
        return view(db, o, r);
      }
      const planned = [],
        seen = new Set();
      let total = 0n;
      for (const input of d.items) {
        const itemId = text(input.itemId, "销售明细", 36);
        if (seen.has(itemId)) fail(400, "退款明细重复");
        seen.add(itemId);
        const i = await one(
          db,
          "SELECT * FROM sales_items WHERE id=? AND order_id=?",
          [itemId, o.id],
        );
        if (!i) fail(400, "退款明细不属于本单");
        const returned = await one(
          db,
          "SELECT ri.sale_item_id FROM sales_refund_items ri JOIN sales_refunds rf ON rf.id=ri.refund_id WHERE ri.sale_item_id=? AND rf.kind='return'",
          [i.id],
        );
        if (returned) fail(409, "该设备已退货");
        const aggregate = await one(
            db,
            "SELECT COALESCE(SUM(amount),0) amount FROM sales_refund_items WHERE sale_item_id=?",
            [i.id],
          ),
          remaining = cents(i.price) - cents(aggregate.amount),
          amount =
            input.amount === undefined && kind === "return"
              ? remaining
              : cents(input.amount, "退款金额");
        if (amount > remaining || (kind === "adjustment" && amount === 0))
          fail(400, "退款金额超出剩余可退范围");
        planned.push({ i, amount });
        total += BigInt(amount);
      }
      // Consistent lock order also protects against concurrent new sales after returns.
      for (const p of planned
        .slice()
        .sort((a, b) => a.i.unit_id.localeCompare(b.i.unit_id))) {
        const u = await stock.get(db, p.i.unit_id, true);
        if (u.status !== "sold") fail(409, "原销售设备状态不符");
        p.unit = u;
      }
      const target = id();
      await db.execute(
        "INSERT INTO sales_refunds (id,order_id,operator_id,reason,kind,amount,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?)",
        [target, o.id, r.user.id, reason, kind, money(total), key, digest],
      );
      for (const p of planned) {
        await db.execute(
          "INSERT INTO sales_refund_items (refund_id,sale_item_id,amount,cost_reversal) VALUES (?,?,?,?)",
          [target, p.i.id, money(p.amount), kind === "return" ? p.i.cost : 0],
        );
        if (kind === "return") {
          await db.execute(
            "UPDATE units SET status='recheck',share_flags=? WHERE id=?",
            [
              JSON.stringify({
                showInShop: false,
                sharePeer: false,
                shareAgent: false,
              }),
              p.i.unit_id,
            ],
          );
          await stock.ledger(
            db,
            r,
            p.i.unit_id,
            "sold",
            "recheck",
            "refund",
            target,
            reason,
          );
        }
      }
      await audit(db, r, "销售退款", o.id, {
        after: {
          refundId: target,
          kind,
          amount: Number(money(total)),
          itemIds: planned.map((p) => p.i.id),
        },
        reason,
      });
      return view(db, o, r);
    });
  });
};
