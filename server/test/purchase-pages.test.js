const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client, page } = require("./page-helpers");
const { one } = require("../src/db");
let f, boss, warehouse, model, template, supplier, order;
const staff = "miniprogram/packages/staff/";
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
  warehouse = client(f, "warehouse");
  const result = await f.api("POST", "/models", {
    category: "phone",
    name: "页面验证_" + Date.now(),
    brandLabel: "页面验证品牌",
    series: "测试系列",
    copyTemplateId: "t_phone",
    tacs: [],
  });
  assert.equal(result.status, 200);
  model = result.data;
  template = await boss.template.detail(model.templateId);
});
test.after(async () => {
  await f?.close();
});
test("采购型号选择器使用安全的来源参数，选中后回传对应明细行", async () => {
  const purchase = page(staff + "purchase/edit.js", boss);
  await purchase.onLoad({});
  const line = purchase.data.lines[0];
  purchase.onChooseModel({ currentTarget: { dataset: { key: line.key } } });
  const navigation = purchase.navigation.at(-1);
  assert.equal(navigation.query.from, "purchase");
  const selecting = page(staff + "templates/index.js", boss);
  selecting.$back = () => {};
  selecting.onLoad({ ...navigation.query, category: model.category });
  await selecting.load();
  assert.ok(
    selecting.models().some((m) => m.id === model.id),
    selecting.data.error,
  );
  let pending;
  const original = purchase.selectModel;
  purchase.selectModel = (selected) => {
    pending = original.call(purchase, selected);
    return pending;
  };
  selecting.onSelectModel({ currentTarget: { dataset: { id: model.id } } });
  assert.ok(pending, "选择器须触发采购页面监听器");
  await pending;
  assert.equal(purchase.data.lines[0].modelId, model.id);
  assert.ok(purchase.data.lines[0].specFields.length);
  purchase.onUnload();
});
test("采购页面经实际 API 保存供应商和多行采购，按运单/货源筛选与汇总", async () => {
  const suppliers = page(staff + "suppliers/index.js", boss);
  await suppliers.onLoad({});
  suppliers.onAdd();
  Object.assign(suppliers.data.editor, {
    name: "页面供应商_" + Date.now(),
    contact: "验证联系人",
    settle: "现结",
  });
  suppliers.data.keyword = suppliers.data.editor.name;
  await suppliers.onSave();
  assert.equal(suppliers.data.editor, null);
  supplier = suppliers.data.list[0];
  assert.ok(supplier.id);
  suppliers.onEdit({ currentTarget: { dataset: { id: supplier.id } } });
  suppliers.data.editor.note = "真实 HTTP 页面档案";
  await suppliers.onSave();
  assert.equal(suppliers.data.list[0].note, "真实 HTTP 页面档案");
  const purchase = page(staff + "purchase/edit.js", boss);
  await purchase.onLoad({});
  purchase.data.form = {
    supplierId: supplier.id,
    expectedAt: "2026-11-20",
    freight: "12.34",
    remark: "页面真实接口验证",
  };
  purchase.selectionKey = purchase.data.lines[0].key;
  await purchase.selectModel(model);
  Object.assign(purchase.data.lines[0], {
    quantity: "1",
    unitCost: "1000.12",
    attributes: {
      storage: template.fields.find((f) => f.key === "storage").options[0],
    },
  });
  purchase.onAddLine();
  purchase.selectionKey = purchase.data.lines[1].key;
  await purchase.selectModel(model);
  Object.assign(purchase.data.lines[1], { quantity: "1", unitCost: "1000.12" });
  await purchase.onSubmit();
  order = purchase.data.saved;
  assert.ok(order, purchase.data.error);
  assert.equal(order.amount, 2012.58);
  assert.equal(order.qty, 2);
  await purchase.onSubmit(); // 成功状态阻止再次创建
  let list = await boss.purchase.list({ supplierId: supplier.id });
  assert.equal(list.total, 1);
  assert.equal(list.summary.totalQty, 2);
  assert.equal(list.summary.remainingQty, 2);
  const edit = page(staff + "purchase/edit.js", boss);
  await edit.onLoad({ id: order.id });
  assert.equal(edit.data.error, "");
  assert.ok(edit.data.lines[0].specFields.length);
  const detail = page(staff + "purchase/detail.js", boss);
  await detail.onLoad({ id: order.id });
  detail.onAddShipment();
  detail.data.shipmentEditor.trackingNo =
    "PAGE" + order.id.replaceAll("-", "").slice(0, 20);
  await detail.onSaveShipment();
  assert.equal(detail.data.detail.status, "in_transit");
  assert.equal(detail.data.detail.shipments.length, 1);
  const shipmentId = detail.data.detail.shipments[0].id;
  list = await boss.purchase.list({
    keyword: detail.data.detail.shipments[0].trackingNo,
    supplierId: supplier.id,
  });
  assert.equal(list.list[0].id, order.id);
  assert.equal(list.summary.inTransitQty, 2);
  // 框架文档 十三.4：首期只手动录入运单号，页面不提供轨迹查询
  assert.equal(detail.onTrack, undefined);
  assert.match(
    (await f.api("GET", `/shipments/${shipmentId}/tracks`)).message,
    /首期不提供/,
  );
  await detail.onReceive({ currentTarget: { dataset: { id: shipmentId } } });
  assert.equal(detail.data.detail.status, "arrived");
  assert.equal(detail.confirmations.at(-1).needReason, true);
  assert.equal(
    (
      await f.api(
        "GET",
        "/purchase-orders?supplierId=" + supplier.id,
        undefined,
        "warehouse",
      )
    ).status,
    403,
  );
  purchase.onUnload();
  edit.onUnload();
});
test("库管逐台页面：数量校验、内部凭证、提交丢失后的原样重试、异常复验", async () => {
  const acceptance = page(
    staff + "acceptance/index.js",
    warehouse,
    "warehouse",
  );
  await acceptance.onLoad({ poId: order.id });
  assert.equal(acceptance.data.form.lines[0].unitCost, undefined);
  assert.equal(acceptance.data.form.supplierId, undefined);
  const receipt = await f.upload("internal", "warehouse");
  const line = acceptance.data.form.lines[0];
  acceptance.data.lineIndex = 0;
  await acceptance.onAdd();
  assert.equal(
    acceptance.data.fields.some((f) => f.key === "supplier"),
    false,
  );
  const code = imei();
  Object.assign(acceptance.data.editor, {
    imei1: code,
    result: "pass",
    retail: "1300",
    wholesale: "1200",
    agentBase: "1200",
    checksConfirmed: true,
    attributes: attributes(template, receipt),
  });
  delete acceptance.data.editor.attributes.supplier;
  acceptance.data.busy = 1;
  acceptance.onSaveEditor();
  assert.equal(acceptance.data.items.length, 0);
  acceptance.data.busy = 0;
  acceptance.onSaveEditor();
  assert.equal(acceptance.data.items.length, 1);
  acceptance.data.declaredCount = "2";
  await acceptance.onSubmit();
  assert.match(acceptance.notices.at(-1), /数量/);
  assert.equal(acceptance.confirmations.length, 0);
  acceptance.data.declaredCount = "1";
  await acceptance.onSubmit();
  assert.match(acceptance.notices.at(-1), /分批/);
  assert.equal(acceptance.confirmations.length, 0);
  acceptance.data.lineIndex = 1;
  await acceptance.onAdd();
  const failedCode = imei();
  Object.assign(acceptance.data.editor, {
    imei1: failedCode,
    result: "fail",
    remark: "合成测试外观异常",
    observedModel: "合成实机型号说明",
    attributes: { receipt: [{ fileId: receipt.fileId }] },
  });
  acceptance.onSaveEditor();
  acceptance.data.declaredCount = "2";
  const originalSubmit = warehouse.purchase.submitAcceptance,
    sent = [];
  warehouse.purchase.submitAcceptance = async (id, body) => {
    sent.push(JSON.parse(JSON.stringify(body)));
    const result = await originalSubmit(id, body);
    if (sent.length === 1)
      throw Object.assign(new Error("合成测试：提交已到达，响应丢失"), {
        code: -1,
      });
    return result;
  };
  await acceptance.onSubmit();
  assert.ok(acceptance.data.pending);
  assert.equal(acceptance.data.result, null);
  assert.equal(acceptance.data.submitting, false);
  const key = acceptance.data.pending.requestKey;
  assert.equal(acceptance.data.pending.items[0].cost, undefined);
  assert.equal(acceptance.data.pending.items[0].attributes.supplier, undefined);
  await acceptance.onRetry();
  assert.equal(sent[1].requestKey, key);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(acceptance.data.pending, null);
  assert.equal(acceptance.data.result.accepted, 1);
  assert.equal(acceptance.data.result.rejected, 1);
  let persisted = await warehouse.purchase.detail(order.id);
  assert.equal(
    persisted.lines.reduce((n, l) => n + l.received, 0),
    2,
  );
  assert.equal(
    persisted.lines.reduce((n, l) => n + l.accepted, 0),
    1,
  );
  assert.equal(persisted.status, "exception");
  const record = await one(f.pool, "SELECT * FROM units WHERE imei1=?", [code]);
  assert.equal(Number(record.cost), 1000.12);
  assert.equal(record.supplier_id, supplier.id);
  assert.equal(record.share_flags.showInShop, false);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM units WHERE purchase_line_id=?",
          [line.id],
        )
      ).n,
    ),
    1,
  );
  const failed = persisted.exceptions[0];
  assert.equal(failed.observedModel, "合成实机型号说明");
  const reinspect = page(staff + "acceptance/index.js", warehouse, "warehouse");
  await reinspect.onLoad({ poId: order.id, exceptionId: failed.id });
  assert.equal(reinspect.data.editor.imei1, failedCode);
  Object.assign(reinspect.data.editor, {
    retail: "1400",
    wholesale: "1300",
    agentBase: "1300",
    checksConfirmed: true,
    attributes: attributes(template, receipt),
  });
  reinspect.data.resolutionReason = "合成测试复验通过";
  await reinspect.onReinspect();
  assert.equal(reinspect.data.result.accepted, 1, reinspect.data.error);
  persisted = await warehouse.purchase.detail(order.id);
  assert.equal(persisted.status, "completed");
  assert.equal(
    persisted.lines.reduce((n, l) => n + l.received, 0),
    2,
  );
  assert.equal(
    persisted.lines.reduce((n, l) => n + l.accepted, 0),
    2,
  );
  assert.equal(
    (
      await one(f.pool, "SELECT imei1 FROM units WHERE id=?", [
        reinspect.data.result.unitIds[0],
      ])
    ).imei1,
    failedCode,
  );
});
