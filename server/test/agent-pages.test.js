const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers"),
  { client, page } = require("./page-helpers");
const pkg = "miniprogram/packages/";
let f, boss, agent, unitId;
test.before(async () => {
  f = await fixture(["boss", "sales", "finance", "customer", "customer:b"]);
  boss = client(f, "boss");
  agent = client(f, "customer");
  const model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "代理页面_" + Date.now(),
      brandLabel: "代理",
      series: "页面",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const t = await boss.template.detail(model.templateId),
    proof = await f.upload(),
    s = (
      await f.api("POST", "/suppliers", { name: "代理页面货源_" + Date.now() })
    ).data;
  unitId = (
    await boss.inbound.createUnit({
      modelId: model.id,
      templateVersion: t.version,
      supplierId: s.id,
      attributes: attributes(t, proof),
      inspectionConfirmed: true,
      imei1: imei(),
      cost: "900",
      retail: "1300",
      wholesale: "1150",
      agentBase: "1100",
      flags: { showInShop: true, sharePeer: false, shareAgent: true },
    })
  ).id;
});
test.after(async () => f?.close());

test("代理页面：申请 → 门店审核设上限 → 加价 → 链接下单 → 代理订单页 → 收银按分享价成交 → 收益转账页", async () => {
  const apply = page(pkg + "agent/apply/index.js", agent, "customer");
  await apply.onLoad({});
  assert.equal(apply.data.me.status, "none");
  Object.assign(apply.data.form, {
    name: "页面代理",
    phone: "13800000031",
    region: ["广东省", "深圳市", "南山区"],
  });
  await apply.onSubmit();
  assert.match(apply.notices.at(-1), /代理协议/);
  apply.onAgree();
  await apply.onSubmit();
  assert.equal(apply.data.me.status, "pending");

  const review = page(pkg + "staff/agents/review.js", boss);
  await review.onLoad({});
  assert.ok(review.data.list.some((a) => a.id === f.users.customer));
  review.data.drafts[f.users.customer] = "250";
  await review.onReview({
    currentTarget: { dataset: { id: f.users.customer, approve: "1" } },
  });
  assert.equal(review.data.error, "");
  assert.equal(review.confirmations.at(-1).needReason, true);
  const me = await agent.agent.me();
  assert.equal(me.status, "active");
  assert.equal(me.markupMax, 250);

  const markup = page(pkg + "agent/markup/index.js", agent, "customer");
  await markup.onLoad({ unitId });
  const index = markup.data.units.findIndex((u) => u.id === unitId);
  markup.data.drafts[unitId] = "300";
  await markup.onSave({ currentTarget: { dataset: { id: unitId, index } } });
  assert.match(markup.notices.at(-1), /上限/);
  markup.data.drafts[unitId] = "180";
  await markup.onSave({ currentTarget: { dataset: { id: unitId, index } } });
  assert.equal(markup.data.units[index].sharePrice, 1280);

  const share = await agent.share.createLink({
    channel: "agent",
    unitIds: [unitId],
  });
  const placed = await f.api(
    "POST",
    "/shop/orders",
    {
      requestKey: "page_order_" + Date.now(),
      unitId,
      name: "页面顾客",
      phone: "13900000031",
    },
    "customer:b",
    { "X-Channel": share.shareId },
  );
  assert.equal(placed.status, 200);

  const center = page(pkg + "agent/center/index.js", agent, "customer");
  await center.onShow();
  assert.equal(center.data.overview.lockedOrders, 1);
  const orders = page(pkg + "staff/agents/orders.js", boss);
  orders.onLoad({});
  await orders.onShow();
  const row = orders.data.list.find((o) => o.id === placed.data.id);
  assert.equal(row.markup, 180);
  orders.onOpen({ currentTarget: { dataset: { id: row.id } } });
  assert.equal(orders.navigation.at(-1).query.id, row.id);

  const sales = client(f, "sales"),
    pos = page(pkg + "staff/pos/index.js", sales, "sales");
  await pos.onLoad({ customerRequestId: placed.data.id });
  assert.equal(pos.data.error, "");
  assert.equal(pos.data.cart[0].channel, "agent");
  assert.equal(pos.data.total, 1280);
  pos.data.cart[0].price = "1000";
  await pos.requote();
  assert.match(pos.data.error, /不能改价/);
  pos.data.cart[0].price = "";
  await pos.requote();
  await pos.onCheckout();
  assert.equal(pos.data.error, "");
  assert.equal(pos.data.order.amount, 1280);
  pos.onUnload();

  const finance = client(f, "finance"),
    settle = page(pkg + "staff/agents/settlement.js", finance, "finance");
  await settle.onLoad({});
  const earning = settle.data.list.find((e) => e.agentName === "页面代理");
  assert.equal(earning.amount, 180);
  settle.onToggle({ currentTarget: { dataset: { id: earning.id } } });
  assert.equal(settle.data.selectedAmount, 180);
  await settle.onSettle();
  assert.equal(settle.data.error, "");
  const mine = page(pkg + "agent/commission/index.js", agent, "customer");
  await mine.onLoad({});
  assert.equal(mine.data.summary.settledAmount, 180);
});
