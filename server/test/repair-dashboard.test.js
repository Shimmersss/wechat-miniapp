const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers"),
  { client, page } = require("./page-helpers");
let f,
  g,
  api,
  sequence = 0;
const key = () => "repair_dash_" + Date.now() + "_" + ++sequence;
const evt = (field, value) => ({
  currentTarget: { dataset: { [field]: value } },
});
async function create(engineerId, expectedAt = "2020-01-01") {
  return api.repair.create({
    requestKey: key(),
    kind: "external",
    model: "维修待办验证",
    customer: "测试联系人",
    phone: "13800000001",
    engineerId,
    expectedAt,
    fault: "检测异常",
  });
}
async function change(o, method, data) {
  return api.repair[method](o.id, {
    requestKey: key(),
    version: o.version,
    reason: "真实待办统计验证",
    ...data,
  });
}
test.before(async () => {
  f = await fixture(["boss", "engineer", "finance", "sales", "warehouse"]);
  g = await fixture(["engineer"]);
  api = client(f, "boss");
});
test.after(async () => {
  await f?.close();
  await g?.close();
});
test("维修待办按工程师范围和北京时间超期，点击可筛选，终态和今天到期不误报", async () => {
  let own = await create(f.users.engineer);
  own = await change(own, "transition", { to: "checking" });
  own = await change(own, "update", {
    diagnosis: "方案待确认",
    waitingParts: true,
  });
  own = await change(own, "quote", { amount: "100" });
  own = await change(own, "transition", { to: "pending_confirm" });
  const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10),
    dueToday = await create(f.users.engineer, today);
  let closed = await create(f.users.engineer);
  closed = await change(closed, "transition", { to: "cancelled" });
  const other = await create(g.users.engineer);
  const eng = client(f, "engineer"),
    dashboard = await eng.dashboard.overview(),
    todos = Object.fromEntries(dashboard.todos.map((t) => [t.key, t]));
  for (const key of ["repairOverdue", "repairConfirm", "repairParts"])
    assert.equal(todos[key].count, 1, key);
  assert.equal(dashboard.repair.created, 3);
  assert.equal(dashboard.repair.profit, undefined);
  assert.equal(dashboard.repair.partsCost, undefined);
  const board = page(
    "miniprogram/packages/staff/repair/board.js",
    eng,
    "engineer",
  );
  await board.onLoad({ overdue: "true" });
  await board.onShow();
  const items = board.data.columns.flatMap((c) => c.list);
  assert.deepEqual(
    items.map((i) => i.id),
    [own.id],
  );
  assert.ok(
    !items.some((i) => [dueToday.id, closed.id, other.id].includes(i.id)),
  );
  const wait = page(
    "miniprogram/packages/staff/repair/board.js",
    eng,
    "engineer",
  );
  await wait.onLoad({ status: "pending_confirm", waitingParts: "true" });
  await wait.onShow();
  assert.equal(wait.data.activeKey, "pending_confirm");
  assert.equal(wait.data.waitingParts, true);
  assert.equal(
    wait.data.columns.find((c) => c.key === "pending_confirm").list[0].id,
    own.id,
  );
  const bossList = await api.repair.list({
    overdue: "true",
    engineerId: g.users.engineer,
  });
  assert.ok(bossList.list.some((i) => i.id === other.id));
  assert.equal(
    (await client(f, "sales").dashboard.overview()).repair,
    undefined,
  );
  assert.ok(
    !(await client(f, "warehouse").dashboard.overview()).todos.some((t) =>
      t.key.startsWith("repair"),
    ),
  );
  own = await change(own, "payment", {
    kind: "receipt",
    amount: "100",
    method: "现金",
    confirmed: true,
  });
  own = await change(own, "payment", {
    kind: "expense",
    amount: "2.01",
    method: "现金",
    confirmed: true,
  });
  const stats = await api.repair.stats({
    range: "day",
    engineerId: f.users.engineer,
  });
  assert.equal(stats.revenue, 100);
  assert.equal(stats.expenses, 2.01);
  assert.equal(stats.profit, 97.99);
  const d = await eng.dashboard.overview();
  assert.equal(d.repair.revenue, 100);
  assert.equal(d.repair.expenses, undefined);
  assert.ok(
    (await client(f, "finance").dashboard.overview()).repair.profit !==
      undefined,
  );
  const p = page("miniprogram/packages/staff/stats/index.js", eng, "engineer");
  await p.onLoad();
  assert.equal(p.data.error, "");
  assert.equal(p.data.repair.created, 3);
  assert.equal(p.data.repair.revenue, 100);
  assert.equal(p.data.repair.expenses, undefined);
  await p.onRangeTap(evt("value", "month"));
  assert.equal(p.data.error, "");
  assert.equal(p.data.repair.created, 3);
  assert.equal(p.data.repair.revenue, 100);
  const salesPage = page(
    "miniprogram/packages/staff/stats/index.js",
    client(f, "sales"),
    "sales",
  );
  await salesPage.onLoad();
  assert.equal(salesPage.data.error, "");
  assert.equal(salesPage.data.repair, null);
  const empty = await api.repair.stats({
    from: "2090-01-01",
    to: "2090-01-02",
    engineerId: f.users.engineer,
  });
  assert.equal(empty.created, 0);
  assert.equal(empty.revenue, 0);
  assert.equal(empty.profit, 0);
});
