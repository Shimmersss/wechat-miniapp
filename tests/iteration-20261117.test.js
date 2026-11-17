const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
let role = "boss";
const storage = new Map();
global.wx = {
  getStorageSync: (k) => (k === "xm_mock_role" ? role : storage.get(k)),
  setStorageSync: (k, v) => storage.set(k, v),
  removeStorageSync: (k) => storage.delete(k),
};
const mock = require("../miniprogram/mock");
const db = require("../miniprogram/mock/data");
const {
  ROLE_PERMISSIONS,
  defaultVisibleFields,
} = require("../miniprogram/constants/roles");
const {
  nextAttributes,
  preferences,
  keyFor,
} = require("../miniprogram/packages/staff/inbound/repeat");
const { productInfo } = require("../miniprogram/utils/product-info");
const schema = require("../miniprogram/utils/template");
const call = (url, method = "GET", data = {}) =>
  mock.handle({ url, method, data });
let seq = 0;
const key = () => `iteration_${++seq}`;
async function create(kind = "external", unitId) {
  role = "boss";
  const r = await call("/repair-orders", "POST", {
    requestKey: key(),
    kind,
    ...(unitId
      ? { unitId }
      : { model: "验证手机", customer: "验证顾客", phone: "13800000001" }),
    fault: "维修测试",
    engineerId: "mock_engineer",
  });
  assert.equal(r.code, 0, r.message);
  return r.data;
}
async function close(o, amount = "0", extra = {}) {
  return call(`/repair-orders/${o.id}/close`, "POST", {
    requestKey: key(),
    version: o.version,
    reason: "已实际结单",
    amount,
    method: "微信",
    confirmed: true,
    ...extra,
  });
}
test("定价：单项、三项、代理随批发、旧利润和精度/上限校验", async () => {
  for (const [input, expected] of [
    [
      { cost: "4000", retailProfit: "600" },
      { retail: 4600, retailProfit: 600 },
    ],
    [
      { cost: "4000", retailProfit: 600, wholesaleProfit: 300 },
      {
        retail: 4600,
        retailProfit: 600,
        wholesale: 4300,
        wholesaleProfit: 300,
        agentBase: 4300,
        agentProfit: 300,
      },
    ],
    [
      {
        cost: "0.10",
        retailProfit: "0.20",
        wholesaleProfit: "0.10",
        agentProfit: 0,
      },
      {
        retail: 0.3,
        retailProfit: 0.2,
        wholesale: 0.2,
        wholesaleProfit: 0.1,
        agentBase: 0.1,
        agentProfit: 0,
      },
    ],
    [
      { cost: "4000", targetProfit: 600 },
      {
        retail: 4600,
        retailProfit: 600,
        wholesale: 4600,
        wholesaleProfit: 600,
        agentBase: 4600,
        agentProfit: 600,
      },
    ],
  ]) {
    const r = await call("/pricing/suggest", "POST", input);
    assert.equal(r.code, 0, r.message);
    assert.deepEqual(r.data, expected);
  }
  assert.equal(
    (await call("/pricing/suggest", "POST", { cost: 1, retailProfit: -1 }))
      .code,
    400,
  );
  assert.equal(
    (
      await call("/pricing/suggest", "POST", {
        cost: "999999999999.99",
        retailProfit: 0.01,
      })
    ).code,
    400,
  );
});
test("成色自定义校验支持回显、空白及长度限制", () => {
  const f = db.templates
    .find((t) => t.category === "phone")
    .fields.find((f) => f.key === "grade");
  assert.equal(f.allowCustom, true);
  assert.ok(f.options.includes("8成新"));
  assert.equal(schema.validateValues([f], { grade: " 7成新 屏有划痕 " }), "");
  assert.match(schema.validateValues([f], { grade: " " }), /请填写/);
  assert.match(schema.validateValues([f], { grade: "一".repeat(11) }), /有效/);
  assert.match(
    schema.validateValues([{ ...f, allowCustom: false }], { grade: "7成新" }),
    /有效/,
  );
});
test("再入同款只清电池、串码和所有图片，保留规格、成色及文本", () => {
  const fields = [
    { key: "battery", type: "number" },
    { key: "grade", type: "select" },
    { key: "receipt", type: "image" },
    { key: "customImage", type: "image" },
    { key: "storage", type: "select" },
  ];
  const previous = {
    battery: 95,
    grade: "8成新",
    storage: "128G",
    receipt: [{ fileId: "a" }],
    customImage: [{ fileId: "b" }],
    color: "黑色",
  };
  assert.deepEqual(nextAttributes(fields, previous), {
    battery: "",
    grade: "8成新",
    storage: "128G",
    receipt: [],
    customImage: [],
    color: "黑色",
  });
  assert.equal(previous.battery, 95);
  assert.equal(previous.receipt.length, 1);
});
test("常用值按账号/分类隔离，不记忆价格，无供应商权限不记忆供应商", () => {
  const user = (id) => ({
    id,
    role: "boss",
    staffNo: id,
    permissions: ROLE_PERMISSIONS.boss,
    visibleFields: defaultVisibleFields("boss"),
  });
  assert.notEqual(keyFor(user("a"), "phone"), keyFor(user("b"), "phone"));
  assert.notEqual(keyFor(user("a"), "phone"), keyFor(user("a"), "tablet"));
  const saved = preferences(
    {
      store: "门店",
      shopWarranty: 90,
      warrantyLength: "90天",
      cost: 50,
      battery: 90,
    },
    { showInShop: true },
    "supplier",
    user("a"),
  );
  assert.deepEqual(saved.attributes, {
    store: "门店",
    shopWarranty: 90,
    warrantyLength: "90天",
  });
  assert.equal(saved.supplierId, "supplier");
  assert.equal(
    preferences({}, {}, "supplier", { ...user("a"), permissions: [] })
      .supplierId,
    undefined,
  );
});
test("公开信息过滤空值、保留0、不重复参数，不增敏感字段", () => {
  const info = productInfo({
    storage: "",
    grade: "8成新",
    battery: 0,
    warrantyDays: 0,
    desc: "第一行\n第二行",
    publicFields: [
      { key: "battery", value: 0 },
      { key: "shopWarranty", value: 0 },
      { key: "repairNote", value: "正常" },
    ],
  });
  assert.equal(info.subtitle, "8成新");
  assert.equal(info.info.find((x) => x.key === "battery").value, "0%");
  assert.deepEqual(info.publicFields, [{ key: "repairNote", value: "正常" }]);
  assert.equal(productInfo({}).subtitle, "");
});
test("外部维修开单即维修中，零元和有费用结单、幂等重试不重复收款", async () => {
  const free = await create();
  assert.equal(free.status, "repairing");
  assert.equal((await close(free)).data.status, "completed");
  const order = await create();
  const body = {
    requestKey: key(),
    version: order.version,
    reason: "已收款",
    amount: "100.01",
    cost: "20.02",
    method: "现金",
    confirmed: true,
    note: "已修复",
  };
  const url = `/repair-orders/${order.id}/close`;
  const a = await call(url, "POST", body),
    b = await call(url, "POST", body);
  assert.equal(a.code, 0, a.message);
  assert.equal(b.code, 0, b.message);
  assert.equal(a.data.received, 100.01);
  assert.equal(a.data.expenses, 20.02);
  assert.equal(a.data.payments.length, 2);
  assert.equal(b.data.payments.length, 2);
  role = "engineer";
  const publicOrder = (await call(`/repair-orders/${order.id}`)).data;
  assert.equal(publicOrder.expenses, undefined);
  assert.equal(
    publicOrder.payments.some((p) => p.kind === "expense"),
    false,
  );
  assert.equal(
    publicOrder.timeline.some((e) => e.costData),
    false,
  );
});
test("旧各中间状态都能结单，本店机结单进入待复检并关闭分享", async () => {
  for (const state of [
    "pending_check",
    "checking",
    "pending_confirm",
    "repairing",
    "pending_pickup",
  ]) {
    const o = await create();
    db.repairTransactions.find((x) => x.id === o.id).status = state;
    assert.equal((await close(o)).data.status, "completed");
  }
  const unit = db.units.find((u) => u.status === "in_stock");
  const o = await create("inventory", unit.id);
  assert.equal(unit.status, "repairing");
  const r = await close(o, "0", { cost: "12.30" });
  assert.equal(r.code, 0, r.message);
  assert.equal(unit.status, "recheck");
  assert.equal(unit.flags.showInShop, false);
});
test("无成本可见权的收款角色不能提交费用，取消前须退清", async () => {
  const o = await create();
  role = "sales";
  const denied = await close(o, "0", { cost: "1" });
  assert.equal(denied.code, 403);
  role = "boss";
  const raw = db.repairTransactions.find((x) => x.id === o.id);
  raw.payments.push({
    id: key(),
    kind: "receipt",
    cents: 100,
    method: "现金",
    time: new Date().toISOString(),
  });
  const cancelled = await call(`/repair-orders/${o.id}/transition`, "POST", {
    requestKey: key(),
    version: o.version,
    reason: "顾客取消",
    to: "cancelled",
  });
  assert.equal(cancelled.code, 409);
});
test("本机草稿待办按员工和权限过滤，角标按数量求和", () => {
  const drafts = require("../miniprogram/packages/staff/inbound/draft");
  const todos = require("../miniprogram/utils/dashboard-todos");
  const user = { id: "a", role: "boss", permissions: ROLE_PERMISSIONS.boss };
  storage.set(drafts.keyFor(user, false), { savedAt: 1 });
  const list = todos.withDrafts([{ key: "repairActive", count: 3 }], user);
  assert.equal(list[0].key, "inboundDraft");
  assert.match(list[0].url, /restore=1/);
  assert.equal(todos.total(list), 4);
  assert.equal(todos.withDrafts([], { ...user, id: "b" }).length, 0);
  assert.equal(todos.withDrafts([], { ...user, permissions: [] }).length, 0);
});
test("网关配置缺失直接报操作提示，网络错误区分域名/超时/未部署，永不回退wx.cloud", async () => {
  const config = {
    useCloud: true,
    env: "develop",
    storageKeys: {},
    timeout: 100,
    cloudHttpBaseUrl: "",
  };
  let calls = 0,
    detail = "";
  const context = {
    module: { exports: {} },
    console: { warn() {} },
    wx: {
      getStorageSync() {},
      cloud: {
        init() {
          throw Error("unexpected");
        },
      },
      request(o) {
        calls++;
        o.fail({ errMsg: detail });
      },
    },
    require: (name) =>
      name.includes("config")
        ? config
        : name === "./channel"
          ? { getHeaderValue() {} }
          : { emit() {} },
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../miniprogram/utils/request"), "utf8"),
    context,
  );
  const request = context.module.exports.request;
  await assert.rejects(
    request({ url: "/shop/units", showError: false }),
    /configure-cloud-preview/,
  );
  assert.equal(calls, 0);
  config.cloudHttpBaseUrl = "https://gateway.test";
  for (const [raw, expected] of [
    ["request:fail url not in domain list", /合法域名/],
    ["request:fail timeout", /超时/],
    ["-505005 FUNCTIONS_NOT_FOUND", /未部署/],
  ]) {
    detail = raw;
    await assert.rejects(
      request({ url: "/shop/units", showError: false }),
      expected,
    );
  }
});

