const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client, page } = require("./page-helpers");
const { one } = require("../src/db");
let f, boss, warehouse, model, template, payload, id, code, other;
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
  warehouse = client(f, "warehouse");
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "库存页面验证_" + Date.now(),
      brandLabel: "验证品牌",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  template = await boss.template.detail(model.templateId);
  const supplier = (
    await f.api("POST", "/suppliers", { name: "库存页面货源_" + Date.now() })
  ).data;
  const receipt = await f.upload();
  code = imei();
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, receipt),
    cost: "1000.12",
    retail: "1300.25",
    wholesale: "1200.25",
    agentBase: "1200.25",
    flags: { showInShop: false, sharePeer: false, shareAgent: false },
  };
  id = (await boss.inbound.createUnit({ ...payload, imei1: code })).id;
  other = (
    await boss.inbound.createUnit({
      ...payload,
      imei1: imei(),
      attributes: { ...payload.attributes, refurbishment: "正在整备" },
    })
  ).id;
});
test.after(async () => {
  await f?.close();
});
test("批量代理转发：多选在库设备一键开关，非在库整批拒绝不留部分结果，逐台审计", async () => {
  const list = page("miniprogram/packages/staff/inventory/list.js", boss);
  await list.onLoad({});
  assert.equal(list.data.canShare, true);
  await list.onStartAgent();
  assert.equal(list.data.pickMode, "agent");
  assert.equal(list.data.activeFilter, "in_stock");
  list.onItemTap({
    currentTarget: { dataset: { id: other, status: "recheck" } },
  });
  assert.equal(list.data.selectedCount, 0);
  list.onItemTap({ currentTarget: { dataset: { id, status: "in_stock" } } });
  await list.onAgentShare({ currentTarget: { dataset: { on: "1" } } });
  assert.equal(list.data.error, "");
  assert.equal(list.data.pickMode, "");
  assert.equal((await boss.inventory.detail(id)).flags.shareAgent, true);
  const batch = (body, role) =>
    f.api("PATCH", "/units/share-flags", body, role);
  let r = await batch({ unitIds: [id, other], shareAgent: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.updated, 2);
  assert.equal((await boss.inventory.detail(id)).flags.shareAgent, false);
  r = await batch({ unitIds: [id, other], shareAgent: true });
  assert.equal(r.status, 409);
  assert.equal((await boss.inventory.detail(id)).flags.shareAgent, false);
  assert.equal(
    (await batch({ unitIds: [id], shareAgent: true }, "warehouse")).status,
    403,
  );
  assert.equal((await batch({ unitIds: [], shareAgent: true })).status, 400);
  assert.equal((await batch({ unitIds: [id], shareAgent: "yes" })).status, 400);
  const audits = await one(
    f.pool,
    "SELECT COUNT(*) n FROM audit_logs WHERE object_id=? AND action='批量调整代理转发'",
    [id],
  );
  assert.equal(Number(audits.n), 2);
  list.onUnload();
});
test("库存页面真实接口：精确搜索、改价原因/版本冲突、共享开关和流水", async () => {
  const list = page("miniprogram/packages/staff/inventory/list.js", boss);
  await list.onLoad({});
  list.data.model = model;
  list.data.keyword = code;
  await list.onSearch();
  assert.equal(list.data.total, 1);
  assert.equal(list.data.list[0].id, id);
  list.data.keyword = "";
  list.data.minPrice = "1301";
  await list.onApplyFilter();
  assert.equal(list.data.total, 0);
  const detail = page("miniprogram/packages/staff/inventory/detail.js", boss);
  await detail.onLoad({ id });
  assert.equal(detail.data.ledger.length, 1);
  detail.onEditPrice();
  detail.data.priceEditor.values.retail = "1350.58";
  await detail.onSavePrice();
  assert.equal(detail.data.detail.retail, 1350.58);
  assert.equal(detail.confirmations.at(-1).needReason, true);
  detail.onEditPrice();
  detail.data.priceEditor.values.retail = "1400";
  await boss.inventory.updatePrice(id, {
    retail: "1380",
    priceVersion: detail.data.detail.priceVersion,
    reason: "验证其他操作人改价",
  });
  await detail.onSavePrice();
  assert.equal(detail.data.priceConflict, true);
  assert.equal((await boss.inventory.detail(id)).retail, 1380);
  await detail.onRefreshPrice();
  await detail.onFlag({
    currentTarget: { dataset: { field: "showInShop" } },
    detail: { value: true },
  });
  assert.equal((await boss.inventory.detail(id)).flags.showInShop, true);
  const sales = page(
    "miniprogram/packages/staff/inventory/detail.js",
    client(f, "sales"),
    "sales",
  );
  await sales.onLoad({ id });
  assert.equal(sales.data.canPrice, false);
  assert.equal(sales.data.detail.cost, undefined);
  assert.equal(sales.data.detail.imei1, undefined);
  assert.equal(
    (await f.api("GET", "/units/" + id + "/recheck-form", undefined, "sales"))
      .status,
    403,
  );
  list.onUnload();
});
test("复检页面沿用入库快照与隐藏凭证，过期版本不可覆盖，复检后不可自动分享", async () => {
  const detail = page(
    "miniprogram/packages/staff/inventory/detail.js",
    warehouse,
    "warehouse",
  );
  await detail.onLoad({ id: other });
  await detail.onOpenRecheck();
  const initial = detail.data.recheckEditor.inspectionVersion;
  assert.equal(
    detail.data.recheckEditor.fields.some((f) => f.key === "supplier"),
    false,
  );
  assert.ok(detail.data.recheckEditor.hiddenKeys.includes("receipt"));
  assert.equal(
    JSON.stringify(detail.data.recheckEditor).includes(payload.supplierId),
    false,
  );
  detail.onRecheckResult({ currentTarget: { dataset: { value: "fail" } } });
  await detail.onSaveRecheck();
  assert.equal(detail.data.detail.status, "recheck");
  assert.equal(
    (
      await f.api(
        "POST",
        "/units/" + other + "/recheck",
        {
          inspectionVersion: initial,
          result: "pass",
          reason: "旧版本",
          attributes: { refurbishment: "整备完成" },
        },
        "warehouse",
      )
    ).status,
    409,
  );
  await detail.onOpenRecheck();
  detail.onRecheckField({
    detail: { key: "refurbishment", value: "整备完成" },
  });
  detail.onRecheckResult({ currentTarget: { dataset: { value: "pass" } } });
  detail.data.busy = 1;
  await detail.onSaveRecheck();
  assert.equal(detail.data.detail.status, "recheck");
  detail.data.busy = 0;
  await detail.onSaveRecheck();
  assert.equal(detail.data.detail.status, "in_stock");
  assert.equal(detail.data.detail.flags.showInShop, false);
  assert.equal(detail.data.ledger.length, 3);
  assert.equal(
    (await one(f.pool, "SELECT supplier_id FROM units WHERE id=?", [other]))
      .supplier_id,
    payload.supplierId,
  );
});
test("盘点页面真实接口：缺失/未知、超时原样重试、历史持久化及不可改记录", async () => {
  const p = page(
    "miniprogram/packages/staff/inventory/stocktake.js",
    warehouse,
    "warehouse",
  );
  await p.onLoad({ modelId: model.id, modelName: "验证" });
  p.data.codes = [code, id, "UNKNOWN_VERIFY"]; // 两种编号指向同一台
  const send = warehouse.inventory.stocktake;
  let n = 0;
  warehouse.inventory.stocktake = async (body) => {
    const result = await send(body);
    if (++n === 1) throw Object.assign(new Error("合成响应丢失"), { code: -1 });
    return result;
  };
  await p.onSubmit();
  assert.ok(p.data.pending);
  const key = p.data.pending.requestKey;
  await p.send();
  assert.equal(p.data.pending, null);
  assert.equal(p.data.result.expectedCount, 2);
  assert.equal(p.data.result.matched, 1);
  assert.equal(p.data.result.missing.length, 1);
  assert.equal(p.data.result.extra.length, 1);
  const recordId = p.data.result.id;
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM stocktakes WHERE request_key=?",
          [key],
        )
      ).n,
    ),
    1,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/stocktakes",
        { requestKey: key, scannedImeis: ["DIFFERENT"] },
        "warehouse",
      )
    ).status,
    409,
  );
  await f.restart();
  assert.equal(
    (await warehouse.inventory.stocktakeDetail(recordId)).matched,
    1,
  );
  assert.ok(
    (await warehouse.inventory.stocktakes({ pageSize: 1000 })).list.some(
      (r) => r.id === recordId,
    ),
  );
  await assert.rejects(
    f.pool.execute("UPDATE stocktakes SET result=? WHERE id=?", [
      "{}",
      recordId,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  assert.equal(
    (await f.api("GET", "/stocktakes/" + recordId, undefined, "sales")).status,
    403,
  );
  p.onUnload();
});
