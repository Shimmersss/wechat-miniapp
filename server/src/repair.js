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
const { integer, cents, money, date } = require("./validation");
const { stockService } = require("./stock");
const { isPhone, isImei } = require("../../miniprogram/utils/validate");
const { TRANSITIONS } = require("../../miniprogram/constants/repair");
const { REPAIR_FLOW } = require("../../miniprogram/constants/status");
const { repairService, digest, readPerms } = require("./repair-service");
const terminal = (s) => ["completed", "cancelled"].includes(s);
module.exports = async function (app, deps) {
  const { pool, config, route } = deps,
    repair = repairService({ config }),
    stock = stockService({ config });
  const parts = await require("./repair-parts")(app, { ...deps, repair });
  function allowed(d, keys) {
    if (!d || Array.isArray(d) || Object.keys(d).some((k) => !keys.includes(k)))
      fail(400, "提交参数无效；不保存开机密码");
  }
  async function engineer(db, value) {
    if (!value) return null;
    const target = text(value, "工程师", 36),
      s = await one(
        db,
        "SELECT s.user_id FROM staff s JOIN users u ON u.id=s.user_id JOIN roles r ON r.role_key=s.role_key WHERE s.user_id=? AND s.role_key='engineer' AND s.status='active' AND u.status='active' AND JSON_CONTAINS(r.permissions,JSON_QUOTE(?))",
        [target, PERM.REPAIR_HANDLE],
      );
    if (!s) fail(400, "工程师账号不可用");
    return target;
  }
  route("GET", "/repair-orders/options", async (r) => {
    requirePerm(r, ...readPerms, PERM.PARTS_MANAGE);
    if (!r.user.staffNo) fail(403, "仅员工可查看维修选项");
    const [people] = await pool.execute(
      "SELECT s.user_id id,s.name FROM staff s JOIN users u ON u.id=s.user_id JOIN roles r ON r.role_key=s.role_key WHERE s.role_key='engineer' AND s.status='active' AND u.status='active' AND JSON_CONTAINS(r.permissions,JSON_QUOTE(?)) ORDER BY s.name,s.id",
      [PERM.REPAIR_HANDLE],
    );
    return {
      engineers: r.user.permissions.includes(PERM.REPAIR_ASSIGN)
        ? people
        : people.filter((p) => p.id === r.user.id),
      canManageParts:
        r.user.permissions.includes(PERM.PARTS_MANAGE) && repair.cost(r),
      passwordStorage: false,
      internalCostPolicy: config.repair.internalCostPolicy,
    };
  });
  route("POST", "/repair-orders", async (r) => {
    requirePerm(r, PERM.REPAIR_HANDLE);
    repair.read(r);
    const d = r.body || {};
    allowed(d, [
      "requestKey",
      "kind",
      "unitId",
      "model",
      "identifier",
      "customer",
      "phone",
      "fault",
      "engineerId",
      "expectedAt",
      "photos",
    ]);
    const key = text(d.requestKey, "提交标识", 100),
      kind = d.kind || "external";
    if (!["external", "inventory"].includes(kind)) fail(400, "维修来源无效");
    const fault = text(d.fault, "故障", 2000),
      customer = kind === "external" ? text(d.customer, "联系人", 100) : "",
      phone = kind === "external" ? text(d.phone, "联系电话", 30) : "";
    if (kind === "external" && !isPhone(phone)) fail(400, "请填写11位联系电话");
    const signature = digest({ actor: r.user.id, ...d }),
      prior = await one(
        pool,
        "SELECT * FROM repair_orders WHERE creator_id=? AND request_key=?",
        [r.user.id, key],
      );
    if (prior) {
      if (prior.request_hash !== signature) fail(409, "提交标识内容冲突");
      return repair.view(pool, prior, r);
    }
    try {
      return await transaction(pool, async (db) => {
        const assigned = r.user.permissions.includes(PERM.REPAIR_ASSIGN)
          ? await engineer(db, d.engineerId)
          : await engineer(db, r.user.id);
        if (
          !r.user.permissions.includes(PERM.REPAIR_ASSIGN) &&
          d.engineerId &&
          d.engineerId !== r.user.id
        )
          fail(403, "不能指派其他工程师");
        let unitId = null,
          model,
          identifier;
        if (kind === "inventory") {
          requirePerm(r, PERM.INVENTORY_VIEW);
          unitId = text(d.unitId, "本店设备", 36);
          const u = await stock.get(db, unitId, true);
          if (u.status !== "in_stock" || u.ownership !== "own")
            fail(409, "只有本店自有可售设备能从库存发起送修");
          model = u.name;
          identifier = u.imei1;
        } else {
          if (d.unitId) fail(400, "外部送修不得关联本店库存");
          model = text(d.model, "设备型号", 120);
          identifier = text(
            d.identifier,
            "IMEI/序列号",
            80,
            true,
          ).toUpperCase();
          if (/^\d{15}$/.test(identifier) && !isImei(identifier))
            fail(400, "IMEI校验位无效");
          if (identifier) {
            const u = await one(
              db,
              "SELECT u.status FROM unit_identifiers i JOIN units u ON u.id=i.unit_id WHERE i.imei=? FOR SHARE",
              [identifier],
            );
            if (u && !["sold", "returned"].includes(u.status))
              fail(409, "该串码属于门店业务库存，请从库存档案发起");
          }
        }
        const photos = await repair.files(db, d.photos, r),
          target = id(),
          no = "RO" + target.replaceAll("-", ""),
          expected = d.expectedAt ? date(d.expectedAt, "预计完成日期") : null;
        await db.execute(
          "INSERT INTO repair_orders(id,no,kind,unit_id,model,identifier,customer,phone,fault,engineer_id,expected_date,request_key,request_hash,creator_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [
            target,
            no,
            kind,
            unitId,
            model,
            identifier,
            customer,
            phone,
            fault,
            assigned,
            expected,
            key,
            signature,
            r.user.id,
          ],
        );
        if (kind === "external" && identifier)
          await db.execute(
            "INSERT INTO repair_external_slots(identifier,order_id) VALUES (?,?)",
            [identifier, target],
          );
        await repair.attach(db, target, photos, "appearance");
        if (unitId) {
          await db.execute(
            "UPDATE units SET status='repairing',share_flags=? WHERE id=?",
            [
              JSON.stringify({
                showInShop: false,
                sharePeer: false,
                shareAgent: false,
              }),
              unitId,
            ],
          );
          await stock.ledger(
            db,
            r,
            unitId,
            "in_stock",
            "repairing",
            "repair_order",
            target,
            "本店设备送修",
          );
        }
        const row = await repair.get(db, target);
        await repair.event(db, r, row, key, signature, "create", "创建维修单", {
          kind,
          unitId,
        });
        await audit(db, r, "创建维修单", target, {
          after: { kind, unitId, engineerId: assigned },
        });
        return repair.view(db, row, r);
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        const old = await one(
          pool,
          "SELECT * FROM repair_orders WHERE creator_id=? AND request_key=?",
          [r.user.id, key],
        );
        if (old) {
          if (old.request_hash !== signature) fail(409, "提交标识内容冲突");
          return repair.view(pool, old, r);
        }
      }
      throw error;
    }
  });
  async function mutate(r, action, keys, guard, fn) {
    const d = r.body || {};
    allowed(d, ["requestKey", "version", "reason", ...keys]);
    const key = text(d.requestKey, "操作标识", 100),
      version = integer(d.version, "版本", 1, 2147483647),
      note = text(d.reason, "处理说明", 500),
      signature = digest({ action, actor: r.user.id, ...d });
    return transaction(pool, async (db) => {
      const row = await repair.get(db, r.params.id, true);
      guard(r, row);
      const old = await one(
        db,
        // The order row is already exclusively locked. This is the first
        // consistent read, so a waiting retry sees the preceding commit.
        // Missing-key FOR SHARE would gap-lock unrelated orders' events.
        "SELECT request_hash FROM repair_events WHERE order_id=? AND request_key=?",
        [row.id, key],
      );
      if (old) {
        if (old.request_hash !== signature) fail(409, "操作标识内容冲突");
        return repair.view(db, row, r);
      }
      if (row.version !== version) fail(409, "维修单已更新，请刷新核对");
      const result = await fn(db, row, d);
      await repair.bump(db, row, result.patch || {});
      await repair.event(
        db,
        r,
        row,
        key,
        signature,
        action,
        note,
        result.data || {},
        result.costData || null,
      );
      await audit(db, r, "维修处理:" + action, row.id, {
        reason: note,
        after: { status: row.status, version: row.version },
      });
      return repair.view(db, row, r);
    });
  }
  route("PUT", "/repair-orders/:id", (r) =>
    mutate(
      r,
      "update",
      [
        "customer",
        "phone",
        "fault",
        "engineerId",
        "expectedAt",
        "diagnosis",
        "waitingParts",
        "photos",
      ],
      repair.write,
      async (db, row, d) => {
        if (terminal(row.status)) fail(409, "已结束维修不能编辑");
        const patch = {};
        for (const [key, col, max] of [
          ["fault", "fault", 2000],
          ["diagnosis", "diagnosis", 2000],
        ])
          if (d[key] !== undefined)
            patch[col] = text(
              d[key],
              key === "fault" ? "故障" : "检测结果",
              max,
            );
        if (d.customer !== undefined || d.phone !== undefined) {
          requirePerm(r, PERM.REPAIR_ASSIGN);
          if (row.kind !== "external") fail(400, "本店维修不登记顾客联系资料");
          if (d.customer !== undefined)
            patch.customer = text(d.customer, "联系人", 100);
          if (d.phone !== undefined) {
            patch.phone = text(d.phone, "电话", 30);
            if (!isPhone(patch.phone)) fail(400, "联系电话格式无效");
          }
        }
        if (d.engineerId !== undefined) {
          requirePerm(r, PERM.REPAIR_ASSIGN);
          patch.engineer_id = await engineer(db, d.engineerId);
        }
        if (d.expectedAt !== undefined)
          patch.expected_date = d.expectedAt ? date(d.expectedAt) : null;
        if (d.waitingParts !== undefined) {
          if (typeof d.waitingParts !== "boolean") fail(400, "待配件标记无效");
          patch.waiting_parts = d.waitingParts;
        }
        const photos = await repair.files(db, d.photos, r);
        await repair.attach(db, row.id, photos, "appearance");
        if (!Object.keys(patch).length && !photos.length)
          fail(400, "没有需保存的改动");
        return {
          patch,
          data: { ...patch, addedPhotos: photos.map((f) => f.id) },
        };
      },
    ),
  );
  route("POST", "/repair-orders/:id/quote", (r) =>
    mutate(
      r,
      "quote",
      ["amount"],
      (r, row) => {
        requirePerm(r, PERM.REPAIR_QUOTE);
        repair.read(r, row);
      },
      async (db, row, d) => {
        if (!["checking", "pending_confirm"].includes(row.status))
          fail(409, "当前节点不能报价");
        const amount = cents(d.amount, "维修报价"),
          total = await repair.totals(db, row.id);
        if (amount < total.received)
          fail(400, "新报价低于已收净额，请先办理退款");
        return {
          patch: {
            quote: money(amount),
            quote_version: row.quote_version + 1,
            confirmed_version: null,
          },
          data: { quote: amount / 100, quoteVersion: row.quote_version + 1 },
        };
      },
    ),
  );
  route("POST", "/repair-orders/:id/confirm", (r) =>
    mutate(
      r,
      "confirm",
      ["quoteVersion", "confirmed"],
      repair.write,
      async (db, row, d) => {
        if (row.kind === "inventory") requirePerm(r, PERM.REPAIR_ASSIGN);
        if (
          row.status !== "pending_confirm" ||
          row.quote === null ||
          d.quoteVersion !== row.quote_version ||
          d.confirmed !== true
        )
          fail(409, "请核对当前报价版本并记录已获确认");
        return {
          patch: { confirmed_version: row.quote_version },
          data: { quoteVersion: row.quote_version, confirmed: true },
        };
      },
    ),
  );
  route("POST", "/repair-orders/:id/parts/issue", (r) =>
    mutate(
      r,
      "issue",
      ["partId", "quantity"],
      repair.write,
      async (db, row) => {
        if (row.status !== "repairing") fail(409, "仅维修中可领用配件");
        return parts.move(db, r, row, false);
      },
    ),
  );
  route("POST", "/repair-orders/:id/parts/return", (r) =>
    mutate(
      r,
      "return_parts",
      ["issueId", "quantity"],
      repair.write,
      async (db, row) => {
        if (!["repairing", "pending_pickup"].includes(row.status))
          fail(409, "当前节点不能退料");
        return parts.move(db, r, row, true);
      },
    ),
  );
  route("POST", "/repair-orders/:id/payment", (r) =>
    mutate(
      r,
      "payment",
      ["kind", "amount", "method", "confirmed", "proof"],
      (r, row) => {
        requirePerm(r, PERM.REPAIR_CASH);
        repair.read(r, row);
      },
      async (db, row, d) => {
        if (
          !["receipt", "refund", "expense", "expense_refund"].includes(
            d.kind,
          ) ||
          d.confirmed !== true ||
          !["微信", "支付宝", "现金", "银行卡", "其他"].includes(d.method)
        )
          fail(400, "请选择收支类型/方式并确认已实际办理");
        const amount = cents(d.amount);
        if (amount === 0) fail(400, "金额须大于零");
        const total = await repair.totals(db, row.id);
        if (d.kind.includes("refund")) requirePerm(r, PERM.REFUND);
        if (d.kind.startsWith("expense")) {
          if (!repair.cost(r)) fail(403, "无权登记维修成本");
          if (row.kind === "inventory" && terminal(row.status))
            fail(409, "本店维修成本已归档，不能重复调整");
          if (d.kind === "expense_refund" && amount > total.expenses)
            fail(400, "超过可退维修费用");
        } else {
          if (row.kind !== "external") fail(400, "本店维修不登记对客收退款");
          if (
            d.kind === "receipt" &&
            (row.status === "cancelled" ||
              row.quote === null ||
              total.received + amount > cents(row.quote))
          )
            fail(400, "未报价或收款超过报价");
          if (d.kind === "refund" && amount > total.received)
            fail(400, "退款超过已收净额");
        }
        const proof = await repair.files(db, d.proof, r);
        await repair.attach(
          db,
          row.id,
          proof,
          d.kind.startsWith("expense") ? "expense" : "payment",
        );
        await db.execute(
          "INSERT INTO repair_payments(id,order_id,kind,amount,method,actor_id,reason) VALUES (?,?,?,?,?,?,?)",
          [
            id(),
            row.id,
            d.kind,
            money(amount),
            d.method,
            r.user.id,
            text(d.reason, "说明", 500),
          ],
        );
        return d.kind.startsWith("expense")
          ? { data: { kind: d.kind }, costData: { amount: amount / 100 } }
          : { data: { kind: d.kind, amount: amount / 100 } };
      },
    ),
  );
  route("POST", "/repair-orders/:id/transition", (r) =>
    mutate(
      r,
      "transition",
      ["to", "result", "pickupName", "pickupProof", "warrantyDays"],
      repair.write,
      async (db, row, d) => {
        if (!(TRANSITIONS[row.status] || []).includes(d.to))
          fail(409, "不允许跨节点推进");
        const patch = { status: d.to },
          data = { to: d.to };
        if (
          d.to === "pending_confirm" &&
          (!row.diagnosis || row.quote === null)
        )
          fail(400, "请先保存检测结果并由有权限人员报价");
        if (
          d.to === "repairing" &&
          (row.confirmed_version !== row.quote_version || row.quote === null)
        )
          fail(409, "当前报价尚未确认");
        if (row.status === "pending_confirm" && d.to === "checking")
          patch.confirmed_version = null;
        if (d.to === "pending_pickup") {
          if (row.waiting_parts) fail(400, "仍在等待配件");
          data.result = text(d.result, "维修结果", 2000);
        }
        if (d.to === "cancelled") {
          const t = await repair.totals(db, row.id);
          if (t.received !== 0) fail(409, "请先退清已收款");
          if (t.parts !== 0) fail(409, "请先核对领用配件");
          await repair.finishInventory(db, r, row);
        }
        if (d.to === "completed") {
          const pickup = text(d.pickupName, "取机/交接人", 100),
            proof = await repair.files(db, d.pickupProof, r);
          if (!proof.length) fail(400, "请上传取机/交接凭证");
          const t = await repair.totals(db, row.id);
          if (
            row.kind === "external" &&
            (row.quote === null || t.received !== cents(row.quote))
          )
            fail(409, "请先结清当前维修报价");
          patch.pickup_name = pickup;
          patch.warranty_days = integer(
            d.warrantyDays,
            "维修质保天数",
            0,
            3650,
          );
          patch.completed_at = new Date();
          await repair.attach(db, row.id, proof, "pickup");
          await repair.finishInventory(db, r, row);
          data.pickupName = pickup;
          data.warrantyDays = patch.warranty_days;
        }
        if (terminal(d.to) && row.kind === "external" && row.identifier)
          await db.execute(
            "DELETE FROM repair_external_slots WHERE order_id=?",
            [row.id],
          );
        return { patch, data };
      },
    ),
  );
  function scope(r) {
    repair.read(r);
    return r.user.permissions.some((p) =>
      [PERM.REPAIR_ASSIGN, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH].includes(p),
    )
      ? { where: [], args: [] }
      : { where: ["engineer_id=?"], args: [r.user.id] };
  }
  function filter(r) {
    const s = scope(r),
      q = r.query || {};
    if (q.status) {
      if (![...REPAIR_FLOW, "cancelled"].includes(q.status))
        fail(400, "维修状态无效");
      s.where.push("status=?");
      s.args.push(q.status);
    }
    if (q.engineerId) {
      s.where.push("engineer_id=?");
      s.args.push(text(q.engineerId, "工程师", 36));
    }
    if (q.keyword) {
      s.where.push(
        "(no LIKE ? OR model LIKE ? OR customer LIKE ? OR identifier=?)",
      );
      const k = "%" + text(q.keyword, "搜索", 100) + "%";
      s.args.push(k, k, k, q.keyword);
    }
    if (q.waitingParts === "true") s.where.push("waiting_parts=TRUE");
    if (q.overdue === "true")
      s.where.push(
        "status NOT IN ('completed','cancelled') AND expected_date<DATE(DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))",
      );
    return s;
  }
  route("GET", "/repair-orders/board", async (r) => {
    const s = filter(r),
      p = page({ ...r.query, pageSize: 200 }),
      clause = s.where.length ? " WHERE " + s.where.join(" AND ") : "",
      [rows] = await pool.query(
        "SELECT * FROM repair_orders" +
          clause +
          " ORDER BY status IN ('completed','cancelled'),created_at DESC,id DESC LIMIT ? OFFSET ?",
        [...s.args, p.pageSize, p.offset],
      ),
      columns = Object.fromEntries(
        [...REPAIR_FLOW, "cancelled"].map((k) => [k, []]),
      );
    for (const row of rows)
      columns[row.status].push(await repair.view(pool, row, r));
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM repair_orders" + clause,
      s.args,
    );
    return {
      columns,
      total: Number(count.n),
      page: p.page,
      pageSize: p.pageSize,
      hasMore: p.offset + rows.length < Number(count.n),
    };
  });
  route("GET", "/repair-orders", async (r) => {
    const s = filter(r),
      p = page(r.query),
      clause = s.where.length ? " WHERE " + s.where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM repair_orders" + clause,
        s.args,
      ),
      [rows] = await pool.query(
        "SELECT * FROM repair_orders" +
          clause +
          " ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
        [...s.args, p.pageSize, p.offset],
      );
    return list(
      await Promise.all(rows.map((row) => repair.view(pool, row, r))),
      count.n,
      p,
    );
  });
  route("GET", "/repair-orders/:id", async (r) =>
    repair.view(pool, await repair.get(pool, r.params.id), r),
  );
  const stats = await require("./repair-stats")(app, {
    ...deps,
    repair,
    scope,
  });
  return { repair, stats };
};
