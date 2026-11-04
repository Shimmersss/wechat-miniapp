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
const { lockFiles, fileLinks } = require("./repair-files");
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
  { pool, config, route, customerRequests, agents },
) {
  const stock = stockService({ config }),
    read = (r) =>
      requirePerm(r, PERM.SALES_CREATE, PERM.REFUND, PERM.STATS_VIEW);
  /** 收款凭证：本人上传（老板/店长可引用他人）的内部图片，最多9张；不能复用其他业务的附件 */
  async function receiptFiles(db, values, r, required = false) {
    if (values === undefined) values = [];
    if (
      !Array.isArray(values) ||
      values.length > 9 ||
      (required && !values.length)
    )
      fail(400, "收款凭证须为1～9张内部图片");
    const result = [],
      ids = values.map((v) => text(v?.fileId, "收款凭证", 36));
    if (new Set(ids).size !== ids.length) fail(400, "收款凭证重复");
    // 排他锁 + 锁定读取，防止与入库/维修/借还并发认领同一文件
    const locked = await lockFiles(db, ids);
    for (const target of ids) {
      const f = locked.get(target);
      if (!f || f.scope !== "internal" || !f.mime.startsWith("image/"))
        fail(400, "收款凭证须单独上传为内部图片");
      const links = await fileLinks(db, target);
      if (links.unit || links.repair || links.loan)
        fail(400, "其他业务凭证不能用作收款凭证");
      if (
        f.owner_id !== r.user.id &&
        !["boss", "manager"].includes(r.user.role)
      )
        fail(403, "无权引用他人的收款凭证");
      result.push(f);
    }
    return result;
  }
  /** 关联收款凭证；同一文件只能属于一张销售单，已属于本单的视为重试 */
  async function attachReceipts(db, orderId, files, r) {
    const added = [];
    for (const f of files) {
      const linked = await one(
        db,
        "SELECT order_id FROM sales_files WHERE file_id=? FOR SHARE",
        [f.id],
      );
      if (linked && linked.order_id !== orderId)
        fail(409, "该凭证已关联其他销售单");
      if (linked) continue;
      await db.execute(
        "INSERT INTO sales_files (order_id,file_id,added_by) VALUES (?,?,?)",
        [orderId, f.id, r.user.id],
      );
      added.push(f.id);
    }
    return added;
  }
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
        if (!["retail", "wholesale", "agent"].includes(channel))
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
  async function plan(db, input, r, lock, requestId) {
    const items = [];
    let total = 0n,
      cost = 0n;
    for (const x of input) {
      const u = await stock.get(db, x.unitId, lock);
      // 代理订单：设备须由该订单锁定，按分享价快照成交，不能改价（框架文档 7.3）
      const agentOrder =
        x.channel === "agent"
          ? await agents.saleItem(db, requestId || "", x.unitId, lock)
          : null;
      if (
        u.ownership !== "own" ||
        u.status !== (agentOrder ? "locked" : "in_stock")
      )
        fail(409, "设备不可售，请刷新库存");
      if (x.priceVersion !== u.price_version)
        fail(409, "设备价格已变化，请重新核对");
      if (x.channel === "wholesale" && !canSee(r.user, "wholesalePrice"))
        fail(403, "无权限使用批发价格");
      if (agentOrder && x.price !== undefined)
        fail(400, "代理订单按分享价成交，不能改价");
      const base = cents(
          agentOrder
            ? agentOrder.share_price
            : x.channel === "wholesale"
              ? u.wholesale
              : u.retail,
        ),
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
    if (row.status === "locked" && r.query.customerRequestId)
      await agents.saleItem(
        pool,
        text(r.query.customerRequestId, "代理订单", 36),
        row.id,
        false,
      );
    else if (row.status !== "in_stock" || row.ownership !== "own")
      fail(409, "设备不可售");
    return stock.view(pool, row, r);
  });
  route("POST", "/sales/quote", async (r) => {
    requirePerm(r, PERM.SALES_CREATE);
    const body = r.body || {},
      result = await transaction(pool, (db) =>
        plan(
          db,
          rows(body),
          r,
          false,
          body.customerRequestId
            ? text(body.customerRequestId, "顾客意向", 36)
            : null,
        ),
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
      const receipts = await receiptFiles(db, d.receipts, r);
      const prior = await one(
        db,
        "SELECT id,request_hash FROM sales_orders WHERE request_key=?",
        [key],
      );
      if (prior) {
        if (prior.request_hash !== digest) fail(409, "提交标识内容冲突");
        return view(db, await order(db, prior.id), r);
      }
      const p = await plan(
          db,
          input,
          r,
          true,
          d.customerRequestId
            ? text(d.customerRequestId, "顾客意向", 36)
            : null,
        ),
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
          u.status,
          "sold",
          "sales_order",
          target,
          reason || "实际收款确认",
        );
      }
      await customerRequests.recordSale(db, r, referral, target);
      await attachReceipts(db, target, receipts, r);
      await audit(db, r, "销售收款出库", target, {
        after: {
          unitIds: input.map((x) => x.unitId),
          amount: Number(p.total),
          payMethod: pay,
          ...(referral ? { customerRequestId: referral.id } : {}),
          ...(receipts.length ? { receipts: receipts.length } : {}),
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
  /** 销售单里出现过的销售员，供列表按销售员筛选 */
  route("GET", "/sales-orders/sellers", async (r) => {
    read(r);
    const [rows] = await pool.query(
      "SELECT o.seller_id id,COALESCE(MAX(s.name),MAX(u.nickname)) name FROM sales_orders o JOIN users u ON u.id=o.seller_id LEFT JOIN staff s ON s.user_id=u.id GROUP BY o.seller_id ORDER BY name,id",
    );
    return rows.map((x) => ({ id: x.id, name: x.name || "未命名" }));
  });
  async function receiptsOf(db, orderId, r) {
    const [rows] = await db.execute(
      "SELECT f.*,s.created_at added_at,COALESCE(st.name,u.nickname) added_by_name FROM sales_files s JOIN files f ON f.id=s.file_id JOIN users u ON u.id=s.added_by LEFT JOIN staff st ON st.user_id=u.id WHERE s.order_id=? ORDER BY s.created_at,s.file_id",
      [orderId],
    );
    return rows.map((f) => ({
      ...stock.fileView(f, r),
      addedAt: f.added_at,
      addedBy: f.added_by_name,
    }));
  }
  async function detail(db, o, r) {
    return {
      ...(await view(db, o, r)),
      agentSources: await agents.saleSources(db, o.id, r.user),
      receipts: await receiptsOf(db, o.id, r),
    };
  }
  route("GET", "/sales-orders/:id", async (r) => {
    read(r);
    return detail(pool, await order(pool, r.params.id), r);
  });
  /** 补传收款凭证：开单或退款权限，需说明，写审计；已关联本单的文件原样重试不重复记录 */
  route("POST", "/sales-orders/:id/receipts", async (r) => {
    requirePerm(r, PERM.SALES_CREATE, PERM.REFUND);
    const d = r.body || {},
      reason = text(d.reason, "补传说明", 500);
    return transaction(pool, async (db) => {
      const o = await order(db, r.params.id, true),
        files = await receiptFiles(db, d.receipts, r, true),
        added = await attachReceipts(db, o.id, files, r);
      const total = await one(
        db,
        "SELECT COUNT(*) n FROM sales_files WHERE order_id=?",
        [o.id],
      );
      if (Number(total.n) > 20) fail(400, "每张销售单最多20张收款凭证");
      if (added.length)
        await audit(db, r, "补传收款凭证", o.id, {
          after: { fileIds: added },
          reason,
        });
      return detail(db, o, r);
    });
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
        return detail(db, o, r);
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
          await agents.onReturn(db, r, o.id, p.i.unit_id, target);
        }
        // TODO(confirm): 差价退款（adjustment）是否同步扣减代理收益，框架文档仅规定退款冲回。
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
      return detail(db, o, r);
    });
  });
};
