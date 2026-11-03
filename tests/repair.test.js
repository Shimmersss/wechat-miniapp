const test = require("node:test"),
  assert = require("node:assert/strict");
let role = "boss";
global.wx = { getStorageSync: () => role };
const mock = require("../miniprogram/mock");
const call = (url, method = "GET", data = {}) =>
  mock.handle({ url, method, data });
let sequence = 0;
const key = () => "repair_mock_" + ++sequence;
async function action(o, path, data, actor = "engineer") {
  role = actor;
  const r = await call("/repair-orders/" + o.id + "/" + path, "POST", {
    requestKey: key(),
    version: o.version,
    reason: "模拟业务操作说明",
    ...data,
  });
  assert.equal(r.code, 0, r.message);
  return r.data;
}
test("维修mock真实保存/权限/确认/配件扣料/取机/收退款，不再返回固定经营数字", async () => {
  const photo = mock.registerFile({
    filePath: "/tmp/repair-photo.jpg",
    scope: "internal",
  });
  let r = await call("/repair-orders", "POST", {
    requestKey: key(),
    kind: "external",
    model: "维修验证",
    identifier: "SN-REPAIR-TEST",
    customer: "验证顾客",
    phone: "13800000001",
    fault: "无法充电",
    engineerId: "mock_engineer",
    photos: [photo],
  });
  assert.equal(r.code, 0, r.message);
  let o = r.data;
  role = "customer";
  assert.equal((await call("/repair-orders/" + o.id)).code, 403);
  role = "purchaser";
  assert.equal((await call("/files/" + photo.fileId)).code, 403);
  role = "engineer";
  assert.equal((await call("/files/" + photo.fileId)).code, 0);
  o = await action(o, "transition", { to: "checking" });
  r = await call("/repair-orders/" + o.id, "PUT", {
    requestKey: key(),
    version: o.version,
    reason: "保存诊断",
    diagnosis: "需换件",
  });
  assert.equal(r.code, 0, r.message);
  o = r.data;
  assert.equal(
    (
      await call("/repair-orders/" + o.id + "/quote", "POST", {
        requestKey: key(),
        version: o.version,
        reason: "不得报价",
        amount: "100",
      })
    ).code,
    403,
  );
  o = await action(o, "quote", { amount: "100.01" }, "boss");
  o = await action(o, "transition", { to: "pending_confirm" });
  o = await action(o, "confirm", {
    confirmed: true,
    quoteVersion: o.quoteVersion,
  });
  o = await action(o, "transition", { to: "repairing" });
  role = "boss";
  let p = (
    await call("/repair-parts", "POST", {
      sku: "repair-test-part",
      name: "测试配件",
    })
  ).data;
  p = (
    await call("/repair-parts/" + p.id + "/receive", "POST", {
      requestKey: key(),
      version: p.version,
      reason: "采购收货",
      quantity: 2,
      unitCost: "10.01",
    })
  ).data;
  o = await action(o, "parts/issue", { partId: p.id, quantity: 1 });
  assert.equal(o.partsCost, undefined);
  assert.equal(o.parts[0].cost, undefined);
  o = await action(
    o,
    "payment",
    { kind: "receipt", amount: "100.01", method: "现金", confirmed: true },
    "finance",
  );
  o = await action(o, "transition", {
    to: "pending_pickup",
    result: "功能正常",
  });
  const proof = mock.registerFile({
    filePath: "/tmp/pickup.jpg",
    scope: "internal",
  });
  o = await action(o, "transition", {
    to: "completed",
    pickupName: "验证取机人",
    pickupProof: [proof],
    warrantyDays: 30,
  });
  assert.equal(o.status, "completed");
  o = await action(
    o,
    "payment",
    { kind: "refund", amount: "1", method: "现金", confirmed: true },
    "finance",
  );
  assert.equal(o.received, 99.01);
  assert.equal(o.profit, 89);
  role = "engineer";
  const owned = (await call("/repair-orders/" + o.id)).data;
  assert.equal(owned.profit, undefined);
  assert.equal(owned.partsCost, undefined);
  assert.equal(
    (await call("/repair-parts")).data.list[0].stockValue,
    undefined,
  );
  role = "boss";
  const stats = (await call("/repair-orders/stats")).data;
  assert.equal(stats.created, 1);
  assert.equal(stats.revenue, 99.01);
  assert.equal(stats.partsCost, 10.01);
  assert.equal(stats.profit, 89);
  role = "finance";
  const expenseProof = mock.registerFile({
    filePath: "/tmp/expense-only.jpg",
    scope: "internal",
  });
  o = await action(
    o,
    "payment",
    {
      kind: "expense",
      amount: "1",
      method: "现金",
      confirmed: true,
      proof: [expenseProof],
    },
    "finance",
  );
  for (const actor of ["engineer", "manager"]) {
    role = actor;
    const privateView = (await call("/repair-orders/" + o.id)).data;
    assert.ok(!privateView.files.some((f) => f.fileId === expenseProof.fileId));
    assert.equal((await call("/files/" + expenseProof.fileId)).code, 403);
  }
  role = "finance";
  assert.equal((await call("/files/" + expenseProof.fileId)).code, 0);
  role = "purchaser";
  assert.equal(
    (await call("/repair-orders/options")).data.canManageParts,
    true,
  );
  role = "finance";
  const proofSet = Array.from({ length: 9 }, (_, i) =>
    mock.registerFile({
      filePath: "/tmp/cash-proof-" + i + ".jpg",
      scope: "internal",
    }),
  );
  o = await action(
    o,
    "payment",
    {
      kind: "receipt",
      amount: "1",
      method: "现金",
      confirmed: true,
      proof: proofSet,
    },
    "finance",
  );
  const count = o.payments.length,
    extra = mock.registerFile({
      filePath: "/tmp/excess-proof.jpg",
      scope: "internal",
    });
  const rejected = await call("/repair-orders/" + o.id + "/payment", "POST", {
    requestKey: key(),
    version: o.version,
    reason: "附件超量应整体失败",
    kind: "refund",
    amount: "1",
    method: "现金",
    confirmed: true,
    proof: [extra],
  });
  assert.equal(rejected.code, 400);
  const after = (await call("/repair-orders/" + o.id)).data;
  assert.equal(after.received, 100.01);
  assert.equal(after.payments.length, count);
});

test("维修看板mock：未完结单在前，同列新单在前，不被大量已完结单挤出首页", async () => {
  role = "boss";
  const create = async (model) => {
    const r = await call("/repair-orders", "POST", {
      requestKey: key(),
      kind: "external",
      model,
      customer: "看板顾客",
      phone: "13800000003",
      fault: "看板排序验证",
      engineerId: "mock_engineer",
    });
    assert.equal(r.code, 0, r.message);
    return r.data;
  };
  const older = await create("看板排序旧单");
  const cancelled = await Promise.all(
    Array.from({ length: 201 }, (_, i) => create("看板排序已取消" + i)),
  );
  await Promise.all(
    cancelled.map((o) => action(o, "transition", { to: "cancelled" }, "boss")),
  );
  const newer = await create("看板排序新单");
  const board = await call("/repair-orders/board");
  assert.equal(board.code, 0, board.message);
  const pending = board.data.columns.pending_check.map((o) => o.id);
  assert.equal(pending[0], newer.id);
  assert.ok(pending.includes(older.id));
  assert.ok(board.data.hasMore);
});