test("部署目标必须同时匹配私有配置及网关环境，残缺元数据也拒绝", () => {
  const { verifyTarget } = require("../scripts/lib/deployment-target");
  assert.doesNotThrow(() =>
    verifyTarget(
      "gateway-env",
      { CLOUDBASE_ENV_ID: "gateway-env" },
      { envId: "gateway-env" },
    ),
  );
  assert.throws(
    () =>
      verifyTarget(
        "default-env",
        { CLOUDBASE_ENV_ID: "default-env" },
        { envId: "gateway-env" },
      ),
    /网关/,
  );
  assert.throws(
    () =>
      verifyTarget(
        "gateway-env",
        { CLOUDBASE_ENV_ID: "other" },
        { envId: "gateway-env" },
      ),
    /私有配置/,
  );
  assert.throws(
    () => verifyTarget("gateway-env", { CLOUDBASE_ENV_ID: "gateway-env" }, {}),
    /网关/,
  );
});

test("旧草稿利润恢复为零售利润，旧核对开关不再恢复", () => {
  const {
    restoredForm,
  } = require("../miniprogram/packages/staff/inbound/draft");
  const form = restoredForm(
    { targetProfit: "600", cost: "4000", inspectionConfirmed: true },
    { wholesaleProfit: "", agentProfit: "" },
  );
  assert.equal(form.retailProfit, "600");
  assert.equal(form.cost, "4000");
  assert.equal(form.targetProfit, undefined);
  assert.equal(form.inspectionConfirmed, undefined);
  assert.equal(
    restoredForm({ targetProfit: "600", retailProfit: "700" }).retailProfit,
    "700",
  );
});

