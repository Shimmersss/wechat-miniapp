const { one } = require("./db");
const { PERM, fail, id, text, json, requirePerm, hash } = require("./core");
const { canSee, stockService } = require("./stock");
const { canReadInternal } = require("./repair-files");
const { cents, money } = require("./validation");
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
const digest = (v) => hash(JSON.stringify(canonical(v)));
const readPerms = [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH];
function repairService({ config }) {
  const stock = stockService({ config });
  function read(r, row) {
    requirePerm(r, ...readPerms);
    if (!r.user.staffNo) fail(403, "仅员工可查看维修单");
    if (
      row &&
      !r.user.permissions.some((p) =>
        [PERM.REPAIR_ASSIGN, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH].includes(p),
      ) &&
      row.engineer_id !== r.user.id
    )
      fail(404, "维修单不存在");
  }
  function write(r, row) {
    requirePerm(r, PERM.REPAIR_HANDLE);
    read(r, row);
    if (
      !r.user.permissions.includes(PERM.REPAIR_ASSIGN) &&
      row.engineer_id !== r.user.id
    )
      fail(403, "仅可处理本人获分派工单");
  }
  const cost = (r) => canSee(r.user, "cost");
  async function get(db, target, lock = false) {
    const row = await one(
      db,
      "SELECT * FROM repair_orders WHERE id=?" + (lock ? " FOR UPDATE" : ""),
      [target],
    );
    if (!row) fail(404, "维修单不存在");
    return row;
  }
  async function totals(db, target) {
    const [payments] = await db.execute(
      "SELECT kind,amount FROM repair_payments WHERE order_id=?",
      [target],
    );
    let received = 0n,
      expenses = 0n;
    for (const p of payments) {
      const n = BigInt(cents(p.amount));
      if (p.kind === "receipt") received += n;
      if (p.kind === "refund") received -= n;
      if (p.kind === "expense") expenses += n;
      if (p.kind === "expense_refund") expenses -= n;
    }
    const [rows] = await db.execute(
      "SELECT kind,cost_amount FROM repair_part_ledger WHERE order_id=?",
      [target],
    );
    let parts = 0n;
    for (const p of rows)
      parts += (p.kind === "issue" ? 1n : -1n) * BigInt(cents(p.cost_amount));
    money(received);
    money(expenses);
    money(parts);
    return {
      received: Number(received),
      expenses: Number(expenses),
      parts: Number(parts),
    };
  }
  async function files(db, values, r) {
    if (values === undefined) return [];
    if (!Array.isArray(values) || values.length > 9)
      fail(400, "每组附件最多9张");
    const seen = new Set(),
      result = [];
    for (const v of values) {
      const target = text(v?.fileId, "附件编号", 36);
      if (seen.has(target)) fail(400, "附件重复");
      seen.add(target);
      const f = await one(db, "SELECT * FROM files WHERE id=? FOR SHARE", [
        target,
      ]);
      if (!f || f.scope !== "internal" || !f.mime.startsWith("image/"))
        fail(400, "维修附件须单独上传为内部图片");
      if (
        await one(
          db,
          "SELECT unit_id FROM unit_files WHERE file_id=? LIMIT 1",
          [target],
        )
      )
        fail(400, "入库凭证不能用作维修附件");
      if (
        await one(
          db,
          "SELECT order_id FROM loan_files WHERE file_id=? LIMIT 1",
          [target],
        )
      )
        fail(400, "借还附件不能作为维修凭证");
      if (!(await canReadInternal(db, f, r.user))) fail(403, "无权引用此附件");
      result.push(f);
    }
    return result;
  }
  async function attach(db, target, values, purpose) {
    if (purpose !== "expense")
      for (const file of values)
        if (
          await one(
            db,
            "SELECT order_id FROM repair_files WHERE file_id=? AND purpose='expense' LIMIT 1",
            [file.id],
          )
        )
          fail(400, "费用凭证不能转作普通维修附件");
    const [existing] = await db.execute(
      "SELECT file_id FROM repair_files WHERE order_id=? AND purpose=?",
      [target, purpose],
    );
    if (
      new Set(existing.map((f) => f.file_id).concat(values.map((f) => f.id)))
        .size > 9
    )
      fail(400, "每组维修附件最多9张");
    for (let i = 0; i < values.length; i++)
      await db.execute(
        "INSERT IGNORE INTO repair_files(order_id,file_id,purpose,position) VALUES (?,?,?,?)",
        [target, values[i].id, purpose, i],
      );
  }
  async function event(
    db,
    r,
    row,
    key,
    signature,
    action,
    note,
    publicData = {},
    internalData = null,
  ) {
    await db.execute(
      "INSERT INTO repair_events(id,order_id,actor_id,action,from_status,to_status,version,note,public_data,internal_data,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        id(),
        row.id,
        r.user.id,
        action,
        row._from || row.status,
        row.status,
        row.version,
        note,
        JSON.stringify(publicData),
        internalData === null ? null : JSON.stringify(internalData),
        key,
        signature,
      ],
    );
  }
  async function bump(db, row, patch = {}) {
    const keys = Object.keys(patch);
    if (keys.length)
      await db.execute(
        "UPDATE repair_orders SET " +
          keys.map((k) => k + "=?").join(",") +
          ",version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [...keys.map((k) => patch[k]), row.id],
      );
    else
      await db.execute(
        "UPDATE repair_orders SET version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?",
        [row.id],
      );
    row._from = row.status;
    Object.assign(row, patch);
    row.version++;
  }
  async function view(db, row, r) {
    read(r, row);
    const total = await totals(db, row.id),
      [events] = await db.execute(
        "SELECT e.*,u.nickname operator FROM repair_events e JOIN users u ON u.id=e.actor_id WHERE order_id=? ORDER BY version,e.id",
        [row.id],
      ),
      [attached] = await db.execute(
        "SELECT f.*,rf.purpose FROM repair_files rf JOIN files f ON f.id=rf.file_id WHERE rf.order_id=? ORDER BY rf.purpose,rf.position,rf.file_id",
        [row.id],
      ),
      [payments] = await db.execute(
        "SELECT p.*,u.nickname operator FROM repair_payments p JOIN users u ON u.id=p.actor_id WHERE order_id=? ORDER BY p.created_at,p.id",
        [row.id],
      ),
      [parts] = await db.execute(
        "SELECT l.*,p.name,p.sku,COALESCE((SELECT SUM(rr.quantity) FROM repair_part_ledger rr WHERE rr.issue_id=l.id AND rr.kind='return'),0) returned FROM repair_part_ledger l JOIN repair_parts p ON p.id=l.part_id WHERE l.order_id=? AND l.kind='issue' ORDER BY l.created_at,l.id",
        [row.id],
      );
    const media = [];
    for (const f of attached)
      if (await canReadInternal(db, f, r.user))
        media.push({ ...stock.fileView(f, r), purpose: f.purpose });
    const engineer = row.engineer_id
        ? await one(db, "SELECT name FROM staff WHERE user_id=?", [
            row.engineer_id,
          ])
        : null,
      allocation = cost(r)
        ? await one(
            db,
            "SELECT * FROM repair_cost_allocations WHERE order_id=?",
            [row.id],
          )
        : null;
    return {
      id: row.id,
      no: row.no,
      kind: row.kind,
      unitId: row.unit_id,
      model: row.model,
      customer: row.customer,
      phone: row.phone,
      imeiMasked: row.identifier
        ? row.identifier.length > 6
          ? row.identifier.slice(0, 2) + "****" + row.identifier.slice(-4)
          : "***"
        : "",
      ...(canSee(r.user, "fullImei") ? { identifier: row.identifier } : {}),
      fault: row.fault,
      engineerId: row.engineer_id,
      engineer: engineer?.name || "未分派",
      expectedAt: row.expected_date,
      status: row.status,
      version: row.version,
      diagnosis: row.diagnosis,
      waitingParts: !!row.waiting_parts,
      quote: row.quote === null ? null : Number(row.quote),
      quoteVersion: row.quote_version,
      confirmedVersion: row.confirmed_version,
      warrantyDays: row.warranty_days,
      pickupName: row.pickup_name,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      overdue:
        !["completed", "cancelled"].includes(row.status) &&
        !!row.expected_date &&
        row.expected_date <
          new Date(Date.now() + 28800000).toISOString().slice(0, 10),
      files: media,
      received: total.received / 100,
      ...(cost(r)
        ? {
            partsCost: total.parts / 100,
            expenses: total.expenses / 100,
            costAllocation: allocation,
          }
        : {}),
      ...(canSee(r.user, "profit") &&
      r.user.permissions.includes(PERM.PROFIT_VIEW)
        ? {
            profit:
              row.kind === "external"
                ? (total.received - total.parts - total.expenses) / 100
                : null,
          }
        : {}),
      canManage:
        r.user.permissions.includes(PERM.REPAIR_HANDLE) &&
        (r.user.permissions.includes(PERM.REPAIR_ASSIGN) ||
          row.engineer_id === r.user.id),
      canQuote: r.user.permissions.includes(PERM.REPAIR_QUOTE),
      canAssign: r.user.permissions.includes(PERM.REPAIR_ASSIGN),
      canCash: r.user.permissions.includes(PERM.REPAIR_CASH),
      canRefund:
        r.user.permissions.includes(PERM.REPAIR_CASH) &&
        r.user.permissions.includes(PERM.REFUND),
      canExpense: r.user.permissions.includes(PERM.REPAIR_CASH) && cost(r),
      timeline: events.map((e) => ({
        id: e.id,
        action: e.action,
        from: e.from_status,
        to: e.to_status,
        version: e.version,
        note: e.note,
        time: e.created_at,
        operator: e.operator,
        data: json(e.public_data),
        ...(cost(r) ? { costData: json(e.internal_data) } : {}),
      })),
      parts: parts.map((p) => ({
        id: p.id,
        partId: p.part_id,
        name: p.name,
        sku: p.sku,
        quantity: p.quantity,
        returned: Number(p.returned),
        ...(cost(r) ? { cost: Number(p.cost_amount) } : {}),
      })),
      payments: payments
        .filter((p) => cost(r) || !p.kind.startsWith("expense"))
        .map((p) => ({
          id: p.id,
          kind: p.kind,
          amount: Number(p.amount),
          method: p.method,
          reason: p.reason,
          time: p.created_at,
          operator: p.operator,
        })),
    };
  }
  async function finishInventory(db, r, row) {
    if (row.kind !== "inventory") return;
    const unit = await stock.get(db, row.unit_id, true);
    if (unit.status !== "repairing") fail(409, "本店设备维修状态已变化");
    const t = await totals(db, row.id),
      policy = config.repair.internalCostPolicy;
    if (!["capitalize", "separate"].includes(policy))
      fail(503, "本店维修成本处理尚未配置");
    const added = t.parts + t.expenses,
      next =
        policy === "capitalize"
          ? money(BigInt(cents(unit.cost)) + BigInt(added))
          : String(unit.cost);
    await db.execute(
      "INSERT INTO repair_cost_allocations(order_id,unit_id,policy,parts_cost,expenses,total_cost,old_unit_cost,new_unit_cost) VALUES (?,?,?,?,?,?,?,?)",
      [
        row.id,
        unit.id,
        policy,
        money(t.parts),
        money(t.expenses),
        money(added),
        unit.cost,
        next,
      ],
    );
    await db.execute(
      "UPDATE units SET status='recheck',cost=?,share_flags=? WHERE id=?",
      [
        next,
        JSON.stringify({
          showInShop: false,
          sharePeer: false,
          shareAgent: false,
        }),
        unit.id,
      ],
    );
    await stock.ledger(
      db,
      r,
      unit.id,
      "repairing",
      "recheck",
      "repair_done",
      row.id,
      "维修结束，待独立复检",
    );
  }
  return {
    read,
    write,
    cost,
    get,
    view,
    files,
    attach,
    event,
    bump,
    totals,
    finishInventory,
  };
}
module.exports = { repairService, digest, readPerms };
