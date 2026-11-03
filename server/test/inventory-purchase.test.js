const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
let f, model, template, supplier, receipt, payload;
test.before(async () => {
  f = await fixture();
  const suffix = Date.now() + "_" + Math.random().toString(16).slice(2, 8);
  let r = await f.api("POST", "/models", {
    category: "phone",
    name: "验证库存_" + suffix,
    brandLabel: "验证品牌",
    series: "验证系列",
    copyTemplateId: "t_phone",
    tacs: [],
  });
  assert.equal(r.status, 200);
  model = r.data;
  template = (await f.api("GET", "/templates/" + model.templateId)).data;
  r = await f.api("POST", "/suppliers", {
    name: "验证供应商_" + suffix,
    contact: "测试联系人",
    settle: "测试结算",
  });
  assert.equal(r.status, 200);
  supplier = r.data;
  receipt = await f.upload();
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, receipt),
    cost: "1000.00",
    retail: "1200.00",
    wholesale: "1100.00",
    agentBase: "1100.00",
    flags: { showInShop: true, sharePeer: true, shareAgent: false },
  };
});
test.after(async () => {
  await f?.close();
});
test("真实库存：验收确认、跨 IMEI1/2 唯一、批量回滚、角色裁剪与重启", async () => {
  assert.equal(
    (await one(f.pool, "SELECT @@session.time_zone tz")).tz,
    "+00:00",
  );
  const code = imei();
  assert.equal(
    (
      await f.api("POST", "/inbound/units", {
        ...payload,
        imei1: code,
        inspectionConfirmed: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/inbound/units",
        { ...payload, imei1: code },
        "sales",
      )
    ).status,
    403,
  );
  let r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: code,
    imei2: imei(),
  });
  assert.equal(r.status, 200);
  const unitId = r.data.id;
  const unit = await one(f.pool, "SELECT * FROM units WHERE id=?", [unitId]);
  assert.equal(unit.status, "in_stock");
  assert.ok(Math.abs(Date.now() - new Date(unit.created_at).getTime()) < 10000);
  assert.equal(
    (
      await f.api("POST", "/inbound/units", {
        ...payload,
        imei1: imei(),
        imei2: code,
      })
    ).status,
    409,
  );
  const before = Number(
    (
      await one(f.pool, "SELECT COUNT(*) n FROM units WHERE model_id=?", [
        model.id,
      ])
    ).n,
  );
  r = await f.api("POST", "/inbound/batch", {
    common: payload,
    units: [{ imei1: imei() }, { imei1: imei(), retail: "1.001" }],
  });
  assert.equal(r.status, 400);
  assert.equal(
    Number(
      (
        await one(f.pool, "SELECT COUNT(*) n FROM units WHERE model_id=?", [
          model.id,
        ])
      ).n,
    ),
    before,
  );
  const duplicate = imei();
  const results = await Promise.all(
    [1, 2].map(() =>
      f.api("POST", "/inbound/units", { ...payload, imei1: duplicate }),
    ),
  );
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  r = await f.api("GET", "/units/" + unitId, undefined, "sales");
  assert.equal(r.status, 200);
  for (const key of [
    "cost",
    "supplier",
    "supplierId",
    "internalNote",
    "imei1",
    "imei2",
    "template_snapshot",
    "attributes",
    "agentBase",
    "receiptImages",
  ])
    assert.equal(r.data[key], undefined, key);
  assert.ok(r.data.imeiMasked.includes("****"));
  assert.ok(
    r.data.parameters.every((p) => !["supplier", "receipt"].includes(p.key)),
  );
  assert.equal(
    (await f.api("GET", "/units/" + unitId, undefined, "customer")).status,
    403,
  );
  r = await f.api("GET", "/units/" + unitId + "/ledger");
  assert.equal(r.status, 200);
  assert.equal(r.data.total, 1);
  await assert.rejects(
    f.pool.execute("UPDATE inventory_ledger SET reason=? WHERE unit_id=?", [
      "篡改",
      unitId,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await f.restart();
  assert.equal((await f.api("GET", "/units/" + unitId)).data.imei1, code);
});
test("真实库存：改价原因与版本、整备复检、盘点及上传范围", async () => {
  let r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: imei(),
    attributes: { ...payload.attributes, refurbishment: "正在整备" },
  });
  assert.equal(r.status, 200);
  const unitId = r.data.id;
  r = await f.api("GET", "/units/" + unitId);
  assert.equal(r.data.status, "recheck");
  assert.equal(r.data.flags.showInShop, false);
  assert.equal(
    (
      await f.api("PATCH", "/units/" + unitId + "/share-flags", {
        showInShop: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api("POST", "/units/" + unitId + "/recheck", {
        result: "pass",
        inspectionVersion: 1,
        reason: "验证复检",
      })
    ).status,
    400,
  );
  r = await f.api("POST", "/units/" + unitId + "/recheck", {
    result: "pass",
    inspectionVersion: 1,
    reason: "验证整备完成后复检",
    attributes: {
      refurbishment: "整备完成",
      battery: 95,
      receipt: [{ fileId: receipt.fileId }],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "in_stock");
  assert.equal(r.data.flags.showInShop, false);
  assert.equal(
    (
      await f.api("PATCH", "/units/" + unitId + "/price", {
        retail: "1300",
        priceVersion: r.data.priceVersion,
      })
    ).status,
    400,
  );
  const version = r.data.priceVersion;
  const results = await Promise.all(
    [1, 2].map((n) =>
      f.api("PATCH", "/units/" + unitId + "/price", {
        retail: String(1300 + n),
        priceVersion: version,
        reason: "验证并发改价",
      }),
    ),
  );
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/units/" + unitId + "/price",
        { retail: "1300", priceVersion: version, reason: "销售越权" },
        "sales",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("POST", "/inbound/units", {
        ...payload,
        imei1: imei(),
        publicImages: [{ fileId: receipt.fileId }],
      })
    ).status,
    400,
  );
  r = await f.api(
    "POST",
    "/stocktakes",
    {
      scannedImeis: [unitId, unitId],
      modelId: model.id,
      statuses: ["in_stock"],
    },
    "warehouse",
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.matched, 1);
  assert.ok(r.data.missing.length >= 1);
  assert.equal(r.data.extra.length, 0);
});
async function createOrder(quantity = 2) {
  let r = await f.api("POST", "/purchase-orders", {
    supplierId: supplier.id,
    expectedAt: "2026-11-10",
    freight: "12.34",
    amount: 0,
    lines: [
      {
        modelId: model.id,
        quantity,
        unitCost: "1000.12",
        attributes: { storage: payload.attributes.storage },
      },
    ],
  });
  assert.equal(r.status, 200);
  return r.data;
}
async function receive(po) {
  let r = await f.api("POST", `/purchase-orders/${po.id}/shipments`, {
    carrier: "SF",
    trackingNo: "VERIFY" + po.id.replaceAll("-", "").slice(0, 20),
  });
  assert.equal(r.status, 200);
  const ship = r.data.id;
  assert.equal((await f.api("GET", `/shipments/${ship}/tracks`)).status, 503);
  r = await f.api("POST", `/shipments/${ship}/receive`, {
    reason: "合成验证的人工签收，非真实物流",
  });
  assert.equal(r.status, 200);
  return ship;
}
function passItem(lineId, code = imei()) {
  return { ...payload, lineId, imei1: code, result: "pass" };
}
test("真实采购验收：金额核算、未签收拒绝、数量比对、异常不入库和幂等", async () => {
  const po = await createOrder(2);
  assert.equal(po.amount, 2012.58);
  assert.equal(po.qty, 2);
  const lineId = po.lines[0].id;
  const code1 = imei(),
    code2 = imei(),
    requestKey = "verify_" + po.id;
  const items = [
    passItem(lineId, code1),
    {
      lineId,
      modelId: model.id,
      imei1: code2,
      result: "fail",
      remark: "验证：型号/外观异常",
      receiptImages: [{ fileId: receipt.fileId }],
    },
  ];
  assert.equal(
    (
      await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
        requestKey,
        declaredCount: 2,
        items,
      })
    ).status,
    409,
  );
  await receive(po);
  assert.equal(
    (
      await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
        requestKey,
        declaredCount: 1,
        items,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
        requestKey,
        declaredCount: 1,
        items: [items[0]],
      })
    ).status,
    400,
  );
  const r = await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
    requestKey,
    declaredCount: 2,
    items,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, 1);
  assert.equal(r.data.rejected, 1);
  const replay = await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
    requestKey,
    declaredCount: 2,
    items,
  });
  assert.deepEqual(replay.data, r.data);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM units WHERE purchase_line_id=?",
          [lineId],
        )
      ).n,
    ),
    1,
  );
  let detail = (await f.api("GET", "/purchase-orders/" + po.id)).data;
  assert.equal(detail.status, "exception");
  assert.equal(detail.lines[0].remaining, 0);
  const warehouse = (
    await f.api("GET", "/purchase-orders/" + po.id, undefined, "warehouse")
  ).data;
  for (const key of ["supplier", "supplierId", "amount", "freight"])
    assert.equal(warehouse[key], undefined);
  assert.equal(warehouse.lines[0].unitCost, undefined);
  assert.equal(
    (await f.api("GET", "/suppliers", undefined, "warehouse")).status,
    403,
  );
  assert.equal(
    (await f.api("POST", "/inbound/units", { ...payload, imei1: code2 }))
      .status,
    409,
  );
  const exception = r.data.itemIds[1];
  assert.equal(
    (
      await f.api("POST", `/acceptances/${exception}/resolve`, {
        action: "dispute",
        reason: "验证争议登记",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api("POST", `/acceptances/${exception}/resolve`, {
        action: "return",
        reason: "验证退回供应商",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api("POST", `/acceptances/${exception}/resolve`, {
        action: "return",
        reason: "验证重复处理",
      })
    ).status,
    409,
  );
  detail = (await f.api("GET", "/purchase-orders/" + po.id)).data;
  assert.equal(detail.status, "completed");
  assert.equal(detail.lines[0].accepted, 1);
  assert.equal(detail.lines[0].rejected, 1);
  assert.equal(detail.exceptions[0].resolution, "returned");
  assert.equal(
    (await f.api("POST", "/inbound/check-imei", { imei: code2 })).data.unique,
    true,
  );
});
test("真实采购验收：复验沿用原串码与成本，不重复计数；分批需确认", async () => {
  const po = await createOrder(1);
  await receive(po);
  const lineId = po.lines[0].id,
    code = imei();
  let r = await f.api("POST", `/purchase-orders/${po.id}/acceptance`, {
    requestKey: "fail_" + po.id,
    declaredCount: 1,
    items: [
      {
        lineId,
        modelId: model.id,
        imei1: code,
        result: "fail",
        remark: "验证待复验",
        receiptImages: [{ fileId: receipt.fileId }],
      },
    ],
  });
  assert.equal(r.status, 200);
  const itemId = r.data.itemIds[0];
  r = await f.api("POST", `/acceptances/${itemId}/resolve`, {
    action: "reinspect",
    reason: "验证复验通过",
    unit: { ...passItem(lineId), imei1: code, cost: 1 },
  });
  assert.equal(r.status, 200);
  const unit = await one(f.pool, "SELECT * FROM units WHERE id=?", [
    r.data.unitId,
  ]);
  assert.equal(Number(unit.cost), 1000.12);
  assert.equal(unit.imei1, code);
  const detail = (await f.api("GET", "/purchase-orders/" + po.id)).data;
  assert.equal(detail.lines[0].received, 1);
  assert.equal(detail.lines[0].accepted, 1);
  assert.equal(detail.lines[0].rejected, 0);
  assert.equal(detail.status, "completed");
  const partial = await createOrder(2);
  await receive(partial);
  r = await f.api("POST", `/purchase-orders/${partial.id}/acceptance`, {
    requestKey: "partial_" + partial.id,
    declaredCount: 1,
    partialConfirmed: true,
    partialReason: "验证分批到货",
    items: [passItem(partial.lines[0].id)],
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await f.api("GET", "/purchase-orders/" + partial.id)).data.status,
    "accepting",
  );
});

test("库管验收不读取供应商和成本，服务端保留采购成本及货源", async () => {
  const po = await createOrder(1);
  await receive(po);
  const proof = await f.upload("internal", "warehouse");
  const item = {
    ...passItem(po.lines[0].id),
    supplierId: "forged-vendor",
    cost: "0.01",
    attributes: {
      ...payload.attributes,
      supplier: "伪造货源",
      receipt: [{ fileId: proof.fileId }],
    },
  };
  let response = await f.api(
    "POST",
    `/purchase-orders/${po.id}/acceptance`,
    { requestKey: "warehouse_" + po.id, declaredCount: 1, items: [item] },
    "warehouse",
  );
  assert.equal(response.status, 200);
  const record = await one(
    f.pool,
    "SELECT cost,supplier_id FROM units WHERE id=?",
    [response.data.unitIds[0]],
  );
  assert.equal(Number(record.cost), 1000.12);
  assert.equal(record.supplier_id, supplier.id);
  response = await f.api(
    "GET",
    "/units/" + response.data.unitIds[0],
    undefined,
    "warehouse",
  );
  assert.equal(response.data.cost, undefined);
  assert.equal(response.data.supplier, undefined);
  assert.equal(response.data.receiptImages.length, 1);
  assert.deepEqual(
    (
      await f.api(
        "GET",
        "/pricing/cost-presets?modelId=" + model.id,
        undefined,
        "warehouse",
      )
    ).data,
    [],
  );
});