test("维修待办随结单减少，未设预计日期的旧单7天后显示超期", async () => {
  const o = await create();
  db.repairTransactions.find((x) => x.id === o.id).createdAt = new Date(
    Date.now() - 9 * 86400000,
  ).toISOString();
  const before = (await call("/staff/dashboard")).data.todos.find(
    (t) => t.key === "repairActive",
  ).count;
  const board = (await call("/repair-orders/board", "GET", { overdue: "true" }))
    .data;
  assert.ok(board.columns.repairing.some((x) => x.id === o.id && x.overdue));
  const result = await close(o);
  assert.equal(result.code, 0, result.message);
  const after = (await call("/staff/dashboard")).data.todos.find(
    (t) => t.key === "repairActive",
  ).count;
  assert.equal(after, before - 1);
});

test("自定义单选自动回显，输入保留中间空格并在失焦时裁掉首尾空白", () => {
  let component;
  const events = [];
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../miniprogram/components/template-fields/index.js"),
      "utf8",
    ),
    { Component: (c) => (component = c), require: () => ({}), wx: {} },
  );
  const instance = {
    data: { custom: {}, values: { grade: "7成新" }, disabled: false },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, data) {
      events.push({ name, data });
    },
  };
  component.observers["fields, values"].call(
    instance,
    [{ key: "grade", type: "select", allowCustom: true, options: ["9成新"] }],
    instance.data.values,
  );
  assert.equal(instance.data.custom.grade, true);
  component.methods.customInput.call(instance, {
    currentTarget: { dataset: { key: "grade" } },
    detail: { value: "7成新 " },
  });
  assert.equal(events.at(-1).data.value, "7成新 ");
  component.methods.customBlur.call(instance, {
    currentTarget: { dataset: { key: "grade" } },
    detail: { value: " 7成新 屏花 " },
  });
  assert.equal(events.at(-1).data.value, "7成新 屏花");
});

test('mock登录下发字段可见权限，老板能选择供应商、销售仍不可见',async()=>{
 role='boss';const boss=(await call('/auth/wx-login','POST')).data.user;
 assert.ok(boss.visibleFields.includes('supplier'));
 role='sales';const sales=(await call('/auth/wx-login','POST')).data.user;
 assert.equal(sales.visibleFields.includes('supplier'),false);assert.equal(sales.visibleFields.includes('cost'),false);
 role='boss';
});
