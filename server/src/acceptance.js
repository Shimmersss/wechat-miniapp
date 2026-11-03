const { transaction, one } = require("./db");
const {
  PERM,
  fail,
  id,
  text,
  json,
  requirePerm,
  audit,
  hash,
} = require("./core");
const { integer } = require("./validation");
const { isImei } = require("../../miniprogram/utils/validate");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
module.exports = async function acceptance(
  app,
  { pool, route, stock, order, view, refreshStatus },
) {
  async function checkSpecs(line, input) {
    if (input.modelId !== line.model_id)
      fail(400, "验收型号与采购明细不符，应记录异常");
    const expected = json(line.expected_attributes);
    for (const key of Object.keys(expected))
      if (input.attributes?.[key] !== expected[key])
        fail(400, `验收${key}与采购规格不符，应记录异常`);
  }
  async function receipts(db, item, request, cache = new Map()) {
    const input = item.receiptImages || item.attributes?.receipt || [];
    const files = await stock.normaliseFiles(db, input, "internal", request, {
      imagesOnly: true,
      cache,
    });
    if (!files.length) fail(400, "验收需上传内部收货凭证");
    return files;
  }
  route("POST", "/purchase-orders/:id/acceptance", async (request) => {
    requirePerm(request, PERM.ACCEPTANCE);
    const d = request.body || {},
      requestKey = text(d.requestKey, "提交标识", 80);
    if (!Array.isArray(d.items) || !d.items.length || d.items.length > 100)
      fail(400, "每次验收需为 1～100 台");
    if (integer(d.declaredCount, "本次实收数量", 1, 100) !== d.items.length)
      fail(400, "实收数量与逐台扫码数量不一致");
    const digest = hash(
      JSON.stringify(canonical({ ...d, purchaseId: request.params.id })),
    );
    return transaction(pool, async (db) => {
      const po = await order(db, request.params.id, true);
      const previous = await one(
        db,
        "SELECT * FROM acceptance_batches WHERE request_key=?",
        [requestKey],
      );
      if (previous) {
        if (previous.purchase_id !== po.id || previous.request_hash !== digest)
          fail(409, "提交标识已用于其他内容，请重新核对");
        return json(previous.result);
      }
      if (!["arrived", "accepting", "exception"].includes(po.status))
        fail(409, "请先登记实际签收，再开始验收");
      const signed = await one(
        db,
        "SELECT id FROM shipments WHERE purchase_id=? AND status='signed' LIMIT 1",
        [po.id],
      );
      if (!signed) fail(409, "采购单尚未签收");
      const [lines] = await db.execute(
        "SELECT * FROM purchase_lines WHERE purchase_id=? FOR UPDATE",
        [po.id],
      );
      const remaining = lines.reduce(
        (n, l) => n + l.quantity - l.received_count,
        0,
      );
      if (d.items.length > remaining) fail(400, "实收数量超过采购剩余数量");
      let partialReason = "";
      if (d.items.length < remaining) {
        if (d.partialConfirmed !== true)
          fail(400, "数量不足，请明确确认分批验收");
        partialReason = text(d.partialReason, "分批验收原因", 500);
      }
      const batchId = id(),
        seen = new Set(),
        files = new Map(),
        planned = [],
        lineCounts = new Map();
      for (let i = 0; i < d.items.length; i++) {
        const item = d.items[i] || {},
          line = lines.find((l) => l.id === item.lineId);
        if (!line) fail(400, `第 ${i + 1} 台不属于本采购单明细`);
        if (!["pass", "fail"].includes(item.result))
          fail(400, `第 ${i + 1} 台请填写验收结论`);
        const next = (lineCounts.get(line.id) || 0) + 1;
        if (next > line.quantity - line.received_count)
          fail(400, "本型号验收数量超过采购剩余数量");
        lineCounts.set(line.id, next);
        const itemId = id();
        let prepared = null,
          attributes;
        try {
          const proof = await receipts(db, item, request, files);
          if (item.result === "pass") {
            await checkSpecs(line, item);
            prepared = await stock.prepare(
              db,
              { ...item, receiptImages: proof },
              request,
              { seen, files, cost: line.unit_cost, supplierId: po.supplier_id },
            );
            attributes = prepared.attributes;
          } else {
            const imei1 = text(item.imei1, "IMEI1", 15),
              imei2 = text(item.imei2, "IMEI2", 15, true);
            for (const imei of [imei1, imei2].filter(Boolean)) {
              if (!isImei(imei)) fail(400, "异常设备也须提供有效串码");
              if (seen.has(imei)) fail(400, "本次验收串码重复");
              seen.add(imei);
              if (
                await one(
                  db,
                  "SELECT imei FROM unit_identifiers WHERE imei=?",
                  [imei],
                )
              )
                fail(409, "该串码已登记，不能重复验收");
            }
            const model = await one(db, "SELECT id FROM models WHERE id=?", [
              item.modelId || line.model_id,
            ]);
            if (!model) fail(400, "异常设备型号不存在");
            attributes = {
              _receiptImages: proof,
              _observedModel: text(
                item.observedModel,
                "实机型号说明",
                100,
                true,
              ),
            };
          }
          planned.push({ itemId, line, item, prepared, attributes });
        } catch (error) {
          if (error.statusCode)
            error.message = `第 ${i + 1} 台：${error.message}`;
          throw error;
        }
      }
      const result = {
        batchId,
        accepted: planned.filter((p) => p.prepared).length,
        rejected: planned.filter((p) => !p.prepared).length,
        unitIds: planned.filter((p) => p.prepared).map((p) => p.prepared.id),
        itemIds: planned.map((p) => p.itemId),
      };
      await db.execute(
        "INSERT INTO acceptance_batches (id,purchase_id,request_key,request_hash,operator_id,result) VALUES (?,?,?,?,?,?)",
        [
          batchId,
          po.id,
          requestKey,
          digest,
          request.user.id,
          JSON.stringify(result),
        ],
      );
      for (const p of planned) {
        const reason =
          p.item.result === "fail"
            ? text(p.item.remark || p.item.reason, "异常原因", 500)
            : "";
        await db.execute(
          "INSERT INTO acceptance_items (id,batch_id,purchase_line_id,imei1,imei2,model_id,result,reason,attributes) VALUES (?,?,?,?,?,?,?,?,?)",
          [
            p.itemId,
            batchId,
            p.line.id,
            p.prepared?.imei1 || p.item.imei1.trim(),
            p.prepared?.imei2 || p.item.imei2?.trim() || null,
            p.prepared?.modelId || p.item.modelId || p.line.model_id,
            p.item.result,
            reason,
            JSON.stringify(p.attributes),
          ],
        );
        if (p.prepared) {
          await stock.insert(db, p.prepared, request, {
            purchaseLineId: p.line.id,
            acceptanceItemId: p.itemId,
          });
          await db.execute("UPDATE acceptance_items SET unit_id=? WHERE id=?", [
            p.prepared.id,
            p.itemId,
          ]);
        } else
          for (const [slot, imei] of [
            ["imei1", p.item.imei1.trim()],
            ["imei2", p.item.imei2?.trim()],
          ].filter((x) => x[1]))
            await db.execute(
              "INSERT INTO unit_identifiers (imei,acceptance_item_id,slot) VALUES (?,?,?)",
              [imei, p.itemId, slot],
            );
        await db.execute(
          "UPDATE purchase_lines SET received_count=received_count+1,accepted_count=accepted_count+?,rejected_count=rejected_count+? WHERE id=?",
          [p.prepared ? 1 : 0, p.prepared ? 0 : 1, p.line.id],
        );
      }
      await refreshStatus(db, po.id);
      await audit(db, request, "采购到货验收", po.id, {
        after: result,
        reason: partialReason,
      });
      return result;
    });
  });
  route("POST", "/acceptances/:id/resolve", async (request) => {
    requirePerm(request, PERM.ACCEPTANCE);
    const d = request.body || {},
      reason = text(d.reason, "异常处理原因", 500);
    if (!["return", "dispute", "reinspect"].includes(d.action))
      fail(400, "异常处理方式无效");
    const record = await one(
      pool,
      "SELECT a.*,b.purchase_id FROM acceptance_items a JOIN acceptance_batches b ON b.id=a.batch_id WHERE a.id=?",
      [request.params.id],
    );
    if (!record) fail(404, "验收记录不存在");
    return transaction(pool, async (db) => {
      const po = await order(db, record.purchase_id, true),
        item = await one(
          db,
          "SELECT * FROM acceptance_items WHERE id=? FOR UPDATE",
          [record.id],
        );
      if (
        item.result !== "fail" ||
        !["none", "dispute"].includes(item.resolution) ||
        item.unit_id
      )
        fail(409, "该异常已处理，不能重复操作");
      if (d.action === "dispute")
        await db.execute(
          "UPDATE acceptance_items SET resolution='dispute',reason=? WHERE id=?",
          [reason, item.id],
        );
      if (d.action === "return") {
        await db.execute(
          "DELETE FROM unit_identifiers WHERE acceptance_item_id=? AND unit_id IS NULL",
          [item.id],
        );
        await db.execute(
          "UPDATE acceptance_items SET resolution='returned',reason=? WHERE id=?",
          [reason, item.id],
        );
      }
      let unitId;
      if (d.action === "reinspect") {
        const line = await one(
          db,
          "SELECT * FROM purchase_lines WHERE id=? FOR UPDATE",
          [item.purchase_line_id],
        );
        const input = d.unit || {};
        await checkSpecs(line, input);
        if (
          (input.imei1 && input.imei1 !== item.imei1) ||
          (input.imei2 && input.imei2 !== item.imei2)
        )
          fail(400, "复验不能替换原异常设备串码");
        const original = json(item.attributes),
          proof =
            input.receiptImages ||
            input.attributes?.receipt ||
            original._receiptImages ||
            [];
        const trustedReceiptIds = new Set(
          (original._receiptImages || []).map((f) => f.fileId),
        );
        const prepared = await stock.prepare(
          db,
          {
            ...input,
            imei1: item.imei1,
            imei2: item.imei2 || "",
            receiptImages: proof,
          },
          request,
          {
            reservedItemId: item.id,
            cost: line.unit_cost,
            supplierId: po.supplier_id,
            trustedReceiptIds,
          },
        );
        unitId = await stock.insert(db, prepared, request, {
          purchaseLineId: line.id,
          acceptanceItemId: item.id,
          reservedItemId: item.id,
          reason,
        });
        await db.execute(
          "UPDATE acceptance_items SET resolution='reinspected',unit_id=?,reason=? WHERE id=?",
          [unitId, reason, item.id],
        );
        await db.execute(
          "UPDATE purchase_lines SET accepted_count=accepted_count+1,rejected_count=rejected_count-1 WHERE id=?",
          [line.id],
        );
      }
      const status = await refreshStatus(db, po.id);
      await audit(db, request, "处理验收异常", item.id, {
        before: { resolution: item.resolution },
        after: { action: d.action, unitId: unitId || null, status },
        reason,
      });
      return { resolved: true, unitId: unitId || null, purchaseStatus: status };
    });
  });
};
