const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers"),
  { client, page } = require("./page-helpers");
let f, boss, sales, code, unitId, secondId, order;
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
  sales = client(f, "sales");
  const model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "收银页面_" + Date.now(),
      brandLabel: "验证",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const template = await boss.template.detail(model.templateId),
    receipt = await f.upload(),
    supplier = (
      await f.api("POST", "/suppliers", { name: "收银货源_" + Date.now() })
    ).data;
  code = imei();
  unitId = (
    await boss.inbound.createUnit({
      modelId: model.id,
      templateVersion: template.version,
      supplierId: supplier.id,
      inspectionConfirmed: true,
      attributes: attributes(template, receipt),
      imei1: code,
      cost: "1000.12",
      retail: "1300.58",
      wholesale: "1200.25",
      agentBase: "1200.25",
      flags: { showInShop: true },
    })
  ).id;
  secondId = (
    await boss.inbound.createUnit({
      modelId: model.id,
      templateVersion: template.version,
      supplierId: supplier.id,
      inspectionConfirmed: true,
      attributes: attributes(template, receipt),
      imei1: imei(),
      cost: "900",
      retail: "1100",
      wholesale: "1000",
      agentBase: "1000",
      flags: { showInShop: true },
    })
  ).id;
});
test.after(async () => {
  await f?.close();
});
test("手动出库：库存多选在库设备进入收银单，在库汇总按角色裁剪成本", async () => {
  const pos = page("miniprogram/packages/staff/pos/index.js", sales);
  await pos.onLoad({});
  const list = page("miniprogram/packages/staff/inventory/list.js", sales);
  await list.onLoad({ pick: "pos" });
  assert.equal(list.data.picking, true);
  assert.equal(list.data.activeFilter, "in_stock");
  assert.ok(list.data.summary.inStock >= 1);
  assert.equal(typeof list.data.summary.retailTotal, "number");
  assert.equal(list.data.summary.costTotal, undefined);
  const owner = page("miniprogram/packages/staff/inventory/list.js", boss);
  await owner.onLoad({});
  assert.equal(typeof owner.data.summary.costTotal, "number");
  list.data.keyword = code;
  await list.onSearch();
  assert.equal(list.data.list[0].id, unitId);
  list.onItemTap({
    currentTarget: { dataset: { id: "sold_unit", status: "sold" } },
  });
  assert.ok(list.notices.includes("仅在库设备可出库"));
  list.onItemTap({
    currentTarget: { dataset: { id: unitId, status: "in_stock" } },
  });
  assert.equal(list.data.selectedCount, 1);
  list.onConfirmPick();
  assert.equal(list.navigation.at(-1), "back");
  for (let i = 0; i < 100 && !pos.data.quote; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    pos.data.cart.map((u) => u.id),
    [unitId],
  );
  assert.ok(pos.data.quote);
  await pos.addUnits([unitId, "不存在的设备"]);
  assert.equal(pos.data.cart.length, 1);
  assert.match(pos.data.error, /不存在的设备/);
  pos.onUnload();
  list.onUnload();
  owner.onUnload();
});
test("手动出库：库存页多选两台直接进收银，按微信传入的编码参数逐台带入", async () => {
  const list = page("miniprogram/packages/staff/inventory/list.js", sales);
  await list.onLoad({});
  await list.onStartPick();
  for (const id of [unitId, secondId])
    list.onItemTap({ currentTarget: { dataset: { id, status: "in_stock" } } });
  list.onConfirmPick();
  const go = list.navigation.at(-1);
  assert.equal(go.route, "/packages/staff/pos/index");
  const pos = page("miniprogram/packages/staff/pos/index.js", sales);
  await pos.onLoad({ unitIds: encodeURIComponent(go.query.unitIds) });
  assert.equal(pos.data.error, "");
  assert.deepEqual(
    pos.data.cart.map((u) => u.id).sort(),
    [unitId, secondId].sort(),
  );
  assert.ok(pos.data.quote);
  pos.onUnload();
  list.onUnload();
});

test("收银页面经真实API报价、成交原因、响应丢失后原样重试不重复扣库", async () => {
  const p = page("miniprogram/packages/staff/pos/index.js", boss);
  p.onLoad({});
  p.data.code = code;
  await p.onAdd();
  assert.equal(p.data.total, 1300.58);
  p.onPrice({
    currentTarget: { dataset: { id: unitId } },
    detail: { value: "1250.25" },
  });
  assert.equal(p.data.quote, null);
  await p.onCheckout();
  assert.match(p.notices.at(-1), /报价/);
  await p.onQuote();
  assert.equal(p.data.total, 1250.25);
  const original = boss.sales.create,
    requests = [];
  boss.sales.create = async (payload) => {
    requests.push(JSON.parse(JSON.stringify(payload)));
    const r = await original(payload);
    if (requests.length === 1)
      throw Object.assign(new Error("合成响应丢失"), { code: -1 });
    return r;
  };
  p.data.customer = "验证顾客";
  await p.onCheckout();
  assert.ok(p.data.pending);
  assert.equal(p.confirmations.at(-1).needReason, true);
  p.onRemove({ currentTarget: { dataset: { id: unitId } } });
  assert.equal(p.data.cart.length, 1);
  await p.onRetry();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(p.data.pending, null);
  order = p.data.order;
  assert.equal(order.amount, 1250.25);
  assert.equal(order.customer, "验证顾客");
  assert.equal((await boss.inventory.detail(unitId)).status, "sold");
  assert.equal((await boss.sales.list({ keyword: order.no })).total, 1);
  p.onUnload();
});
test("退款页面逐台选择、差价金额/原因、响应丢失重试和退货进入复检", async () => {
  const s = page("miniprogram/packages/staff/sales/detail.js", sales, "sales");
  await s.onLoad({ id: order.id });
  assert.equal(s.data.canRefund, false);
  assert.equal(s.data.detail.profit, undefined);
  s.onRefund();
  assert.equal(s.data.editor, null);
  const p = page("miniprogram/packages/staff/sales/detail.js", boss);
  await p.onLoad({ id: order.id });
  assert.equal(p.data.detail.status, "paid");
  assert.equal(p.data.detail.items[0].returnable, true);
  p.onRefund();
  p.onKind({ currentTarget: { dataset: { value: "adjustment" } } });
  const item = p.data.editor.items[0];
  p.onItem({
    currentTarget: { dataset: { id: item.id } },
    detail: { value: true },
  });
  await p.onSubmitRefund();
  assert.match(p.notices.at(-1), /有效退款/);
  p.onAmount({
    currentTarget: { dataset: { id: item.id } },
    detail: { value: "50.25" },
  });
  const original = boss.sales.refund,
    requests = [];
  boss.sales.refund = async (id, payload) => {
    requests.push(JSON.parse(JSON.stringify(payload)));
    const r = await original(id, payload);
    if (requests.length === 1)
      throw Object.assign(new Error("合成响应丢失"), { code: -1 });
    return r;
  };
  await p.onSubmitRefund();
  assert.ok(p.data.pending);
  await p.onRetry();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(p.data.detail.netAmount, 1200);
  assert.equal(p.data.detail.refunds.length, 1);
  p.onRefund();
  p.onItem({
    currentTarget: { dataset: { id: item.id } },
    detail: { value: true },
  });
  await p.onSubmitRefund();
  assert.equal(p.data.detail.status, "refunded");
  assert.equal(p.data.detail.netAmount, 0);
  assert.equal(p.data.detail.profit, 0);
  assert.equal((await boss.inventory.detail(unitId)).status, "recheck");
  assert.equal(p.confirmations.at(-1).needReason, true);
});
