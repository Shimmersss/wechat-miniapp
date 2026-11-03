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
} = require("./core");
const { cents, money, integer, flags } = require("./validation");
const { stockService, unitSelect, canSee } = require("./stock");
const { isImei } = require("../../miniprogram/utils/validate");
const { validateValues } = require("../../miniprogram/utils/template");
const { UNIT_STATUS } = require("../../miniprogram/constants/status");
module.exports = async function inventory(app, { pool, config, route }) {
  const stock = stockService({ config });
  route("POST", "/inbound/check-imei", async (request) => {
    requirePerm(request, PERM.INBOUND, PERM.ACCEPTANCE);
    const imei = text(request.body?.imei, "IMEI", 15);
    if (!isImei(imei)) fail(400, "IMEI 格式或校验位无效");
    const found = await one(
      pool,
      "SELECT unit_id FROM unit_identifiers WHERE imei=?",
      [imei],
    );
    return {
      unique: !found,
      ...(found?.unit_id ? { conflictUnitId: found.unit_id } : {}),
    };
  });
  route("POST", "/pricing/suggest", async (request) => {
    requirePerm(request, PERM.INBOUND);
    const cost = cents(request.body?.cost, "成本价"),
      profit = cents(request.body?.targetProfit ?? 0, "目标利润");
    const retail = money(BigInt(cost) + BigInt(profit));
    const discount = cents(
      config.pricing?.wholesaleDiscount || 0,
      "批发建议折扣",
    );
    const peer = Math.max(cost, cents(retail) - discount);
    return {
      retail: Number(retail),
      wholesale: Number(money(peer)),
      agentBase: Number(money(peer)),
    };
  });
  route("GET", "/pricing/cost-presets", async (request) => {
    requirePerm(request, PERM.INBOUND);
    if (!canSee(request.user, "cost")) return [];
    const [rows] = await pool.execute(
      "SELECT DISTINCT cost FROM units WHERE model_id=? ORDER BY cost LIMIT 20",
      [request.query.modelId || ""],
    );
    return rows.map((r) => Number(r.cost));
  });
  async function inbound(request, batch) {
    requirePerm(request, PERM.INBOUND);
    requirePerm(request, PERM.ACCEPTANCE);
    const body = request.body || {},
      common = batch ? body.common || {} : body,
      rows = batch ? body.units : [body];
    if (common.inspectionConfirmed !== true)
      fail(400, "独立入库必须确认已完成到货验收");
    if (!Array.isArray(rows) || !rows.length || rows.length > 100)
      fail(400, "每次入库需为 1～100 台");
    return transaction(pool, async (db) => {
      const prepared = [],
        context = { seen: new Set(), files: new Map() };
      for (let i = 0; i < rows.length; i++) {
        if (!rows[i] || typeof rows[i] !== "object")
          fail(400, `第 ${i + 1} 台数据无效`);
        try {
          prepared.push(
            await stock.prepare(
              db,
              {
                ...common,
                ...rows[i],
                attributes: {
                  ...(common.attributes || {}),
                  ...(rows[i].attributes || {}),
                },
              },
              request,
              context,
            ),
          );
        } catch (e) {
          if (e.statusCode) e.message = `第 ${i + 1} 台：${e.message}`;
          throw e;
        }
      }
      for (const unit of prepared) await stock.insert(db, unit, request);
      await audit(
        db,
        request,
        batch ? "批量验收入库" : "单台验收入库",
        prepared[0].id,
        {
          after: { unitIds: prepared.map((u) => u.id), count: prepared.length },
        },
      );
      return batch
        ? { created: prepared.length, ids: prepared.map((u) => u.id) }
        : { id: prepared[0].id };
    });
  }
  route("POST", "/inbound/units", (r) => inbound(r, false));
  route("POST", "/inbound/batch", (r) => inbound(r, true));
  route("GET", "/units", async (request) => {
    requirePerm(request, PERM.INVENTORY_VIEW);
    const p = page(request.query),
      where = [],
      params = [],
      q = request.query;
    if (q.status) {
      if (!UNIT_STATUS[q.status]) fail(400, "库存状态无效");
      where.push("u.status=?");
      params.push(q.status);
    }
    if (q.modelId) {
      where.push("u.model_id=?");
      params.push(q.modelId);
    }
    if (q.keyword) {
      const keyword = text(q.keyword, "搜索内容", 100);
      if (
        /^\d+$/.test(keyword) &&
        keyword.length !== 15 &&
        !canSee(request.user, "fullImei")
      )
        fail(400, "串码查询请扫描完整 IMEI");
      where.push("(m.name LIKE ? OR u.id=? OR u.imei1=? OR u.imei2=?)");
      params.push("%" + keyword + "%", keyword, keyword, keyword);
    }
    if (q.imei) {
      where.push("(u.imei1=? OR u.imei2=?)");
      params.push(q.imei, q.imei);
    }
    if (q.ageingOver !== undefined) {
      where.push("TIMESTAMPDIFF(DAY,u.created_at,UTC_TIMESTAMP(3))>=?");
      params.push(integer(q.ageingOver, "库龄", 0, 36500));
    }
    if (q.minPrice !== undefined) {
      where.push("u.retail>=?");
      params.push(money(cents(q.minPrice, "最低价")));
    }
    if (q.maxPrice !== undefined) {
      where.push("u.retail<=?");
      params.push(money(cents(q.maxPrice, "最高价")));
    }
    if (
      q.minPrice !== undefined &&
      q.maxPrice !== undefined &&
      cents(q.minPrice) > cents(q.maxPrice)
    )
      fail(400, "最低价不能高于最高价");
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM units u JOIN models m ON m.id=u.model_id" +
        clause,
      params,
    );
    const [rows] = await pool.query(
      unitSelect + clause + " ORDER BY u.created_at DESC,u.id LIMIT ? OFFSET ?",
      [...params, p.pageSize, p.offset],
    );
    const [counts] = await pool.execute(
      "SELECT status,COUNT(*) n FROM units GROUP BY status",
    );
    const held = await one(
      pool,
      "SELECT COUNT(*) n,COALESCE(SUM(retail),0) retail,COALESCE(SUM(cost),0) cost FROM units WHERE status='in_stock'",
    );
    return {
      ...list(
        await Promise.all(rows.map((r) => stock.view(pool, r, request))),
        count.n,
        p,
      ),
      counts: Object.fromEntries([
        ["all", counts.reduce((n, r) => n + Number(r.n), 0)],
        ...counts.map((r) => [r.status, Number(r.n)]),
      ]),
      summary: {
        inStock: Number(held.n),
        retailTotal: Number(held.retail),
        ...(canSee(request.user, "cost")
          ? { costTotal: Number(held.cost) }
          : {}),
      },
    };
  });
  route("GET", "/units/:id", async (request) => {
    requirePerm(request, PERM.INVENTORY_VIEW);
    return stock.view(pool, await stock.get(pool, request.params.id), request);
  });
  route("PATCH", "/units/:id/price", async (request) => {
    requirePerm(request, PERM.PRICE_EDIT);
    requirePerm(request, PERM.INVENTORY_VIEW);
    const d = request.body || {},
      reason = text(d.reason, "改价原因", 500),
      keys = ["retail", "wholesale", "agentBase"].filter(
        (k) => d[k] !== undefined,
      );
    if (
      !keys.length ||
      Object.keys(d).some(
        (k) =>
          ![
            "retail",
            "wholesale",
            "agentBase",
            "reason",
            "priceVersion",
          ].includes(k),
      )
    )
      fail(400, "改价参数无效");
    return transaction(pool, async (db) => {
      const row = await stock.get(db, request.params.id, true);
      if (row.status !== "in_stock") fail(409, "当前状态不可改价");
      if (d.priceVersion !== row.price_version) fail(409, "价格已更新，请刷新");
      const before = {},
        after = {},
        columns = {
          retail: "retail",
          wholesale: "wholesale",
          agentBase: "agent_base",
        };
      for (const key of keys) {
        before[key] = Number(row[columns[key]]);
        after[key] = Number(money(cents(d[key], key)));
      }
      await db.execute(
        `UPDATE units SET ${keys.map((k) => columns[k] + "=?").join(",")},price_version=price_version+1 WHERE id=?`,
        [...keys.map((k) => money(cents(d[k], k))), row.id],
      );
      await audit(db, request, "修改库存价格", row.id, {
        before,
        after,
        reason,
      });
      return stock.view(db, await stock.get(db, row.id), request);
    });
  });
  // 批量开关“允许代理转发”（框架文档 十三.7）：整批成功或整批回滚，逐台审计
  route("PATCH", "/units/share-flags", async (request) => {
    requirePerm(request, PERM.SHARE);
    requirePerm(request, PERM.INVENTORY_VIEW);
    const d = request.body || {};
    if (
      Object.keys(d).some((k) => !["unitIds", "shareAgent"].includes(k)) ||
      typeof d.shareAgent !== "boolean" ||
      !Array.isArray(d.unitIds) ||
      !d.unitIds.length ||
      d.unitIds.length > 100 ||
      d.unitIds.some((id) => typeof id !== "string" || !id || id.length > 64)
    )
      fail(400, "请选择 1～100 台设备并指定开关");
    const ids = [...new Set(d.unitIds)].sort();
    return transaction(pool, async (db) => {
      const rows = [];
      for (const id of ids) rows.push(await stock.get(db, id, true));
      if (d.shareAgent && rows.some((r) => r.status !== "in_stock"))
        fail(409, "只有在库可售设备能开启代理转发，请刷新后重选");
      for (const row of rows) {
        const before = json(row.share_flags),
          after = flags({ shareAgent: d.shareAgent }, before);
        await db.execute("UPDATE units SET share_flags=? WHERE id=?", [
          JSON.stringify(after),
          row.id,
        ]);
        await audit(db, request, "批量调整代理转发", row.id, {
          before,
          after,
        });
      }
      return { updated: rows.length, shareAgent: d.shareAgent };
    });
  });
  route("PATCH", "/units/:id/share-flags", async (request) => {
    requirePerm(request, PERM.SHARE);
    requirePerm(request, PERM.INVENTORY_VIEW);
    return transaction(pool, async (db) => {
      const row = await stock.get(db, request.params.id, true),
        before = json(row.share_flags),
        after = flags(request.body, before);
      if (row.status !== "in_stock" && Object.values(after).some(Boolean))
        fail(409, "只有在库可售设备能对外展示或分享");
      await db.execute("UPDATE units SET share_flags=? WHERE id=?", [
        JSON.stringify(after),
        row.id,
      ]);
      await audit(db, request, "调整库存共享范围", row.id, { before, after });
      return after;
    });
  });
  route("GET", "/units/:id/ledger", async (request) => {
    requirePerm(request, PERM.INVENTORY_VIEW);
    await stock.get(pool, request.params.id);
    const p = page(request.query),
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM inventory_ledger WHERE unit_id=?",
        [request.params.id],
      );
    const [rows] = await pool.query(
      `SELECT l.id,l.created_at time,l.from_status AS \`from\`,l.to_status AS \`to\`,l.doc_id doc,l.doc_type docType,l.reason,COALESCE(s.name,u.nickname) operator FROM inventory_ledger l LEFT JOIN users u ON u.id=l.operator_id LEFT JOIN staff s ON s.user_id=u.id WHERE l.unit_id=? ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [request.params.id, p.pageSize, p.offset],
    );
    return list(rows, count.n, p);
  });
  route("GET", "/units/:id/recheck-form", async (request) => {
    requirePerm(request, PERM.ACCEPTANCE);
    requirePerm(request, PERM.INVENTORY_VIEW);
    return transaction(pool, async (db) => {
      await one(db, "SELECT id FROM units WHERE id=? FOR SHARE", [
        request.params.id,
      ]);
      const row = await stock.get(db, request.params.id);
      if (row.status !== "recheck") fail(409, "设备不在待复检状态");
      const snapshot = json(row.template_snapshot),
        view = await stock.view(db, row, request);
      const version = await one(
        db,
        "SELECT COUNT(*) n FROM unit_inspections WHERE unit_id=?",
        [row.id],
      );
      const fields = snapshot.fields.filter(
        (f) =>
          f.key !== "supplier" &&
          canSee(request.user, f.key) &&
          (!f.visibility.includes("internal") ||
            canSee(request.user, "internalNote")),
      );
      const values = Object.fromEntries(
        view.parameters
          .filter((p) => fields.some((f) => f.key === p.key))
          .map((p) => [p.key, p.value]),
      );
      return {
        unitId: row.id,
        name: row.name,
        templateVersion: snapshot.version,
        inspectionVersion: Number(version.n),
        fields,
        values,
        hiddenKeys: fields
          .filter(
            (f) =>
              f.type === "image" &&
              !values[f.key]?.length &&
              json(row.attributes)[f.key]?.length,
          )
          .map((f) => f.key),
      };
    });
  });
  route("POST", "/units/:id/recheck", async (request) => {
    requirePerm(request, PERM.ACCEPTANCE);
    requirePerm(request, PERM.INVENTORY_VIEW);
    const d = request.body || {},
      reason = text(d.reason, "复检说明", 500);
    if (!["pass", "fail"].includes(d.result)) fail(400, "复检结论无效");
    return transaction(pool, async (db) => {
      const row = await stock.get(db, request.params.id, true);
      if (row.status !== "recheck") fail(409, "设备不在待复检状态");
      const version = await one(
        db,
        "SELECT COUNT(*) n FROM unit_inspections WHERE unit_id=?",
        [row.id],
      );
      if (
        integer(d.inspectionVersion, "复检版本", 1, 1000000) !==
        Number(version.n)
      )
        fail(409, "复检记录已更新，请重新加载后核对");
      const snapshot = json(row.template_snapshot),
        attributes = json(row.attributes),
        input = d.attributes || {};
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail(400, "复检参数无效");
      for (const key of Object.keys(input)) {
        const field = snapshot.fields.find((f) => f.key === key);
        if (!field || key === "supplier")
          fail(400, "复检不能修改型号、货源或未定义字段");
        if (
          !canSee(request.user, key) ||
          (field.visibility.includes("internal") &&
            !canSee(request.user, "internalNote"))
        )
          fail(403, "无权修改该复检字段");
        attributes[key] =
          field.type === "image"
            ? await stock.normaliseFiles(
                db,
                input[key],
                field.visibility.includes("internal") ? "internal" : "public",
                request,
                { imagesOnly: true },
              )
            : input[key];
      }
      const error = validateValues(snapshot.fields, attributes);
      if (error) fail(400, error);
      if (d.result === "pass" && attributes.refurbishment === "正在整备")
        fail(400, "整备未完成，不能复检通过");
      const inspectionId = id(),
        next = d.result === "pass" ? "in_stock" : "recheck";
      await db.execute(
        "INSERT INTO unit_inspections (id,unit_id,result,attributes,operator_id,reason) VALUES (?,?,?,?,?,?)",
        [
          inspectionId,
          row.id,
          d.result,
          JSON.stringify(attributes),
          request.user.id,
          reason,
        ],
      );
      for (const field of snapshot.fields.filter(
        (f) => f.type === "image" && Object.hasOwn(input, f.key),
      )) {
        await db.execute(
          "DELETE FROM unit_files WHERE unit_id=? AND field_key=?",
          [row.id, field.key],
        );
        for (let i = 0; i < attributes[field.key].length; i++)
          await db.execute(
            "INSERT INTO unit_files (unit_id,file_id,field_key,position) VALUES (?,?,?,?)",
            [row.id, attributes[field.key][i].fileId, field.key, i],
          );
      }
      await db.execute("UPDATE units SET status=?,attributes=? WHERE id=?", [
        next,
        JSON.stringify(attributes),
        row.id,
      ]);
      await stock.ledger(
        db,
        request,
        row.id,
        row.status,
        next,
        "recheck",
        inspectionId,
        reason,
      );
      await audit(db, request, "库存复检", row.id, {
        before: { status: row.status },
        after: { status: next, result: d.result },
        reason,
      });
      return stock.view(db, await stock.get(db, row.id), request);
    });
  });
  await require("./stocktake")(app, { pool, route, stock });
  route("GET", "/units/:id/label", async (request) => {
    requirePerm(request, PERM.LABEL_PRINT);
    requirePerm(request, PERM.INVENTORY_VIEW);
    const row = await stock.get(pool, request.params.id);
    const view = await stock.view(pool, row, request);
    return {
      unitId: row.id,
      name: view.name,
      storage: view.storage,
      grade: view.grade,
      retail: view.retail,
      qrcodeText: row.id,
      imeiMasked: view.imeiMasked,
    };
  });
};
