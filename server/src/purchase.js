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
const { cents, money, integer, date } = require("./validation");
const { stockService, canSee } = require("./stock");
const { isImei } = require("../../miniprogram/utils/validate");
const {
  PURCHASE_STATUS,
  CARRIERS,
} = require("../../miniprogram/constants/status");
module.exports = async function purchase(app, { pool, config, route }) {
  const stock = stockService({ config }),
    read = (r) => requirePerm(r, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE),
    manage = (r) => requirePerm(r, PERM.PURCHASE_MANAGE);
  async function order(db, orderId, lock = false) {
    const row = await one(
      db,
      "SELECT * FROM purchase_orders WHERE id=?" + (lock ? " FOR UPDATE" : ""),
      [orderId],
    );
    if (!row) fail(404, "采购单不存在");
    return row;
  }
  async function lineViews(db, orderId, request) {
    const [rows] = await db.execute(
      "SELECT l.*,m.name,m.template_id FROM purchase_lines l JOIN models m ON m.id=l.model_id WHERE l.purchase_id=? ORDER BY l.id",
      [orderId],
    );
    return rows.map((r) => ({
      id: r.id,
      modelId: r.model_id,
      modelName: r.name,
      templateId: r.template_id,
      attributes: json(r.expected_attributes),
      quantity: r.quantity,
      received: r.received_count,
      accepted: r.accepted_count,
      rejected: r.rejected_count,
      remaining: r.quantity - r.received_count,
      ...(canSee(request.user, "cost")
        ? { unitCost: Number(r.unit_cost) }
        : {}),
    }));
  }
  async function exceptionViews(db, orderId, request) {
    const [rows] = await db.execute(
      `SELECT a.*,m.name FROM acceptance_items a JOIN acceptance_batches b ON b.id=a.batch_id JOIN models m ON m.id=a.model_id WHERE b.purchase_id=? AND a.result='fail' ORDER BY a.created_at,a.id`,
      [orderId],
    );
    return rows.map((r) => ({
      id: r.id,
      lineId: r.purchase_line_id,
      modelId: r.model_id,
      modelName: r.name,
      imeiMasked: `${r.imei1.slice(0, 2)}****${r.imei1.slice(-4)}`,
      ...(canSee(request.user, "fullImei")
        ? { imei1: r.imei1, imei2: r.imei2 }
        : {}),
      reason: r.reason,
      resolution: r.resolution,
      observedModel: json(r.attributes)._observedModel || "",
    }));
  }
  async function view(db, row, request, detail = false) {
    const supplier = await one(db, "SELECT name FROM suppliers WHERE id=?", [
        row.supplier_id,
      ]),
      owner = await one(
        db,
        "SELECT COALESCE(s.name,u.nickname) name FROM users u LEFT JOIN staff s ON s.user_id=u.id WHERE u.id=?",
        [row.owner_id],
      );
    const [shipments] = await db.execute(
      "SELECT * FROM shipments WHERE purchase_id=? ORDER BY shipped_at,id",
      [row.id],
    );
    const result = {
      id: row.id,
      no: row.no,
      status: row.status,
      qty: row.quantity,
      owner: owner?.name || "",
      expectedAt: row.expected_at,
      createdAt: row.created_at,
      shipments: shipments.map((s) => ({
        id: s.id,
        carrier: s.carrier,
        trackingNo: s.tracking_no,
        status: s.status,
        shippedAt: s.shipped_at,
        signedAt: s.signed_at,
      })),
      tracks: [],
      remark: row.remark,
    };
    result.shipment = result.shipments[0] || null;
    if (canSee(request.user, "supplier")) {
      result.supplier = supplier?.name || "";
      result.supplierId = row.supplier_id;
    }
    if (canSee(request.user, "cost")) {
      result.amount = Number(row.amount);
      result.freight = Number(row.freight);
    }
    if (detail) {
      result.lines = await lineViews(db, row.id, request);
      result.exceptions = await exceptionViews(db, row.id, request);
    }
    return result;
  }
  async function refreshStatus(db, orderId) {
    const counts = await one(
      db,
      "SELECT COALESCE(SUM(quantity),0) qty,COALESCE(SUM(received_count),0) received FROM purchase_lines WHERE purchase_id=?",
      [orderId],
    );
    const unresolved = await one(
      db,
      `SELECT COUNT(*) n FROM acceptance_items a JOIN acceptance_batches b ON b.id=a.batch_id WHERE b.purchase_id=? AND a.result='fail' AND a.resolution IN ('none','dispute')`,
      [orderId],
    );
    const shipments = await one(
      db,
      "SELECT COUNT(*) n,SUM(status='signed') signed FROM shipments WHERE purchase_id=?",
      [orderId],
    );
    let status =
      Number(unresolved.n) > 0
        ? "exception"
        : Number(counts.received) === Number(counts.qty) &&
            Number(shipments.signed) === Number(shipments.n)
          ? "completed"
          : Number(counts.received) > 0
            ? "accepting"
            : Number(shipments.signed) > 0
              ? "arrived"
              : Number(shipments.n) > 0
                ? "in_transit"
                : "pending_ship";
    await db.execute("UPDATE purchase_orders SET status=? WHERE id=?", [
      status,
      orderId,
    ]);
    return status;
  }
  function supplierPayload(d) {
    return {
      name: text(d.name, "供应商名称", 100),
      contact: text(d.contact, "联系人", 100, true),
      phone: text(d.phone, "联系电话", 30, true),
      settle: text(d.settle, "结算方式", 100, true),
      note: text(d.note, "备注", 1000, true),
      active: d.active === undefined ? true : d.active,
    };
  }
  route("GET", "/suppliers", async (request) => {
    requirePerm(request, PERM.SUPPLIER_VIEW);
    const p = page(request.query),
      where = [],
      args = [];
    if (request.query.keyword) {
      where.push("name LIKE ?");
      args.push("%" + text(request.query.keyword, "搜索内容", 100) + "%");
    }
    if (request.query.active !== undefined) {
      if (!["true", "false"].includes(String(request.query.active)))
        fail(400, "供应商状态无效");
      where.push("active=?");
      args.push(String(request.query.active) === "true");
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM suppliers" + clause,
        args,
      );
    const [rows] = await pool.query(
      "SELECT id,name,contact,phone,settle,note,active FROM suppliers" +
        clause +
        " ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      [...args, p.pageSize, p.offset],
    );
    return list(
      rows.map((row) => ({ ...row, active: Boolean(row.active) })),
      count.n,
      p,
    );
  });
  async function saveSupplier(request, supplierId) {
    manage(request);
    requirePerm(request, PERM.SUPPLIER_VIEW);
    const d = supplierPayload(request.body || {});
    if (typeof d.active !== "boolean") fail(400, "供应商状态无效");
    return transaction(pool, async (db) => {
      const old = supplierId
        ? await one(db, "SELECT * FROM suppliers WHERE id=? FOR UPDATE", [
            supplierId,
          ])
        : null;
      if (supplierId && !old) fail(404, "供应商不存在");
      const target = supplierId || id();
      if (old)
        await db.execute(
          "UPDATE suppliers SET name=?,contact=?,phone=?,settle=?,note=?,active=? WHERE id=?",
          [d.name, d.contact, d.phone, d.settle, d.note, d.active, target],
        );
      else
        await db.execute(
          "INSERT INTO suppliers (id,name,contact,phone,settle,note,active) VALUES (?,?,?,?,?,?,?)",
          [target, d.name, d.contact, d.phone, d.settle, d.note, d.active],
        );
      await audit(db, request, old ? "修改供应商" : "新增供应商", target, {
        before: old ? { name: old.name, active: Boolean(old.active) } : null,
        after: { name: d.name, active: d.active },
      });
      return { id: target, ...d };
    });
  }
  route("POST", "/suppliers", (r) => saveSupplier(r));
  route("PUT", "/suppliers/:id", (r) => saveSupplier(r, r.params.id));
  async function saveOrder(request, orderId) {
    manage(request);
    requirePerm(request, PERM.SUPPLIER_VIEW);
    const d = request.body || {},
      supplierId = text(d.supplierId, "供应商", 36),
      expectedAt = date(d.expectedAt, "预计到货日期"),
      freight = cents(d.freight || 0, "运费"),
      remark = text(d.remark, "采购备注", 1000, true);
    if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 100)
      fail(400, "采购单需包含 1～100 行明细");
    return transaction(pool, async (db) => {
      const existing = orderId ? await order(db, orderId, true) : null;
      if (existing && existing.status !== "pending_ship")
        fail(409, "已发货或开始验收的采购单不能修改明细");
      if (
        !(await one(db, "SELECT id FROM suppliers WHERE id=? AND active=TRUE", [
          supplierId,
        ]))
      )
        fail(400, "供应商不存在或已停用");
      let qty = 0,
        total = BigInt(freight);
      const lines = [];
      for (const row of d.lines) {
        const modelId = text(row.modelId, "明细型号", 60),
          quantity = integer(row.quantity, "采购数量", 1, 1000),
          unitCost = cents(row.unitCost, "采购单价");
        if (!(await one(db, "SELECT id FROM models WHERE id=?", [modelId])))
          fail(400, "明细型号不存在");
        const attributes = {};
        if (
          row.attributes !== undefined &&
          (typeof row.attributes !== "object" ||
            Array.isArray(row.attributes) ||
            row.attributes === null)
        )
          fail(400, "采购规格无效");
        for (const key of ["storage", "color", "version"])
          if (row.attributes?.[key])
            attributes[key] = text(row.attributes[key], "采购规格", 100);
        qty += quantity;
        total += BigInt(quantity) * BigInt(unitCost);
        lines.push({
          id: id(),
          modelId,
          quantity,
          unitCost: money(unitCost),
          attributes,
        });
      }
      if (qty > 10000) fail(400, "单张采购单最多 10000 台");
      const amount = money(total),
        target = orderId || id(),
        no =
          existing?.no ||
          "PO" +
            new Date().toISOString().slice(0, 10).replaceAll("-", "") +
            "-" +
            target.replaceAll("-", "").slice(0, 16);
      if (existing) {
        await db.execute(
          "UPDATE purchase_orders SET supplier_id=?,expected_at=?,freight=?,amount=?,quantity=?,remark=? WHERE id=?",
          [supplierId, expectedAt, money(freight), amount, qty, remark, target],
        );
        await db.execute("DELETE FROM purchase_lines WHERE purchase_id=?", [
          target,
        ]);
      } else
        await db.execute(
          "INSERT INTO purchase_orders (id,no,supplier_id,expected_at,freight,amount,quantity,owner_id,remark) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            target,
            no,
            supplierId,
            expectedAt,
            money(freight),
            amount,
            qty,
            request.user.id,
            remark,
          ],
        );
      for (const line of lines)
        await db.execute(
          "INSERT INTO purchase_lines (id,purchase_id,model_id,expected_attributes,quantity,unit_cost) VALUES (?,?,?,?,?,?)",
          [
            line.id,
            target,
            line.modelId,
            JSON.stringify(line.attributes),
            line.quantity,
            line.unitCost,
          ],
        );
      await audit(db, request, existing ? "修改采购单" : "创建采购单", target, {
        after: { no, qty, supplierId },
      });
      return view(db, await order(db, target), request, true);
    });
  }
  route("GET", "/purchase-orders", async (request) => {
    read(request);
    const p = page(request.query),
      where = [],
      params = [];
    if (request.query.status) {
      if (!PURCHASE_STATUS[request.query.status]) fail(400, "采购状态无效");
      where.push("p.status=?");
      params.push(request.query.status);
    }
    if (request.query.supplierId) {
      requirePerm(request, PERM.SUPPLIER_VIEW);
      if (!canSee(request.user, "supplier")) fail(403, "无权限筛选供应商");
      where.push("p.supplier_id=?");
      params.push(text(request.query.supplierId, "供应商", 36));
    }
    if (request.query.keyword) {
      const keyword = "%" + text(request.query.keyword, "搜索内容", 100) + "%";
      where.push(
        "(p.no LIKE ? OR EXISTS (SELECT 1 FROM shipments s WHERE s.purchase_id=p.id AND s.tracking_no LIKE ?))",
      );
      params.push(keyword, keyword);
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "",
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM purchase_orders p" + clause,
        params,
      );
    const [rows] = await pool.query(
      "SELECT p.* FROM purchase_orders p" +
        clause +
        " ORDER BY p.created_at DESC,p.id LIMIT ? OFFSET ?",
      [...params, p.pageSize, p.offset],
    );
    const summary = await one(
      pool,
      "SELECT COUNT(*) orders,COALESCE(SUM(p.quantity),0) totalQty,COALESCE(SUM(p.quantity-COALESCE(l.received,0)),0) remainingQty,COALESCE(SUM(CASE WHEN p.status='in_transit' THEN p.quantity-COALESCE(l.received,0) ELSE 0 END),0) inTransitQty FROM purchase_orders p LEFT JOIN (SELECT purchase_id,SUM(received_count) received FROM purchase_lines GROUP BY purchase_id) l ON l.purchase_id=p.id" +
        clause,
      params,
    );
    return {
      ...list(
        await Promise.all(rows.map((r) => view(pool, r, request))),
        count.n,
        p,
      ),
      summary: Object.fromEntries(
        Object.entries(summary).map(([key, value]) => [key, Number(value)]),
      ),
    };
  });
  route("POST", "/purchase-orders", (r) => saveOrder(r));
  route("PUT", "/purchase-orders/:id", (r) => saveOrder(r, r.params.id));
  route("GET", "/purchase-orders/:id", async (r) => {
    read(r);
    return view(pool, await order(pool, r.params.id), r, true);
  });
  route("POST", "/purchase-orders/:id/shipments", async (request) => {
    manage(request);
    const d = request.body || {},
      carrier = text(d.carrier, "承运商", 10),
      trackingNo = text(d.trackingNo, "运单号", 40);
    if (
      !CARRIERS.some((c) => c.value === carrier) ||
      !/^[A-Za-z0-9]{8,40}$/.test(trackingNo)
    )
      fail(400, "承运商或运单号无效");
    return transaction(pool, async (db) => {
      const po = await order(db, request.params.id, true);
      if (
        ![
          "pending_ship",
          "in_transit",
          "arrived",
          "accepting",
          "exception",
        ].includes(po.status)
      )
        fail(409, "采购单已完成，不能追加运单");
      const shipmentId = id();
      await db.execute(
        "INSERT INTO shipments (id,purchase_id,carrier,tracking_no) VALUES (?,?,?,?)",
        [shipmentId, po.id, carrier, trackingNo],
      );
      await refreshStatus(db, po.id);
      await audit(db, request, "绑定采购运单", po.id, {
        after: { shipmentId, carrier, trackingNo },
      });
      return { id: shipmentId };
    });
  });
  route("POST", "/shipments/:id/receive", async (request) => {
    read(request);
    const reason = text(request.body?.reason, "人工签收说明", 500);
    return transaction(pool, async (db) => {
      const shipment = await one(db, "SELECT * FROM shipments WHERE id=?", [
        request.params.id,
      ]);
      if (!shipment) fail(404, "运单不存在");
      await order(db, shipment.purchase_id, true);
      const current = await one(
        db,
        "SELECT * FROM shipments WHERE id=? FOR UPDATE",
        [shipment.id],
      );
      if (current.status === "signed") return { received: true };
      if (request.body.receiptFileId)
        await stock.normaliseFiles(
          db,
          [{ fileId: request.body.receiptFileId }],
          "internal",
          request,
          { imagesOnly: true },
        );
      await db.execute(
        "UPDATE shipments SET status='signed',signed_at=UTC_TIMESTAMP(3),receipt_file_id=? WHERE id=?",
        [request.body.receiptFileId || null, shipment.id],
      );
      const status = await refreshStatus(db, shipment.purchase_id);
      await audit(db, request, "采购运单人工签收", shipment.id, {
        after: { status: "signed" },
        reason,
      });
      return { received: true, purchaseStatus: status };
    });
  });
  route("GET", "/shipments/:id/tracks", async (request) => {
    read(request);
    if (
      !(await one(pool, "SELECT id FROM shipments WHERE id=?", [
        request.params.id,
      ]))
    )
      fail(404, "运单不存在");
    // 框架文档 十三.4 已定：首期只手动录入承运商和运单号，不接自动轨迹查询（前端已无入口）。
    fail(503, "首期不提供快递轨迹查询，请在实际收货后登记签收");
  });
  route("GET", "/purchase-orders/:id/acceptance", async (request) => {
    requirePerm(request, PERM.ACCEPTANCE);
    const po = await order(pool, request.params.id);
    const detail = await view(pool, po, request, true);
    return {
      poId: po.id,
      no: po.no,
      status: po.status,
      lines: detail.lines,
      exceptions: detail.exceptions,
      items: [],
      expectedTotal: po.quantity,
      remaining: detail.lines.reduce((n, l) => n + l.remaining, 0),
      canAccept: ["arrived", "accepting", "exception"].includes(po.status),
    };
  });
  // Acceptance and exception resolution are registered below.
  const dependencies = {
    pool,
    config,
    route,
    stock,
    order,
    view,
    refreshStatus,
  };
  await require("./acceptance")(app, dependencies);
};
