const { one, transaction } = require("./db");
const { applySpecs } = require("../../miniprogram/utils/template");
const {
  PERM,
  fail,
  id,
  text,
  json,
  requirePerm,
  audit,
  page,
  list,
} = require("./core");
const { integer, date } = require("./validation");
const { stockService, canSee } = require("./stock");
const { digest } = require("./repair-service");
const { canReadInternal, lockFiles, fileLinks } = require("./repair-files");
const { isPhone, isImei } = require("../../miniprogram/utils/validate");
const closedFlags = JSON.stringify({
  showInShop: false,
  sharePeer: false,
  shareAgent: false,
});
const select =
  "SELECT o.*,s.status,s.version FROM loan_orders o JOIN loan_states s ON s.order_id=o.id";
module.exports = async function (app, { pool, config, route }) {
  const stock = stockService({ config }),
    read = (r) => {
      requirePerm(r, PERM.LOAN_MANAGE);
      if (!r.user.staffNo) fail(403, "仅员工可管理借还");
    };
  function allowed(d, keys) {
    if (!d || Array.isArray(d) || Object.keys(d).some((k) => !keys.includes(k)))
      fail(400, "借还参数无效");
  }
  function noCharges(d) {
    // 框架文档 十三.3 已定：首期不收押金、逾期费与损坏赔偿，非零金额一律拒绝。
    for (const k of ["deposit", "overdueFee", "compensation"])
      if (
        d[k] !== undefined &&
        d[k] !== null &&
        d[k] !== "" &&
        Number(d[k]) !== 0
      )
        fail(400, "首期不收押金、逾期费与损坏赔偿，请勿填写金额");
  }
  async function get(db, target, lock = false) {
    if (lock)
      await one(
        db,
        "SELECT order_id FROM loan_states WHERE order_id=? FOR UPDATE",
        [target],
      );
    const row = await one(db, select + " WHERE o.id=?", [target]);
    if (!row) fail(404, "借还单不存在");
    return row;
  }
  async function files(db, values, r, required = false) {
    if (values === undefined) values = [];
    if (
      !Array.isArray(values) ||
      values.length > 9 ||
      (required && !values.length)
    )
      fail(400, "交接凭证须为1～9张内部图片");
    const result = [],
      ids = values.map((v) => text(v?.fileId, "凭证", 36));
    if (new Set(ids).size !== ids.length) fail(400, "凭证重复");
    // 排他锁 + 锁定读取，防止与入库/维修/收款凭证并发认领同一文件
    const locked = await lockFiles(db, ids);
    for (const target of ids) {
      const f = locked.get(target);
      if (!f || f.scope !== "internal" || !f.mime.startsWith("image/"))
        fail(400, "借还凭证须单独上传为内部图片");
      const links = await fileLinks(db, target);
      if (links.unit || links.repair || links.sales)
        fail(400, "其他业务凭证不能用作借还附件");
      if (
        f.owner_id !== r.user.id &&
        !["boss", "manager"].includes(r.user.role)
      )
        fail(403, "无权引用他人的交接凭证");
      result.push(f);
    }
    return result;
  }
  async function event(
    db,
    r,
    row,
    action,
    key,
    signature,
    reason,
    data,
    photos = [],
  ) {
    const target = id();
    await db.execute(
      "INSERT INTO loan_events(id,order_id,actor_id,action,version,reason,data,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        target,
        row.id,
        r.user.id,
        action,
        row.version,
        reason,
        JSON.stringify(data),
        key,
        signature,
      ],
    );
    for (const f of photos)
      await db.execute(
        "INSERT INTO loan_files(order_id,file_id,event_id) VALUES (?,?,?)",
        [row.id, f.id, target],
      );
    await audit(db, r, "借还:" + action, row.id, {
      reason,
      after: { type: row.type, status: row.status, version: row.version },
    });
  }
  async function view(db, row, r) {
    read(r);
    const [items] = await db.execute(
      "SELECT i.*,s.status,s.returned_at,s.inspection_version,u.status unit_status FROM loan_items i JOIN loan_item_states s ON s.item_id=i.id JOIN units u ON u.id=i.unit_id WHERE i.order_id=? ORDER BY i.unit_id",
      [row.id],
    );
    const [events] = await db.execute(
      "SELECT e.*,u.nickname operator FROM loan_events e JOIN users u ON u.id=e.actor_id WHERE order_id=? ORDER BY e.version,e.id",
      [row.id],
    );
    const [photos] = await db.execute(
      "SELECT f.*,l.event_id FROM loan_files l JOIN files f ON f.id=l.file_id WHERE l.order_id=? ORDER BY l.event_id,l.file_id",
      [row.id],
    );
    const visiblePhotos = [];
    for (const f of photos)
      if (await canReadInternal(db, f, r.user)) visiblePhotos.push(f);
    const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10),
      overdue =
        row.status === "active" &&
        items.some((i) => i.status === "active") &&
        row.due_date < today;
    return {
      id: row.id,
      no: row.no,
      type: row.type,
      counterparty: row.counterparty,
      phone: row.phone,
      dueAt: row.due_date,
      remark: row.remark,
      status: overdue ? "overdue" : row.status,
      storedStatus: row.status,
      version: row.version,
      overdue,
      createdAt: row.created_at,
      items: items.map((i) => {
        const s = json(i.snapshot);
        return {
          id: i.id,
          unitId: i.unit_id,
          name: s.name,
          modelId: s.modelId,
          ownership: row.type === "borrow_in" ? "borrowed" : "own",
          status: i.status,
          unitStatus: i.unit_status,
          returnedAt: i.returned_at,
          imeiMasked: s.imei1.slice(0, 2) + "****" + s.imei1.slice(-4),
          ...(canSee(r.user, "fullImei")
            ? { imei1: s.imei1, imei2: s.imei2 }
            : {}),
          canRecheck:
            i.status === "returned_recheck" &&
            r.user.permissions.includes(PERM.ACCEPTANCE) &&
            r.user.permissions.includes(PERM.INVENTORY_VIEW),
        };
      }),
      timeline: events.map((e) => ({
        id: e.id,
        action: e.action,
        version: e.version,
        reason: e.reason,
        data: json(e.data),
        time: e.created_at,
        operator: e.operator,
      })),
      photos: visiblePhotos.map((f) => ({
        ...stock.fileView(f, r),
        eventId: f.event_id,
      })),
      financialPolicy: config.loan.financialPolicy,
      supportsPayments: false,
    };
  }
  route("GET", "/loans/options", async (r) => {
    read(r);
    return {
      financialPolicy: config.loan.financialPolicy,
      supportsPayments: false,
      borrowedSalesEnabled: false,
      maxItems: 50,
    };
  });
  route("POST", "/loans", async (r) => {
    read(r);
    const d = r.body || {};
    allowed(d, [
      "requestKey",
      "type",
      "unitIds",
      "devices",
      "counterparty",
      "phone",
      "dueAt",
      "remark",
      "reason",
      "photos",
      "deposit",
      "overdueFee",
      "compensation",
    ]);
    noCharges(d);
    const key = text(d.requestKey, "提交标识", 100),
      type = d.type,
      counterparty = text(d.counterparty, "对方", 120),
      phone = text(d.phone, "联系电话", 30),
      due = date(d.dueAt),
      reason = text(d.reason, "交接说明", 500),
      remark = text(d.remark || "", "备注", 2000, true),
      signature = digest({ actor: r.user.id, ...d });
    if (!["loan_out", "borrow_in"].includes(type) || !isPhone(phone))
      fail(400, "请核对借还类型和11位联系电话");
    const input = type === "loan_out" ? d.unitIds : d.devices;
    if (
      !Array.isArray(input) ||
      input.length < 1 ||
      input.length > 50 ||
      (type === "loan_out" && d.devices !== undefined) ||
      (type === "borrow_in" && d.unitIds !== undefined)
    )
      fail(400, "每单须有1～50台且类型与设备匹配");
    const prior = await one(
      pool,
      select + " WHERE o.creator_id=? AND o.request_key=?",
      [r.user.id, key],
    );
    if (prior) {
      if (prior.request_hash !== signature) fail(409, "提交标识内容冲突");
      return view(pool, prior, r);
    }
    try {
      return await transaction(pool, async (db) => {
        const photos = await files(db, d.photos, r),
          target = id(),
          no = "LN" + Date.now() + target.slice(0, 8);
        await db.execute(
          "INSERT INTO loan_orders(id,no,type,counterparty,phone,due_date,remark,creator_id,request_key,request_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            target,
            no,
            type,
            counterparty,
            phone,
            due,
            remark,
            r.user.id,
            key,
            signature,
          ],
        );
        await db.execute("INSERT INTO loan_states(order_id) VALUES (?)", [
          target,
        ]);
        const row = { id: target, no, type, status: "active", version: 1 },
          seen = new Set();
        const sorted =
          type === "loan_out"
            ? input.map((v) => text(v, "设备", 36)).sort()
            : input
                .slice()
                .sort((a, b) =>
                  String(a?.imei1).localeCompare(String(b?.imei1)),
                );
        for (const device of sorted) {
          let u;
          if (type === "loan_out") {
            requirePerm(r, PERM.INVENTORY_VIEW);
            if (seen.has(device)) fail(400, "设备重复");
            seen.add(device);
            u = await stock.get(db, device, true);
            if (u.status !== "in_stock" || u.ownership !== "own")
              fail(409, "仅本店自有可售设备可以出借");
            await db.execute(
              "INSERT INTO loan_active_units(unit_id,order_id) VALUES (?,?)",
              [u.id, target],
            );
            await db.execute(
              "UPDATE units SET status='loaned_out',share_flags=? WHERE id=?",
              [closedFlags, u.id],
            );
            await stock.ledger(
              db,
              r,
              u.id,
              u.status,
              "loaned_out",
              "loan_out",
              target,
              reason,
            );
          } else {
            allowed(device, [
              "modelId",
              "imei1",
              "imei2",
              "condition",
              "description",
            ]);
            const modelId = text(device.modelId, "型号", 60),
              imei1 = text(device.imei1, "IMEI1", 15),
              imei2 = text(device.imei2 || "", "IMEI2", 15, true);
            for (const code of [imei1, imei2].filter(Boolean)) {
              if (!isImei(code) || seen.has(code))
                fail(400, "借入串码无效或重复");
              seen.add(code);
              if (
                await one(
                  db,
                  "SELECT order_id FROM repair_external_slots WHERE identifier=? FOR SHARE",
                  [code],
                )
              )
                fail(409, "设备正在外部维修");
            }
            const m = await one(
              db,
              "SELECT m.*,t.name template_name,t.current_version,v.fields,v.description_presets FROM models m JOIN templates t ON t.id=m.template_id JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE m.id=?",
              [modelId],
            );
            if (!m) fail(400, "型号不存在");
            const condition = device.condition || "used";
            if (!["new", "used"].includes(condition)) fail(400, "设备类型无效");
            const description = text(
                device.description || "",
                "设备交接描述",
                2000,
                true,
              ),
              identifiers = [];
            for (const code of [imei1, imei2].filter(Boolean)) {
              identifiers.push(
                await one(
                  db,
                  "SELECT unit_id,acceptance_item_id FROM unit_identifiers WHERE imei=? FOR UPDATE",
                  [code],
                ),
              );
            }
            if (identifiers.some(Boolean)) {
              const first = identifiers[0];
              if (
                !first?.unit_id ||
                identifiers.some((i) => !i || i.unit_id !== first.unit_id)
              )
                fail(409, "串码已用于其他业务");
              u = await stock.get(db, first.unit_id, true);
              if (
                u.ownership !== "borrowed" ||
                u.status !== "returned" ||
                u.model_id !== modelId ||
                u.imei1 !== imei1 ||
                (u.imei2 || "") !== imei2
              )
                fail(409, "该设备不是已归还的相同借入设备");
              await db.execute(
                "UPDATE units SET status='borrowed_in',share_flags=?,internal_note=? WHERE id=?",
                [closedFlags, description, u.id],
              );
            } else {
              const unitId = id(),
                snapshot = {
                  id: m.template_id,
                  name: m.template_name,
                  version: m.current_version,
                  category: m.category_id,
                  fields: applySpecs(json(m.fields), json(m.specs)),
                  descriptionPresets: json(m.description_presets),
                };
              await db.execute(
                "INSERT INTO units(id,model_id,imei1,imei2,status,ownership,condition_type,attributes,template_snapshot,cost,retail,wholesale,agent_base,share_flags,peer_desc,customer_desc,internal_note,inbound_operator_id) VALUES (?,?,?,?,'borrowed_in','borrowed',?,?,?,0,0,0,0,?,'','',?,?)",
                [
                  unitId,
                  modelId,
                  imei1,
                  imei2 || null,
                  condition,
                  JSON.stringify({}),
                  JSON.stringify(snapshot),
                  closedFlags,
                  description,
                  r.user.id,
                ],
              );
              for (const [slot, code] of [
                ["imei1", imei1],
                ["imei2", imei2],
              ].filter((v) => v[1]))
                await db.execute(
                  "INSERT INTO unit_identifiers(imei,unit_id,slot) VALUES (?,?,?)",
                  [code, unitId, slot],
                );
              u = await stock.get(db, unitId, true);
            }
            await db.execute(
              "INSERT INTO loan_active_units(unit_id,order_id) VALUES (?,?)",
              [u.id, target],
            );
            await stock.ledger(
              db,
              r,
              u.id,
              u.status === "returned" ? "returned" : null,
              "borrowed_in",
              "borrow_in",
              target,
              reason,
            );
          }
          const item = id(),
            snapshot = {
              modelId: u.model_id,
              name: u.name,
              imei1: u.imei1,
              imei2: u.imei2 || "",
            };
          await db.execute(
            "INSERT INTO loan_items(id,order_id,unit_id,snapshot) VALUES (?,?,?,?)",
            [item, target, u.id, JSON.stringify(snapshot)],
          );
          await db.execute("INSERT INTO loan_item_states(item_id) VALUES (?)", [
            item,
          ]);
        }
        await event(
          db,
          r,
          row,
          "create",
          key,
          signature,
          reason,
          { count: input.length, type },
          photos,
        );
        return view(db, await get(db, target), r);
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        const old = await one(
          pool,
          select + " WHERE o.creator_id=? AND o.request_key=?",
          [r.user.id, key],
        );
        if (old && old.request_hash === signature) return view(pool, old, r);
        fail(409, "设备已被其他借还或串码已占用");
      }
      throw error;
    }
  });
  async function mutate(r, action, keys, fn) {
    read(r);
    const d = r.body || {};
    allowed(d, ["requestKey", "version", "reason", ...keys]);
    noCharges(d);
    const key = text(d.requestKey, "操作标识", 100),
      version = integer(d.version, "版本", 1, 2147483647),
      reason = text(d.reason, "处理说明", 500),
      signature = digest({ action, actor: r.user.id, ...d });
    return transaction(pool, async (db) => {
      const row = await get(db, r.params.id, true),
        prior = await one(
          db,
          "SELECT request_hash FROM loan_events WHERE order_id=? AND request_key=?",
          [row.id, key],
        );
      if (prior) {
        if (prior.request_hash !== signature) fail(409, "操作标识内容冲突");
        return view(db, row, r);
      }
      if (row.version !== version || row.status === "closed")
        fail(409, "借还单已更新或已完结");
      const result = await fn(db, row, d),
        [states] = await db.execute(
          "SELECT s.status FROM loan_item_states s JOIN loan_items i ON i.id=s.item_id WHERE i.order_id=?",
          [row.id],
        );
      row.status = states.every((s) => s.status === "closed")
        ? "closed"
        : states.some((s) => s.status === "active")
          ? "active"
          : "returned_recheck";
      row.version++;
      await db.execute(
        "UPDATE loan_states SET status=?,version=?,updated_at=UTC_TIMESTAMP(3) WHERE order_id=?",
        [row.status, row.version, row.id],
      );
      await event(
        db,
        r,
        row,
        action,
        key,
        signature,
        reason,
        result.data,
        result.photos,
      );
      return view(db, row, r);
    });
  }
  route("POST", "/loans/:id/return", (r) =>
    mutate(r, "return", ["items"], async (db, row, d) => {
      if (!Array.isArray(d.items) || !d.items.length || d.items.length > 50)
        fail(400, "请选择逐台归还设备");
      const seen = new Set(),
        photos = [],
        data = [];
      for (const item of d.items
        .slice()
        .sort((a, b) => String(a.unitId).localeCompare(String(b.unitId)))) {
        allowed(item, ["unitId", "condition", "damage", "photos"]);
        const unitId = text(item.unitId, "设备", 36);
        if (seen.has(unitId)) fail(400, "设备重复");
        seen.add(unitId);
        const entry = await one(
          db,
          "SELECT i.id,s.status FROM loan_items i JOIN loan_item_states s ON s.item_id=i.id WHERE i.order_id=? AND i.unit_id=?",
          [row.id, unitId],
        );
        if (!entry || entry.status !== "active")
          fail(409, "设备不在本单待归还列表");
        const condition = text(item.condition, "归还外观和功能结论", 2000),
          damage = text(item.damage || "", "损坏描述", 2000, true),
          proof = await files(db, item.photos, r, true);
        photos.push(...proof);
        const u = await stock.get(db, unitId, true),
          expected = row.type === "loan_out" ? "loaned_out" : "borrowed_in",
          next = row.type === "loan_out" ? "recheck" : "returned";
        if (u.status !== expected) fail(409, "设备状态已变化，不能登记归还");
        const count = await one(
          db,
          "SELECT COUNT(*) n FROM unit_inspections WHERE unit_id=?",
          [unitId],
        );
        await db.execute("UPDATE units SET status=?,share_flags=? WHERE id=?", [
          next,
          closedFlags,
          unitId,
        ]);
        await db.execute(
          "UPDATE loan_item_states SET status=?,returned_at=UTC_TIMESTAMP(3),inspection_version=? WHERE item_id=?",
          [
            row.type === "loan_out" ? "returned_recheck" : "closed",
            Number(count.n),
            entry.id,
          ],
        );
        if (row.type === "borrow_in")
          await db.execute(
            "DELETE FROM loan_active_units WHERE unit_id=? AND order_id=?",
            [unitId, row.id],
          );
        await stock.ledger(
          db,
          r,
          unitId,
          expected,
          next,
          row.type === "loan_out" ? "loan_return" : "borrow_return",
          row.id,
          text(d.reason, "处理说明", 500),
        );
        const returnedLedger = await one(
          db,
          "SELECT MAX(id) id FROM inventory_ledger WHERE unit_id=?",
          [unitId],
        );
        await db.execute(
          "UPDATE loan_item_states SET return_ledger_id=? WHERE item_id=?",
          [returnedLedger.id, entry.id],
        );
        data.push({ unitId, condition, damage, next });
      }
      return {
        data: { items: data },
        photos: [...new Map(photos.map((f) => [f.id, f])).values()],
      };
    }),
  );
  route("POST", "/loans/:id/recheck", (r) =>
    mutate(r, "recheck", ["unitIds"], async (db, row, d) => {
      if (
        row.type !== "loan_out" ||
        !Array.isArray(d.unitIds) ||
        !d.unitIds.length ||
        d.unitIds.length > 50 ||
        new Set(d.unitIds).size !== d.unitIds.length
      )
        fail(400, "请选择已实际通过库存复检的设备");
      const items = [];
      for (const target of d.unitIds.slice().sort()) {
        const unitId = text(target, "设备", 36),
          entry = await one(
            db,
            "SELECT i.id,s.status,s.returned_at,s.inspection_version,s.return_ledger_id FROM loan_items i JOIN loan_item_states s ON s.item_id=i.id WHERE i.order_id=? AND i.unit_id=?",
            [row.id, unitId],
          );
        if (!entry || entry.status !== "returned_recheck")
          fail(409, "设备未处于归还待复检");
        await stock.get(db, unitId, true);
        const passed = await one(
          db,
          "SELECT l.id FROM inventory_ledger l JOIN unit_inspections i ON i.id=l.doc_id WHERE l.unit_id=? AND l.id>? AND l.doc_type='recheck' AND l.to_status='in_stock' AND i.result='pass' LIMIT 1",
          [unitId, entry.return_ledger_id || 0],
        );
        if (!entry.return_ledger_id || !passed)
          fail(409, "须先在库存复检页逐项检查并实际通过，不能一键恢复可售");
        await db.execute(
          "UPDATE loan_item_states SET status='closed' WHERE item_id=?",
          [entry.id],
        );
        await db.execute(
          "DELETE FROM loan_active_units WHERE unit_id=? AND order_id=?",
          [unitId, row.id],
        );
        items.push(unitId);
      }
      return { data: { unitIds: items }, photos: [] };
    }),
  );
  route("GET", "/loans", async (r) => {
    read(r);
    const q = r.query || {},
      p = page(q),
      where = [],
      args = [];
    if (q.type) {
      if (!["loan_out", "borrow_in"].includes(q.type))
        fail(400, "借还类型无效");
      where.push("o.type=?");
      args.push(q.type);
    }
    if (q.status) {
      if (
        !["active", "overdue", "returned_recheck", "closed"].includes(q.status)
      )
        fail(400, "借还状态无效");
      if (q.status === "overdue")
        where.push(
          "s.status='active' AND o.due_date<DATE(DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 8 HOUR))",
        );
      // 待复检按“任一设备已归还待复检”筛选，部分归还的进行中单据也会列出
      else if (q.status === "returned_recheck")
        where.push(
          "EXISTS(SELECT 1 FROM loan_items li JOIN loan_item_states ls ON ls.item_id=li.id WHERE li.order_id=o.id AND ls.status='returned_recheck')",
        );
      else {
        where.push("s.status=?");
        args.push(q.status);
      }
    }
    if (q.keyword) {
      const k = "%" + text(q.keyword, "搜索", 100) + "%";
      where.push(
        "(o.no LIKE ? OR o.counterparty LIKE ? OR EXISTS(SELECT 1 FROM loan_items li JOIN units u ON u.id=li.unit_id WHERE li.order_id=o.id AND (u.imei1=? OR u.imei2=?)))",
      );
      args.push(k, k, q.keyword, q.keyword);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM loan_orders o JOIN loan_states s ON s.order_id=o.id" +
          clause,
        args,
      ),
      [rows] = await pool.query(
        select + clause + " ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?",
        [...args, p.pageSize, p.offset],
      );
    return list(
      await Promise.all(rows.map((row) => view(pool, row, r))),
      count.n,
      p,
    );
  });
  route("GET", "/loans/:id", async (r) => {
    read(r);
    return view(pool, await get(pool, r.params.id), r);
  });
  return { view };
};
