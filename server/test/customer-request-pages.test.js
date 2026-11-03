const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client, page } = require("./page-helpers");
const { one } = require("../src/db");
let f,
  api,
  boss,
  unit,
  storage = new Map();
test.before(async () => {
  global.wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
  };
  f = await fixture();
  api = client(f, "customer");
  boss = client(f, "boss");
  const model = (
      await f.api("POST", "/models", {
        category: "phone",
        name: "咨询页面_" + Date.now(),
        brandLabel: "页面",
        series: "验证",
        copyTemplateId: "t_phone",
        tacs: [],
      })
    ).data,
    t = await boss.template.detail(model.templateId),
    receipt = await f.upload(),
    supplier = (
      await f.api("POST", "/suppliers", { name: "咨询页面货源_" + Date.now() })
    ).data;
  unit = (
    await boss.inbound.createUnit({
      modelId: model.id,
      templateVersion: t.version,
      supplierId: supplier.id,
      inspectionConfirmed: true,
      attributes: attributes(t, receipt),
      imei1: imei(),
      cost: "100",
      retail: "150.68",
      wholesale: "130",
      agentBase: "120",
      flags: { showInShop: true, sharePeer: true, shareAgent: false },
    })
  ).id;
});
test.after(async () => f?.close());
const input = (p, field, value) =>
  p.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
test("咨询与预约表单经真实API：日期时段、未知响应冻结、原来源原请求重试与本人记录", async () => {
  const share = await boss.share.createLink({
    unitId: unit,
    channel: "customer",
  });
  require("../../miniprogram/utils/channel").captureFromLaunch({
    query: { s: share.shareId },
  });
  const p = page("miniprogram/packages/shop/consult/index.js", api, "customer");
  await p.onLoad({ unitId: unit, mode: "appointment" });
  assert.equal(p.data.options.timeSlots.length, 3);
  input(p, "name", "页面顾客");
  input(p, "phone", "13800000001");
  input(p, "content", "预约核验本机");
  await p.onSubmit();
  assert.equal(p.data.result, null);
  assert.match(p.notices.at(-1), /日期/);
  input(p, "date", p.data.options.minDate);
  p.onSlot({ detail: { value: "0" } });
  const send = api.shop.appointment;
  let count = 0;
  api.shop.appointment = async (...args) => {
    const r = await send(...args);
    if (++count === 1)
      throw Object.assign(new Error("合成响应已保存但未收到"), { code: -1 });
    return r;
  };
  await p.onSubmit();
  assert.ok(p.data.pending);
  const key = p.data.pending.body.requestKey;
  input(p, "phone", "13800000002");
  assert.equal(p.data.form.phone, "13800000001");
  require("../../miniprogram/utils/channel").clear();
  await p.onRetry();
  assert.equal(p.data.pending, null);
  assert.equal(p.data.result.kind, "appointment");
  assert.equal(p.data.result.source, "customer");
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM customer_requests WHERE request_key=?",
          [key],
        )
      ).n,
    ),
    1,
  );
  const history = page(
    "miniprogram/packages/shop/requests/index.js",
    api,
    "customer",
  );
  await history.onLoad({});
  assert.ok(history.data.list.some((r) => r.id === p.data.result.id));
  history.onSelect({ currentTarget: { dataset: { id: p.data.result.id } } });
  assert.equal(history.navigation[0].query.id, p.data.result.id);
  api.shop.appointment = send;
});
test("员工跟进与本人取消页面：内部说明、版本冲突和原操作重试；意向开单接真实扣库归因", async () => {
  const created = await api.shop.consult(
    {
      requestKey: "page_follow_" + unit,
      unitId: unit,
      phone: "13800000001",
      content: "请联系我",
      name: "开单顾客",
    },
    "",
  );
  const detail = page("miniprogram/packages/staff/consults/detail.js", boss);
  await detail.onLoad({ id: created.id });
  assert.equal(detail.data.detail.canStartSale, true);
  const change = boss.customerRequest.updateStatus;
  let count = 0;
  boss.customerRequest.updateStatus = async (...args) => {
    const r = await change(...args);
    if (++count === 1)
      throw Object.assign(new Error("处理回执丢失"), { code: -1 });
    return r;
  };
  await detail.onChange();
  assert.ok(detail.data.pending);
  assert.equal(detail.confirmations[0].needReason, true);
  await detail.onRetry();
  assert.equal(detail.data.detail.status, "contacted");
  assert.equal(detail.data.pending, null);
  boss.customerRequest.updateStatus = change;
  const own = page(
    "miniprogram/packages/shop/requests/detail.js",
    api,
    "customer",
  );
  await own.onLoad({ id: created.id });
  assert.ok(!JSON.stringify(own.data.detail).includes("验证用人工处理说明"));
  detail.onSale();
  const pos = page("miniprogram/packages/staff/pos/index.js", boss);
  await pos.onLoad(detail.navigation[0].query);
  assert.equal(pos.data.cart.length, 1);
  assert.equal(pos.data.customer, "开单顾客");
  assert.equal(pos.data.customerRequestId, created.id);
  await pos.onCheckout();
  assert.ok(pos.data.order);
  assert.equal(pos.data.order.customerRequestId, created.id);
  await own.load();
  assert.equal(own.data.detail.saleRecorded, true);
  assert.equal(own.data.detail.canCancel, false);
  const general = await api.shop.consult(
    {
      requestKey: "page_cancel_" + unit,
      phone: "13800000001",
      content: "门店营业咨询",
    },
    "",
  );
  const cancel = page(
    "miniprogram/packages/shop/requests/detail.js",
    api,
    "customer",
  );
  await cancel.onLoad({ id: general.id });
  await cancel.onChange();
  assert.equal(cancel.data.detail.status, "cancelled");
});
