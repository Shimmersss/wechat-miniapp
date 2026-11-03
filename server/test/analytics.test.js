const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers"),
  { client, page } = require("./page-helpers"),
  { one } = require("../src/db");
const { hmac } = require("../src/core");
let f, boss;
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
});
test.after(async () => {
  await f?.close();
});
test("访问实际落库：匿名摘要、去重、忽略员工路径/额外敏感字段、客户端时间不可信", async () => {
  const vid = "visitor_fixture_" + Date.now(),
    events = [
      {
        eventId: "evt_fixture_a",
        type: "pv",
        route: "pages/shop/index",
        ts: 0,
        secret: "不应保存",
      },
      {
        eventId: "evt_fixture_b",
        type: "pv",
        route: "packages/staff/stats/index",
      },
      { eventId: "evt_fixture_c", type: "event", name: "consult_click" },
    ];
  let r = await f.api(
    "POST",
    "/visits/batch",
    { visitorId: vid, events },
    null,
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.accepted, 2);
  r = await f.api("POST", "/visits/batch", { visitorId: vid, events }, null);
  assert.equal(r.data.accepted, 0);
  const key = hmac(f.cfg.otpKey, "visitor:" + vid),
    stored = await one(
      f.pool,
      "SELECT * FROM visit_events WHERE visitor_hash=? ORDER BY event_id",
      [key],
    );
  assert.equal(stored.visitor_hash, key);
  assert.equal(stored.secret, undefined);
  assert.equal(stored.route, "pages/shop/index");
  assert.ok(
    Math.abs(Date.now() - new Date(stored.created_at).getTime()) < 10000,
  );
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM visit_events WHERE visitor_hash=?",
          [key],
        )
      ).n,
    ),
    2,
  );
  const visits = await boss.stats.visits({ range: "day" });
  assert.ok(visits.uv >= 1);
  assert.ok(visits.consultClicks >= 1);
  assert.equal(typeof visits.consults, "number");
  assert.equal(
    (await f.api("GET", "/stats/visits", undefined, "customer")).status,
    403,
  );
  const empty = await boss.stats.visitTrend({
    from: "2090-01-01",
    to: "2090-01-03",
  });
  assert.equal(empty.list.length, 3);
  assert.ok(empty.list.every((r) => r.uv === 0));
});
test("工作台真实汇总/敏感裁剪，统计页面读取销售访问趋势和库龄", async () => {
  const dash = await f.api("GET", "/staff/dashboard");
  assert.equal(dash.status, 200);
  assert.equal(typeof dash.data.inventory.inStock, "number");
  assert.equal(typeof dash.data.sales.qty, "number");
  const sales = await f.api("GET", "/staff/dashboard", undefined, "sales");
  assert.equal(sales.status, 200);
  assert.equal(sales.data.sales.profit, undefined);
  assert.equal(sales.data.inventory.stockCost, undefined);
  assert.equal(
    (await f.api("GET", "/staff/dashboard", undefined, "customer")).status,
    403,
  );
  const p = page("miniprogram/packages/staff/stats/index.js", boss);
  await p.onLoad();
  assert.equal(p.data.error, "");
  assert.ok(p.data.overview);
  assert.ok(p.data.visits);
  assert.equal(p.data.chartRows.length, 1);
  p.onMetric({ currentTarget: { dataset: { value: "uv" } } });
  assert.equal(typeof p.data.chartRows[0].chartValue, "number");
  p.data.range = "week";
  await p.load();
  assert.equal(p.data.error, "");
  assert.ok(p.data.trend.length <= 7);
  p.data.dimension = "staff";
  await p.load();
  assert.equal(p.data.error, "");
});
