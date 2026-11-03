const { one, transaction } = require("./db");
const {
  PERM,
  fail,
  id,
  text,
  page,
  list,
  requirePerm,
  audit,
} = require("./core");
const { integer, cents, money } = require("./validation");
const { canSee } = require("./stock");
const { digest } = require("./repair-service");
module.exports = async function (app, { pool, route, repair }) {
  const read = (r) =>
      requirePerm(r, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.PARTS_MANAGE),
    manage = (r) => {
      requirePerm(r, PERM.PARTS_MANAGE);
      if (!canSee(r.user, "cost")) fail(403, "无权登记配件成本");
    };
  function view(p, r) {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      quantity: p.quantity,
      version: p.version,
      active: !!p.active,
      ...(canSee(r.user, "cost") ? { stockValue: Number(p.stock_value) } : {}),
    };
  }
  route("GET", "/repair-parts", async (r) => {
    read(r);
    const p = page(r.query),
      k = r.query.keyword
        ? "%" + text(r.query.keyword, "搜索", 100) + "%"
        : null,
      where = k ? " WHERE name LIKE ? OR sku LIKE ?" : "",
      args = k ? [k, k] : [],
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM repair_parts" + where,
        args,
      ),
      [rows] = await pool.query(
        "SELECT * FROM repair_parts" +
          where +
          " ORDER BY name,id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      rows.map((p) => view(p, r)),
      count.n,
      p,
    );
  });
  route("POST", "/repair-parts", async (r) => {
    manage(r);
    const d = r.body || {},
      sku = text(d.sku, "配件SKU", 80),
      name = text(d.name, "配件名称", 120),
      unit = text(d.unit || "件", "计量单位", 20);
    return transaction(pool, async (db) => {
      const old = await one(db, "SELECT * FROM repair_parts WHERE sku=?", [
        sku,
      ]);
      if (old) {
        if (old.name !== name || old.unit !== unit) fail(409, "配件SKU已存在");
        return view(old, r);
      }
      const target = id();
      await db.execute(
        "INSERT INTO repair_parts(id,sku,name,unit) VALUES (?,?,?,?)",
        [target, sku, name, unit],
      );
      await audit(db, r, "新增维修配件", target, {
        after: { sku, name, unit },
      });
      return view(
        await one(db, "SELECT * FROM repair_parts WHERE id=?", [target]),
        r,
      );
    });
  });
  route("POST", "/repair-parts/:id/receive", async (r) => {
    manage(r);
    const d = r.body || {},
      qty = integer(d.quantity, "数量", 1, 1000000),
      price = cents(d.unitCost, "采购单价"),
      reason = text(d.reason, "入库说明", 500),
      key = text(d.requestKey, "提交标识", 100),
      version = integer(d.version, "版本", 1, 2147483647),
      signature = digest({ target: r.params.id, qty, price, reason, version });
    return transaction(pool, async (db) => {
      const p = await one(
        db,
        "SELECT * FROM repair_parts WHERE id=? FOR UPDATE",
        [r.params.id],
      );
      if (!p) fail(404, "配件不存在");
      const prior = await one(
        db,
        // First consistent read after locking the part; no missing-key gap lock.
        "SELECT request_hash FROM repair_part_ledger WHERE actor_id=? AND request_key=?",
        [r.user.id, key],
      );
      if (prior) {
        if (prior.request_hash !== signature) fail(409, "提交标识内容冲突");
        return view(p, r);
      }
      if (!p.active || p.version !== version) fail(409, "配件或版本已变化");
      const total = BigInt(price) * BigInt(qty),
        stock = BigInt(cents(p.stock_value)) + total;
      if (p.quantity + qty > 1000000) fail(400, "库存数量超出范围");
      await db.execute(
        "UPDATE repair_parts SET quantity=quantity+?,stock_value=?,version=version+1 WHERE id=?",
        [qty, money(stock), p.id],
      );
      await db.execute(
        "INSERT INTO repair_part_ledger(id,part_id,kind,quantity,cost_amount,actor_id,reason,request_key,request_hash) VALUES (?,?,'receive',?,?,?,?,?,?)",
        [id(), p.id, qty, money(total), r.user.id, reason, key, signature],
      );
      await audit(db, r, "维修配件入库", p.id, {
        reason,
        after: { quantity: qty, cost: Number(money(total)) },
      });
      return view(
        await one(db, "SELECT * FROM repair_parts WHERE id=?", [p.id]),
        r,
      );
    });
  });
  route("GET", "/repair-parts/:id/ledger", async (r) => {
    read(r);
    const p = page(r.query),
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM repair_part_ledger WHERE part_id=?",
        [r.params.id],
      ),
      [rows] = await pool.query(
        "SELECT l.*,u.nickname operator,o.engineer_id FROM repair_part_ledger l JOIN users u ON u.id=l.actor_id LEFT JOIN repair_orders o ON o.id=l.order_id WHERE part_id=? ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?",
        [r.params.id, p.pageSize, p.offset],
      );
    return list(
      rows.map((p) => ({
        id: p.id,
        kind: p.kind,
        quantity: p.quantity,
        time: p.created_at,
        ...(r.user.permissions.some((key) =>
          [PERM.REPAIR_ASSIGN, PERM.REPAIR_CASH, PERM.PARTS_MANAGE].includes(
            key,
          ),
        ) || p.engineer_id === r.user.id
          ? {
              orderId: p.order_id,
              issueId: p.issue_id,
              reason: p.reason,
              operator: p.operator,
            }
          : {}),
        ...(canSee(r.user, "cost") ? { cost: Number(p.cost_amount) } : {}),
      })),
      count.n,
      p,
    );
  });
  async function move(db, r, row, returning) {
    const d = r.body,
      qty = integer(d.quantity, "数量", 1, 1000000);
    let issue,
      partId = d.partId,
      amount;
    if (returning) {
      issue = await one(
        db,
        "SELECT * FROM repair_part_ledger WHERE id=? AND order_id=? AND kind='issue'",
        [text(d.issueId, "领用记录", 36), row.id],
      );
      if (!issue) fail(404, "领用记录不存在");
      partId = issue.part_id;
    }
    const p = await one(
      db,
      "SELECT * FROM repair_parts WHERE id=? FOR UPDATE",
      [text(partId, "配件", 36)],
    );
    if (!p || !p.active) fail(404, "配件不存在");
    if (returning) {
      const ret = await one(
          db,
          "SELECT COALESCE(SUM(quantity),0) n,COALESCE(SUM(cost_amount),0) cost FROM repair_part_ledger WHERE issue_id=? AND kind='return'",
          [issue.id],
        ),
        remaining = issue.quantity - Number(ret.n),
        remainingCost = cents(issue.cost_amount) - cents(ret.cost);
      if (qty > remaining) fail(400, "退料超过原领用数量");
      amount = Number(
        (BigInt(remainingCost) * BigInt(qty) +
          BigInt(Math.floor(remaining / 2))) /
          BigInt(remaining),
      );
      if (p.quantity + qty > 1000000) fail(400, "库存数量超出范围");
      await db.execute(
        "UPDATE repair_parts SET quantity=quantity+?,stock_value=?,version=version+1 WHERE id=?",
        [qty, money(BigInt(cents(p.stock_value)) + BigInt(amount)), p.id],
      );
    } else {
      if (qty > p.quantity) fail(409, "配件库存不足");
      const value = BigInt(cents(p.stock_value));
      amount =
        qty === p.quantity
          ? Number(value)
          : Number(
              (value * BigInt(qty) + BigInt(Math.floor(p.quantity / 2))) /
                BigInt(p.quantity),
            );
      await db.execute(
        "UPDATE repair_parts SET quantity=quantity-?,stock_value=?,version=version+1 WHERE id=?",
        [qty, money(value - BigInt(amount)), p.id],
      );
    }
    const target = id();
    await db.execute(
      "INSERT INTO repair_part_ledger(id,part_id,order_id,issue_id,kind,quantity,cost_amount,actor_id,reason,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      [
        target,
        p.id,
        row.id,
        returning ? issue.id : null,
        returning ? "return" : "issue",
        qty,
        money(amount),
        r.user.id,
        text(d.reason, "领退料说明", 500),
        text(d.requestKey, "标识", 100),
        digest({ order: row.id, ...d }),
      ],
    );
    return {
      data: {
        partId: p.id,
        issueId: returning ? issue.id : target,
        quantity: qty,
      },
      costData: { cost: amount / 100 },
    };
  }
  return { move };
};
