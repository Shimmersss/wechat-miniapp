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
const { UNIT_STATUS } = require("../../miniprogram/constants/status");
const { unitSelect, canSee } = require("./stock");
module.exports = async function stocktake(app, { pool, route, stock }) {
  function authorize(request) {
    requirePerm(request, PERM.STOCKTAKE);
    requirePerm(request, PERM.INVENTORY_VIEW);
  }
  async function record(db, column, value) {
    return one(
      db,
      "SELECT t.*,COALESCE(s.name,u.nickname) operator FROM stocktakes t JOIN users u ON u.id=t.operator_id LEFT JOIN staff s ON s.user_id=u.id WHERE t." +
        column +
        "=?",
      [value],
    );
  }
  function summary(row) {
    const r = json(row.result);
    return {
      id: row.id,
      time: row.created_at,
      operator: row.operator || "",
      scope: json(row.scope),
      expectedCount: r.expectedCount,
      scannedCount: r.scannedCount,
      matched: r.matched,
      missingCount: r.missingIds.length,
      extraCount: r.extra.length,
    };
  }
  async function detail(db, row, request) {
    const r = json(row.result),
      missing = [];
    for (const unitId of r.missingIds)
      missing.push(await stock.view(db, await stock.get(db, unitId), request));
    return {
      ...summary(row),
      missingIds: r.missingIds,
      matchedIds: r.matchedIds || [],
      missing,
      extra: r.extra.map((e) => ({
        ...e,
        code: canSee(request.user, "fullImei") ? e.code : "***",
      })),
    };
  }
  route("GET", "/stocktakes", async (request) => {
    authorize(request);
    const p = page(request.query),
      count = await one(pool, "SELECT COUNT(*) n FROM stocktakes");
    const [rows] = await pool.query(
      "SELECT t.*,COALESCE(s.name,u.nickname) operator FROM stocktakes t JOIN users u ON u.id=t.operator_id LEFT JOIN staff s ON s.user_id=u.id ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?",
      [p.pageSize, p.offset],
    );
    return list(rows.map(summary), count.n, p);
  });
  route("GET", "/stocktakes/:id", async (request) => {
    authorize(request);
    const row = await record(pool, "id", request.params.id);
    if (!row) fail(404, "盘点记录不存在");
    return detail(pool, row, request);
  });
  route("POST", "/stocktakes", async (request) => {
    authorize(request);
    const input = request.body || {},
      raw = input.scannedImeis || input.codes;
    if (
      !Array.isArray(raw) ||
      !raw.length ||
      raw.length > 1000 ||
      raw.some((c) => typeof c !== "string" || !c.trim() || c.length > 80)
    )
      fail(400, "盘点需包含 1～1000 个串码或设备编号");
    const codes = [...new Set(raw.map((c) => c.trim()))],
      selected = input.statuses || [
        "in_stock",
        "locked",
        "repairing",
        "recheck",
      ];
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.some((s) => !UNIT_STATUS[s])
    )
      fail(400, "盘点范围无效");
    const statuses = [...new Set(selected)].sort(),
      modelId = input.modelId ? text(input.modelId, "型号", 60) : null;
    const key =
      input.requestKey === undefined
        ? null
        : text(input.requestKey, "提交标识", 80);
    const digest = hash(
      JSON.stringify({ codes: codes.slice().sort(), statuses, modelId }),
    );
    async function replay(db, row) {
      if (row.request_hash !== digest)
        fail(409, "提交标识已用于其他内容，请保留原批次重试");
      return detail(db, row, request);
    }
    try {
      return await transaction(pool, async (db) => {
        if (key) {
          const previous = await record(db, "request_key", key);
          if (previous) return replay(db, previous);
        }
        if (
          modelId &&
          !(await one(db, "SELECT id FROM models WHERE id=?", [modelId]))
        )
          fail(400, "盘点型号不存在");
        const params = [...statuses],
          where =
            " WHERE u.status IN (" +
            statuses.map(() => "?").join(",") +
            ")" +
            (modelId ? " AND u.model_id=?" : "");
        if (modelId) params.push(modelId);
        const [expected] = await db.execute(
          unitSelect + where + " FOR SHARE",
          params,
        );
        const expectedIds = new Set(expected.map((u) => u.id)),
          matched = new Set(),
          extra = [];
        for (const code of codes) {
          const match = await one(
            db,
            "SELECT id FROM units WHERE id=? OR imei1=? OR imei2=?",
            [code, code, code],
          );
          if (match && expectedIds.has(match.id)) matched.add(match.id);
          else
            extra.push({
              code,
              reason: match ? "设备不在本次盘点范围" : "未找到该设备",
            });
        }
        const missing = expected.filter((u) => !matched.has(u.id)),
          target = id();
        const result = {
          expectedCount: expected.length,
          scannedCount: codes.length,
          matched: matched.size,
          matchedIds: [...matched],
          missingIds: missing.map((u) => u.id),
          extra,
        };
        await db.execute(
          "INSERT INTO stocktakes (id,operator_id,scope,result,request_key,request_hash) VALUES (?,?,?,?,?,?)",
          [
            target,
            request.user.id,
            JSON.stringify({ statuses, modelId }),
            JSON.stringify(result),
            key,
            key ? digest : null,
          ],
        );
        await audit(db, request, "库存盘点", target, {
          after: {
            expectedCount: result.expectedCount,
            matched: result.matched,
            missing: missing.length,
            extra: extra.length,
          },
        });
        return detail(db, await record(db, "id", target), request);
      });
    } catch (error) {
      // Two identical requests can race before either sees the committed row. The unique key decides the winner.
      if (key && error.code === "ER_DUP_ENTRY") {
        const previous = await record(pool, "request_key", key);
        if (previous) return replay(pool, previous);
      }
      throw error;
    }
  });
};
