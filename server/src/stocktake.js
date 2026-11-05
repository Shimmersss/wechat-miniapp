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
const {
  UNIT_STATUS,
  STOCKTAKE_SCOPE,
  STOCKTAKE_DEFAULT_SCOPE,
  STOCKTAKE_RESOLUTION,
} = require("../../miniprogram/constants/status");
const { unitSelect, canSee } = require("./stock");
/**
 * 盘点单：开单时按范围快照应盘清单，边扫边勾，扫码记录存服务端，可中途退出、多人同盘。
 * 结束时向只追加的 stocktakes 写入最终结果；差异处理也只追加记录，不改库存状态。
 */
module.exports = async function stocktake(app, { pool, route, stock }) {
  function authorize(request) {
    requirePerm(request, PERM.STOCKTAKE);
    requirePerm(request, PERM.INVENTORY_VIEW);
  }
  const masked = (request, code) =>
    !canSee(request.user, "fullImei") && /^\d{15}$/.test(code)
      ? code.slice(0, 2) + "****" + code.slice(-4)
      : code;
  const operatorJoin = (alias, column) =>
    ` LEFT JOIN users ${alias}u ON ${alias}u.id=${column} LEFT JOIN staff ${alias}s ON ${alias}s.user_id=${alias}u.id`;
  const operatorName = (alias) => `COALESCE(${alias}s.name,${alias}u.nickname)`;

  // ---------- 盘点结果（只追加） ----------
  async function record(db, stocktakeId) {
    const row = await one(
      db,
      "SELECT t.*," +
        operatorName("o") +
        " operator FROM stocktakes t" +
        operatorJoin("o", "t.operator_id") +
        " WHERE t.id=?",
      [stocktakeId],
    );
    if (!row) fail(404, "盘点记录不存在");
    return row;
  }
  /** 每项差异取最新一条处理记录 */
  async function resolutionsOf(db, ids) {
    const map = new Map(ids.map((i) => [i, new Map()]));
    if (!ids.length) return map;
    const [rows] = await db.query(
      "SELECT r.*," +
        operatorName("o") +
        " operator FROM stocktake_resolutions r" +
        operatorJoin("o", "r.operator_id") +
        " WHERE r.stocktake_id IN (?) ORDER BY r.created_at,r.id",
      [ids],
    );
    for (const r of rows)
      map.get(r.stocktake_id).set(r.target_type + ":" + r.target, {
        resolution: r.resolution,
        label: STOCKTAKE_RESOLUTION[r.resolution].label,
        note: r.note,
        operator: r.operator || "",
        time: r.created_at,
      });
    return map;
  }
  const settled = (r) => r && r.resolution !== "pending";
  function summary(row, resolutions) {
    const r = json(row.result),
      scope = json(row.scope),
      open =
        r.missingIds.filter((u) => !settled(resolutions.get("unit:" + u)))
          .length +
        r.extra.filter((e, i) => !settled(resolutions.get("extra:" + i)))
          .length;
    return {
      id: row.id,
      time: row.created_at,
      operator: row.operator || "",
      scope,
      sessionId: row.session_id || null,
      expectedCount: r.expectedCount,
      scannedCount: r.scannedCount,
      matched: r.matched,
      missingCount: r.missingIds.length,
      extraCount: r.extra.length,
      changedCount: (r.changed || []).length,
      openCount: open,
    };
  }
  async function detail(db, row, request) {
    const r = json(row.result),
      resolutions = (await resolutionsOf(db, [row.id])).get(row.id),
      missing = [],
      changed = [];
    for (const unitId of r.missingIds)
      missing.push({
        ...(await stock.view(db, await stock.get(db, unitId), request)),
        resolution: resolutions.get("unit:" + unitId) || null,
      });
    for (const c of r.changed || []) {
      const unit = await stock.view(db, await stock.get(db, c.unitId), request);
      changed.push({
        id: unit.id,
        name: unit.name,
        imeiMasked: unit.imeiMasked,
        from: c.from,
        to: c.to,
      });
    }
    return {
      ...summary(row, resolutions),
      missingIds: r.missingIds,
      matchedIds: r.matchedIds || [],
      missing,
      changed,
      extra: r.extra.map((e, i) => ({
        key: String(i),
        code: masked(request, e.code),
        unitId: e.unitId || null,
        reason: e.reason,
        resolution: resolutions.get("extra:" + i) || null,
      })),
    };
  }
  route("GET", "/stocktakes", async (request) => {
    authorize(request);
    const p = page(request.query),
      count = await one(pool, "SELECT COUNT(*) n FROM stocktakes");
    const [rows] = await pool.query(
      "SELECT t.*," +
        operatorName("o") +
        " operator FROM stocktakes t" +
        operatorJoin("o", "t.operator_id") +
        " ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?",
      [p.pageSize, p.offset],
    );
    const resolutions = await resolutionsOf(
      pool,
      rows.map((r) => r.id),
    );
    return list(
      rows.map((r) => summary(r, resolutions.get(r.id))),
      count.n,
      p,
    );
  });
  route("GET", "/stocktakes/:id", async (request) => {
    authorize(request);
    return detail(pool, await record(pool, request.params.id), request);
  });
  route("POST", "/stocktakes/:id/resolutions", async (request) => {
    authorize(request);
    const d = request.body || {};
    if (!["unit", "extra"].includes(d.type)) fail(400, "差异类型无效");
    const target = text(d.target, "差异项", 80);
    if (
      !(
        d.type === "unit"
          ? ["pending", "found", "lost"]
          : ["pending", "handled"]
      ).includes(d.resolution)
    )
      fail(400, "处理结果无效");
    const note = text(d.note, "处理说明", 200);
    return transaction(pool, async (db) => {
      const row = await record(db, request.params.id),
        r = json(row.result);
      if (d.type === "unit" && !r.missingIds.includes(target))
        fail(400, "该设备不是本次盘点的缺失设备");
      if (
        d.type === "extra" &&
        !(/^\d+$/.test(target) && r.extra[Number(target)])
      )
        fail(400, "盘点异常项不存在");
      await db.execute(
        "INSERT INTO stocktake_resolutions (id,stocktake_id,target_type,target,resolution,note,operator_id) VALUES (?,?,?,?,?,?,?)",
        [id(), row.id, d.type, target, d.resolution, note, request.user.id],
      );
      await audit(db, request, "处理盘点差异", row.id, {
        after: { type: d.type, target, resolution: d.resolution },
        reason: note,
      });
      return detail(db, row, request);
    });
  });

  // ---------- 进行中的盘点单 ----------
  const sessionSql =
    "SELECT x.*," +
    operatorName("o") +
    " operator FROM stocktake_sessions x" +
    operatorJoin("o", "x.operator_id");
  async function counts(db, sessionId) {
    const units = await one(
        db,
        "SELECT COUNT(*) expected,COUNT(scanned_at) scanned FROM stocktake_session_units WHERE session_id=?",
        [sessionId],
      ),
      extras = await one(
        db,
        "SELECT COUNT(*) n FROM stocktake_extras WHERE session_id=?",
        [sessionId],
      );
    return {
      expectedCount: Number(units.expected),
      scannedCount: Number(units.scanned),
      extraCount: Number(extras.n),
    };
  }
  function sessionSummary(row) {
    return {
      id: row.id,
      status: row.status,
      scope: json(row.scope),
      note: row.note,
      operator: row.operator || "",
      createdAt: row.created_at,
      closedAt: row.closed_at,
      stocktakeId: row.stocktake_id,
      cancelReason: row.cancel_reason || "",
    };
  }
  async function sessionView(db, sessionId) {
    const row = await one(db, sessionSql + " WHERE x.id=?", [sessionId]);
    if (!row) fail(404, "盘点单不存在");
    return { ...sessionSummary(row), ...(await counts(db, row.id)) };
  }
  async function lockOpen(db, sessionId) {
    const row = await one(
      db,
      "SELECT * FROM stocktake_sessions WHERE id=? FOR UPDATE",
      [sessionId],
    );
    if (!row) fail(404, "盘点单不存在");
    return row;
  }
  route("GET", "/stocktake-sessions", async (request) => {
    authorize(request);
    const status = request.query.status || "open";
    if (!["open", "closed", "cancelled"].includes(status))
      fail(400, "盘点单状态无效");
    const p = page(request.query),
      count = await one(
        pool,
        "SELECT COUNT(*) n FROM stocktake_sessions WHERE status=?",
        [status],
      );
    const [rows] = await pool.query(
      sessionSql +
        " WHERE x.status=? ORDER BY x.created_at DESC,x.id LIMIT ? OFFSET ?",
      [status, p.pageSize, p.offset],
    );
    const result = [];
    for (const row of rows)
      result.push({ ...sessionSummary(row), ...(await counts(pool, row.id)) });
    return list(result, count.n, p);
  });
  route("GET", "/stocktake-sessions/:id", async (request) => {
    authorize(request);
    return sessionView(pool, request.params.id);
  });
  route("POST", "/stocktake-sessions", async (request) => {
    authorize(request);
    const input = request.body || {},
      selected =
        input.statuses === undefined ? STOCKTAKE_DEFAULT_SCOPE : input.statuses;
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some((s) => !STOCKTAKE_SCOPE.includes(s))
    )
      fail(400, "盘点范围只能选择在店内的库存状态");
    const statuses = [...new Set(selected)].sort(),
      modelId = input.modelId ? text(input.modelId, "型号", 60) : null,
      category = input.category ? text(input.category, "分类", 60) : null,
      note = text(input.note, "盘点说明", 200, true),
      key = text(input.requestKey, "提交标识", 80);
    if (modelId && category) fail(400, "型号和分类只能选一种范围");
    const digest = hash(JSON.stringify({ statuses, modelId, category, note }));
    async function replay(db) {
      const previous = await one(
        db,
        "SELECT id,request_hash FROM stocktake_sessions WHERE request_key=?",
        [key],
      );
      if (!previous) return null;
      if (previous.request_hash !== digest)
        fail(409, "提交标识已用于其他内容，请保留原内容重试");
      return sessionView(db, previous.id);
    }
    try {
      return await transaction(pool, async (db) => {
        const previous = await replay(db);
        if (previous) return previous;
        let modelName = "",
          categoryLabel = "";
        if (modelId) {
          const m = await one(db, "SELECT name FROM models WHERE id=?", [
            modelId,
          ]);
          if (!m) fail(400, "盘点型号不存在");
          modelName = m.name;
        }
        if (category) {
          const c = await one(db, "SELECT label FROM categories WHERE id=?", [
            category,
          ]);
          if (!c) fail(400, "盘点分类不存在");
          categoryLabel = c.label;
        }
        const sessionId = id();
        await db.execute(
          "INSERT INTO stocktake_sessions (id,operator_id,scope,note,request_key,request_hash) VALUES (?,?,?,?,?,?)",
          [
            sessionId,
            request.user.id,
            JSON.stringify({
              statuses,
              modelId,
              modelName,
              category,
              categoryLabel,
            }),
            note,
            key,
            digest,
          ],
        );
        const params = [sessionId, ...statuses];
        let where = "u.status IN (" + statuses.map(() => "?").join(",") + ")";
        if (modelId) {
          where += " AND u.model_id=?";
          params.push(modelId);
        }
        if (category) {
          where += " AND m.category_id=?";
          params.push(category);
        }
        const [inserted] = await db.execute(
          "INSERT INTO stocktake_session_units (session_id,unit_id,start_status) SELECT ?,u.id,u.status FROM units u JOIN models m ON m.id=u.model_id WHERE " +
            where,
          params,
        );
        await audit(db, request, "开始盘点", sessionId, {
          after: {
            statuses,
            modelId,
            category,
            expectedCount: inserted.affectedRows,
          },
        });
        return sessionView(db, sessionId);
      });
    } catch (error) {
      // 同一提交标识并发到达时由唯一键决定，输家读取赢家的结果
      if (error.code === "ER_DUP_ENTRY") {
        const previous = await replay(pool);
        if (previous) return previous;
      }
      throw error;
    }
  });
  route("GET", "/stocktake-sessions/:id/units", async (request) => {
    authorize(request);
    const state = request.query.state || "pending",
      p = page(request.query),
      sessionId = request.params.id;
    if (
      !(await one(pool, "SELECT id FROM stocktake_sessions WHERE id=?", [
        sessionId,
      ]))
    )
      fail(404, "盘点单不存在");
    if (state === "extra") {
      const count = await one(
        pool,
        "SELECT COUNT(*) n FROM stocktake_extras WHERE session_id=?",
        [sessionId],
      );
      const [rows] = await pool.query(
        "SELECT e.*,m.name unit_name," +
          operatorName("o") +
          " scanner FROM stocktake_extras e LEFT JOIN units u ON u.id=e.unit_id LEFT JOIN models m ON m.id=u.model_id" +
          operatorJoin("o", "e.scanned_by") +
          " WHERE e.session_id=? ORDER BY e.scanned_at DESC,e.id LIMIT ? OFFSET ?",
        [sessionId, p.pageSize, p.offset],
      );
      return list(
        rows.map((e) => ({
          id: e.id,
          code: masked(request, e.code),
          unitId: e.unit_id,
          name: e.unit_name || "",
          reason: e.reason,
          scannedAt: e.scanned_at,
          scanner: e.scanner || "",
        })),
        count.n,
        p,
      );
    }
    if (!["pending", "scanned"].includes(state)) fail(400, "清单类型无效");
    const condition =
      state === "pending"
        ? "su.scanned_at IS NULL"
        : "su.scanned_at IS NOT NULL";
    const count = await one(
      pool,
      "SELECT COUNT(*) n FROM stocktake_session_units su WHERE su.session_id=? AND " +
        condition,
      [sessionId],
    );
    const [rows] = await pool.query(
      unitSelect.replace(
        "SELECT ",
        "SELECT su.scanned_at stocktake_scanned_at," +
          operatorName("o") +
          " stocktake_scanner,",
      ) +
        " JOIN stocktake_session_units su ON su.unit_id=u.id" +
        operatorJoin("o", "su.scanned_by") +
        " WHERE su.session_id=? AND " +
        condition +
        (state === "pending"
          ? " ORDER BY m.name,u.id"
          : " ORDER BY su.scanned_at DESC,u.id") +
        " LIMIT ? OFFSET ?",
      [sessionId, p.pageSize, p.offset],
    );
    const result = [];
    for (const row of rows)
      result.push({
        ...(await stock.view(pool, row, request)),
        scannedAt: row.stocktake_scanned_at,
        scanner: row.stocktake_scanner || "",
      });
    return list(result, count.n, p);
  });
  route("POST", "/stocktake-sessions/:id/scans", async (request) => {
    authorize(request);
    const code = text(request.body?.code, "设备编号或串码", 80);
    return transaction(pool, async (db) => {
      const session = await lockOpen(db, request.params.id);
      if (session.status !== "open") fail(409, "盘点单已结束，不能继续扫码");
      const scope = json(session.scope);
      // 优先匹配本单应盘清单里的设备
      const unit = await one(
        db,
        "SELECT u.id,u.status,u.model_id,m.category_id,su.scanned_at FROM units u JOIN models m ON m.id=u.model_id LEFT JOIN stocktake_session_units su ON su.unit_id=u.id AND su.session_id=? WHERE u.id=? OR u.imei1=? OR u.imei2=? ORDER BY su.unit_id IS NULL LIMIT 1",
        [session.id, code, code, code],
      );
      const expected =
        unit &&
        (await one(
          db,
          "SELECT unit_id FROM stocktake_session_units WHERE session_id=? AND unit_id=?",
          [session.id, unit.id],
        ));
      let result, message;
      if (expected && unit.scanned_at) {
        result = "duplicate";
        message = "这台已经盘过";
      } else if (expected) {
        await db.execute(
          "UPDATE stocktake_session_units SET scanned_by=?,scanned_at=CURRENT_TIMESTAMP(3),scanned_code=? WHERE session_id=? AND unit_id=?",
          [request.user.id, code, session.id, unit.id],
        );
        result = "matched";
        message = "已盘到";
      } else {
        const prior = await one(
          db,
          "SELECT id FROM stocktake_extras WHERE session_id=? AND (code=? OR (unit_id IS NOT NULL AND unit_id=?))",
          [session.id, code, unit ? unit.id : null],
        );
        if (prior) {
          result = "duplicate";
          message = "已记为异常，不重复登记";
        } else {
          const inScope =
            unit &&
            scope.statuses.includes(unit.status) &&
            (!scope.modelId || scope.modelId === unit.model_id) &&
            (!scope.category || scope.category === unit.category_id);
          result = unit ? "out_of_scope" : "unknown";
          message = !unit
            ? "系统里没有这台设备"
            : inScope
              ? "开盘后才进入盘点范围，不在开盘清单"
              : (UNIT_STATUS[unit.status]?.label || unit.status) +
                "，不在本次盘点范围";
          await db.execute(
            "INSERT INTO stocktake_extras (id,session_id,code,unit_id,unit_status,reason,scanned_by) VALUES (?,?,?,?,?,?,?)",
            [
              id(),
              session.id,
              code,
              unit ? unit.id : null,
              unit ? unit.status : null,
              message,
              request.user.id,
            ],
          );
        }
      }
      return {
        result,
        message,
        code: masked(request, code),
        unit: unit
          ? await stock.view(db, await stock.get(db, unit.id), request)
          : null,
        ...(await counts(db, session.id)),
      };
    });
  });
  route("POST", "/stocktake-sessions/:id/close", async (request) => {
    authorize(request);
    return transaction(pool, async (db) => {
      const session = await lockOpen(db, request.params.id);
      // 结束请求重试时返回已生成的结果
      if (session.status === "closed")
        return detail(db, await record(db, session.stocktake_id), request);
      if (session.status !== "open") fail(409, "盘点单已作废");
      const scope = json(session.scope);
      const [rows] = await db.execute(
        "SELECT su.unit_id,su.start_status,su.scanned_at,u.status,u.model_id,m.category_id FROM stocktake_session_units su JOIN units u ON u.id=su.unit_id JOIN models m ON m.id=u.model_id WHERE su.session_id=? ORDER BY m.name,u.id",
        [session.id],
      );
      const matchedIds = [],
        missingIds = [],
        changed = [];
      for (const r of rows) {
        if (r.scanned_at) matchedIds.push(r.unit_id);
        // 盘点期间已售出、出借等离店的设备不算缺失，单独列出
        else if (scope.statuses.includes(r.status)) missingIds.push(r.unit_id);
        else
          changed.push({
            unitId: r.unit_id,
            from: r.start_status,
            to: r.status,
          });
      }
      const [extras] = await db.execute(
        "SELECT * FROM stocktake_extras WHERE session_id=? ORDER BY scanned_at,id",
        [session.id],
      );
      const result = {
          expectedCount: rows.length,
          scannedCount: matchedIds.length + extras.length,
          matched: matchedIds.length,
          matchedIds,
          missingIds,
          changed,
          extra: extras.map((e) => ({
            code: e.code,
            unitId: e.unit_id,
            unitStatus: e.unit_status,
            reason: e.reason,
          })),
        },
        target = id();
      await db.execute(
        "INSERT INTO stocktakes (id,operator_id,scope,result,session_id) VALUES (?,?,?,?,?)",
        [
          target,
          request.user.id,
          JSON.stringify({
            ...scope,
            note: session.note,
            startedAt: session.created_at,
          }),
          JSON.stringify(result),
          session.id,
        ],
      );
      await db.execute(
        "UPDATE stocktake_sessions SET status='closed',stocktake_id=?,closed_by=?,closed_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [target, request.user.id, session.id],
      );
      await audit(db, request, "结束盘点", target, {
        after: {
          sessionId: session.id,
          expectedCount: result.expectedCount,
          matched: result.matched,
          missing: missingIds.length,
          changed: changed.length,
          extra: extras.length,
        },
      });
      return detail(db, await record(db, target), request);
    });
  });
  route("POST", "/stocktake-sessions/:id/cancel", async (request) => {
    authorize(request);
    const reason = text(request.body?.reason, "作废原因", 200);
    return transaction(pool, async (db) => {
      const session = await lockOpen(db, request.params.id);
      if (session.status !== "open") fail(409, "只能作废进行中的盘点单");
      await db.execute(
        "UPDATE stocktake_sessions SET status='cancelled',cancel_reason=?,closed_by=?,closed_at=CURRENT_TIMESTAMP(3) WHERE id=?",
        [reason, request.user.id, session.id],
      );
      await audit(db, request, "作废盘点", session.id, { reason });
      return sessionView(db, session.id);
    });
  });
};
