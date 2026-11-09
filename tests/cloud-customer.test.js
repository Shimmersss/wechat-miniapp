const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  path = require("node:path");
const app = require("../miniprogram/app.json"),
  paths = app.pages
    .filter((p) => p !== "pages/login/index")
    .concat(
      app.subPackages
        .filter((s) => s.name !== "staff")
        .flatMap((s) => s.pages.map((p) => s.root + "/" + p)),
    );
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk") return { init() {}, getWXContext: () => ({}) };
  if (
    args[0]?.filename.startsWith(
      path.join(__dirname, "../cloudfunctions/common/"),
    )
  ) {
    if (name === "./analytics-routes.json") return paths;
    for (const k of [
      "roles",
      "status",
      "customer-requests",
      "template",
      "validate",
    ])
      if (name === "./" + k)
        return load.call(
          this,
          path.join(
            __dirname,
            "../miniprogram",
            ["roles", "status", "customer-requests"].includes(k)
              ? "constants"
              : "utils",
            k,
          ),
          ...args,
        );
  }
  return load.call(this, name, ...args);
};
const input = require("../cloudfunctions/common/request-input"),
  visits = require("../cloudfunctions/common/visit-input"),
  { request } = require("../cloudfunctions/common/request-view");
Module._load = load;
const id = "00000000-0000-0000-0000-000000000001",
  body = {
    requestKey: "customer-test",
    unitId: id,
    phone: "19900000001",
    content: "咨询电池情况",
  };
test("云普通意向允许无设备咨询，拒绝价格与伪造来源，摘要保留旧端字段顺序", () => {
  const d = input.prepare("consult.create", body, {}, {}).d;
  assert.equal(d.name, "");
  assert.equal(
    input.prepare("consult.create", { ...body, unitId: undefined }, {}).d
      .unitId,
    null,
  );
  for (const more of [{ price: 1 }, { source: "agent" }, { shareOwnerId: id }])
    assert.throws(() =>
      input.prepare("consult.create", { ...body, ...more }, {}),
    );
  assert.notEqual(
    d.signature,
    input.prepare(
      "consult.create",
      body,
      {},
      { "X-Channel": "abcdefghijklmnop" },
    ).d.signature,
  );
  assert.equal(
    d.signature,
    input.prepare(
      "consult.create",
      Object.fromEntries(Object.entries(body).reverse()),
      {},
    ).d.signature,
  );
});
test("云预约验证真实日期、姓名、处理版本；选项按北京时间跨日并校验配置", () => {
  for (const date of ["2026-02-30", "2026-99-99"])
    assert.throws(() =>
      input.prepare(
        "appointment.create",
        { ...body, name: "顾客", date, timeSlot: "上午" },
        {},
      ),
    );
  assert.throws(() =>
    input.prepare(
      "appointment.create",
      { ...body, date: "2026-11-09", timeSlot: "上午" },
      {},
    ),
  );
  assert.throws(() =>
    input.prepare("cancel", { reason: "取消", requestKey: "test" }, { id }),
  );
  const o = input.options(
    { valid: true, days: 30, slots: ["上午"] },
    new Date("2026-11-09T16:01:00Z"),
  );
  assert.equal(o.minDate, "2026-11-10");
  assert.equal(o.maxDate, "2026-12-10");
  assert.throws(() => input.options({ valid: false }));
  const old = process.env.APPOINTMENT_SLOTS;
  try {
    process.env.APPOINTMENT_SLOTS = '{"wrong":true}';
    assert.equal(input.config().valid, false);
  } finally {
    if (old === undefined) delete process.env.APPOINTMENT_SLOTS;
    else process.env.APPOINTMENT_SLOTS = old;
  }
});
test("云普通预约按状态返回操作；同行资格丢失后历史快照只留三项，内部跟进备注不给顾客", () => {
  const row = {
    id,
    kind: "appointment",
    status: "confirmed",
    unit_id: id,
    version: 2,
    phone: "19900000001",
    source: "peer",
    unit_status: "in_stock",
    unit_ownership: "own",
    unit_snapshot: {
      id,
      name: "设备",
      imei_masked: "35****0006",
      price: 1200,
      attributes: {},
      template_snapshot: { fields: [] },
      attached: [],
      cost: 1000,
      imei1: "350000000000006",
    },
    events: [{ id, actor_kind: "staff", note: "内部内容" }],
  };
  const own = request(
    row,
    { role: "customer", permissions: [], visibleFields: [] },
    false,
  );
  assert.deepEqual(own.unit, { id, name: "设备", imeiMasked: "35****0006" });
  assert.equal(own.canCancel, true);
  assert.equal(own.timeline[0].note, undefined);
  assert.equal(own.shareOwnerId, undefined);
  assert.equal(own.agentOrder, undefined);
  const staff = request(
    row,
    {
      role: "sales",
      staffNo: id,
      permissions: ["consult:manage", "sales:create"],
      visibleFields: [],
    },
    true,
  );
  assert.deepEqual(staff.actions, ["completed", "cancelled"]);
  assert.equal(staff.canStartSale, true);
  assert.equal(staff.unit.price, undefined);
  assert.equal(staff.timeline[0].note, "内部内容");
});
test("云访问上报只保留白名单事件字段，以服务端HMAC隐藏匿名标识", () => {
  const old = process.env.OTP_HASH_KEY;
  process.env.OTP_HASH_KEY = "unit-test-hmac-key";
  try {
    const d = visits.prepare(
      {
        visitorId: "visitor_test_123",
        events: [
          {
            eventId: "event_test_001",
            type: "pv",
            route: "/pages/shop/index",
            ts: 0,
            phone: "19900000001",
            source: "agent",
          },
          {
            eventId: "event_test_002",
            type: "pv",
            route: "packages/staff/stats/index",
          },
          { eventId: "event_test_003", type: "event", name: "unknown" },
        ],
      },
      {},
    );
    assert.equal(d.total, 3);
    assert.equal(d.events.length, 1);
    assert.equal(d.visitorHash.length, 64);
    assert.equal(d.shareId, null);
    for (const k of ["ts", "phone", "source", "visitorId"])
      assert.equal(d.events[0][k], undefined);
    assert.equal(d.events[0].route, "pages/shop/index");
    assert.throws(() =>
      visits.prepare(
        {
          visitorId: "visitor_test_123",
          events: [
            { eventId: "event_test_001", type: "event", name: "share" },
            { eventId: "bad", type: "bad" },
          ],
        },
        {},
      ),
    );
  } finally {
    if (old === undefined) delete process.env.OTP_HASH_KEY;
    else process.env.OTP_HASH_KEY = old;
  }
});
