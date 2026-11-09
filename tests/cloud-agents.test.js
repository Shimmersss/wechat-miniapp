const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  path = require("node:path");
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk")
    return { init() {}, getWXContext: () => ({ OPENID: "test-platform" }) };
  if (
    args[0]?.filename.startsWith(
      path.join(__dirname, "../cloudfunctions/common/"),
    ) &&
    ["roles", "status", "template", "validate"].some((k) => name === "./" + k)
  ) {
    const k = name.slice(2);
    return original.call(
      this,
      path.join(
        __dirname,
        "../miniprogram",
        ["roles", "status"].includes(k) ? "constants" : "utils",
        k,
      ),
      ...args,
    );
  }
  return original.call(this, name, ...args);
};
const { prepare } = require("../cloudfunctions/common/agent-input"),
  { view, share } = require("../cloudfunctions/common/agent-view");
Module._load = original;
const id = "00000000-0000-0000-0000-000000000001",
  user = { permissions: ["sales:create"], visibleFields: [] };
test("云代理加价拒绝伪造分享价，转账强制原因并按编号去重排序", () => {
  assert.throws(() =>
    prepare("markup", { markup: 10, sharePrice: 1 }, { id }, user, {}),
  );
  assert.throws(() =>
    prepare("admin.settle", { ids: [id], reason: "" }, {}, user, {}),
  );
  const d = prepare(
    "admin.settle",
    { ids: [id, id], reason: "实际线下转账" },
    {},
    user,
    {},
  ).d;
  assert.deepEqual(d.ids, [id]);
  for (const markup of [-1, "NaN", "1.001"])
    assert.throws(() => prepare("markup", { markup }, { id }, user, {}));
});
test("云代理订单提交摘要绑定渠道与内容，拒绝前端价格", () => {
  const body = {
    unitId: id,
    name: "测试",
    phone: "19900000001",
    requestKey: "test",
  };
  const a = prepare("order.create", body, {}, user, {
    "X-Channel": "abcdefghijklmnop",
  }).d;
  assert.notEqual(
    a.signature,
    prepare("order.create", body, {}, user, { "X-Channel": "ponmlkjihgfedcba" })
      .d.signature,
  );
  assert.throws(() =>
    prepare("order.create", { ...body, price: 1 }, {}, user, {}),
  );
  assert.throws(() =>
    prepare(
      "order.cancel",
      { reason: "取消", requestKey: "test" },
      { id },
      user,
      {},
    ),
  );
});
const raw = {
  request_id: id,
  unit_id: id,
  agent_id: id,
  unit_snapshot: { name: "设备", cost: 999, imei1: "350000000000006" },
  lock_status: "sold",
  share_price: "1400",
  markup: "100",
  agent_base: "1300",
  customer_name: "测试顾客",
  customer_phone: "19900000001",
  sale_order_id: id,
};
test("云代理订单裁剪按用途区分，销售不可见底价与加价，代理顾客信息脱敏", () => {
  const d = { page: 1, pageSize: 20 },
    result = { rows: [raw], total: 1 };
  const own = view("orders", result, user, d).list[0];
  assert.equal(own.customerName, "测***");
  assert.equal(own.customerPhone, "199****0001");
  assert.equal(own.saleOrderId, undefined);
  const staff = view("admin.orders", result, user, d).list[0];
  assert.equal(staff.agentBase, undefined);
  assert.equal(staff.markup, undefined);
  assert.equal(staff.cost, undefined);
  assert.equal(staff.imei1, undefined);
  const boss = view(
    "admin.orders",
    result,
    { permissions: ["agent:settle"] },
    d,
  ).list[0];
  assert.equal(boss.agentBase, 1300);
  assert.equal(boss.markup, 100);
});
test("云代理冲回金额呈负数，自助收益不返回转账原因或销售内部编号", () => {
  const row = {
    ...raw,
    id,
    kind: "reversal",
    amount: "100",
    status: "pending",
    settle_reason: "内部原因",
  };
  const own = view("commissions", { rows: [row], total: 1 }, user, {
    page: 1,
    pageSize: 20,
  }).list[0];
  assert.equal(own.amount, -100);
  assert.equal(own.settleReason, undefined);
  assert.equal(own.saleOrderId, undefined);
});
test("云代理公开分享采用模板白名单，即使原始对象带敏感属性也不泄漏", () => {
  const unit = {
    id,
    attributes: {
      storage: "128G",
      cost: 999,
      imei1: "350000000000006",
      internalNote: "秘密",
    },
    template_snapshot: {
      fields: ["storage", "cost", "imei1", "internalNote"].map((key) => ({
        key,
        label: key,
        type: "text",
        visibility: ["customer"],
      })),
    },
    attached: [],
    price: 1400,
    cost: 999,
    imei1: "350000000000006",
    brand: "test",
  };
  const v = share({
    link: { id: "abcdefghijklmnop", channel: "agent" },
    units: [unit],
  });
  assert.equal(v.units[0].storage, "128G");
  for (const s of ["秘密", "350000000000006", "999"])
    assert.ok(!JSON.stringify(v).includes(s));
  assert.deepEqual(
    v.units[0].publicFields.map((f) => f.key),
    ["storage"],
  );
});
