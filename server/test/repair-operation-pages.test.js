const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers");
const { client, page } = require("./page-helpers");
const { one } = require("../src/db");
let f,
  api,
  seq = 0;
const event = (name, value) => ({
  currentTarget: { dataset: { [name]: value } },
});
const input = (p, field, value) =>
  p.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
const create = () =>
  api.repair.create({
    requestKey: "repair_ui_" + Date.now() + "_" + ++seq,
    kind: "external",
    model: "操作页面验证",
    customer: "验证客户",
    phone: "13800000001",
    fault: "不能充电",
    engineerId: f.users.engineer,
  });
const detail = async (role, id) => {
  const p = page(
    "miniprogram/packages/staff/repair/detail.js",
    client(f, role),
    role,
  );
  await p.onLoad({ id });
  return p;
};
async function submit(p) {
  await p.onSubmitEditor();
  assert.equal(p.data.error, "", p.data.error);
  assert.equal(p.data.editor, null);
  assert.equal(p.data.pending, null);
}
async function transition(p, to, values = {}) {
  p.onTransition(event("to", to));
  assert.ok(p.data.editor);
  for (const [k, v] of Object.entries(values)) input(p, k, v);
  await submit(p);
}
test.before(async () => {
  f = await fixture(["boss", "engineer", "finance", "manager", "purchaser"]);
  api = client(f, "boss");
});
test.after(async () => f?.close());
test("配件页面经真实API：采购建档、回执丢失原样重试、版本冲突与工程师成本裁剪", async () => {
  const purchaser = client(f, "purchaser"),
    p = page(
      "miniprogram/packages/staff/repair/parts.js",
      purchaser,
      "purchaser",
    );
  await p.onLoad();
  assert.equal(p.data.canManage, true);
  p.onCreate();
  const sku = "ui-part-" + Date.now();
  input(p, "sku", sku);
  input(p, "name", "页面电池");
  await p.onSubmit();
  assert.equal(p.data.error, "");
  assert.equal(p.data.list[0].sku, sku);
  const id = p.data.list[0].id;
  p.onReceive(event("id", id));
  input(p, "quantity", "3");
  input(p, "unitCost", "10.01");
  const receive = purchaser.repair.receivePart;
  let n = 0;
  purchaser.repair.receivePart = async (...args) => {
    const result = await receive(...args);
    if (++n === 1)
      throw Object.assign(new Error("已提交但回执丢失"), { code: -1 });
    return result;
  };
  await p.onSubmit();
  assert.ok(p.data.pending);
  const key = p.data.pending.body.requestKey;
  input(p, "quantity", "99");
  assert.equal(p.data.editor.values.quantity, "3");
  await p.onRetry();
  assert.equal(p.data.list[0].quantity, 3);
  assert.equal(p.data.list[0].stockValue, 30.03);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM repair_part_ledger WHERE request_key=?",
          [key],
        )
      ).n,
    ),
    1,
  );
  await p.onLedger(event("id", id));
  assert.equal(p.data.ledger.list[0].kind, "receive");
  p.onReceive(event("id", id));
  input(p, "unitCost", "0");
  await api.repair.receivePart(id, {
    requestKey: "other_" + Date.now(),
    version: p.data.editor.part.version,
    quantity: 1,
    unitCost: "1",
    reason: "另一人员入库",
  });
  await p.onSubmit();
  assert.equal(p.data.editor.conflict, true);
  await p.onRefresh();
  assert.equal(p.data.list[0].quantity, 4);
  const eng = page(
    "miniprogram/packages/staff/repair/parts.js",
    client(f, "engineer"),
    "engineer",
  );
  eng.setData({keyword:sku});
  await eng.onLoad();
  assert.equal(eng.data.canManage, false);
  assert.equal(eng.data.list.find((x) => x.id === id).stockValue, undefined);
  eng.onCreate();
  assert.equal(eng.data.editor, null);
});
test("维修详情页面经真实API完成报价确认/领退料/收退款/取机；原请求重试只记一次", async () => {
  const order = await create(),
    p = await detail("boss", order.id);
  await transition(p, "checking");
  p.onEdit();
  input(p, "diagnosis", "检测充电口异常，换件后复测");
  await submit(p);
  p.onQuote();
  input(p, "amount", "100.01");
  await submit(p);
  await transition(p, "pending_confirm");
  p.onConfirmQuote();
  await p.onSubmitEditor();
  assert.ok(p.notices.at(-1).includes("确认"));
  input(p, "accepted", true);
  await submit(p);
  await transition(p, "repairing");
  let part = await api.repair.createPart({
    sku: "issue-ui-" + Date.now(),
    name: "接口配件",
  });
  part = await api.repair.receivePart(part.id, {
    requestKey: "stock_" + Date.now(),
    version: part.version,
    quantity: 3,
    unitCost: "5.01",
    reason: "验收到货",
  });
  const pa = client(f, "boss"),
    q = page("miniprogram/packages/staff/repair/detail.js", pa);
  await q.onLoad({ id: order.id });
  await q.onIssue();
  q.onPartKeyword({detail:{value:part.sku}});
  await q.onSearchParts();
  q.onSelectPart(event("id", part.id));
  input(q, "quantity", "2");
  let n = 0;
  const actual = pa.repair.issueParts;
  pa.repair.issueParts = async (...args) => {
    const result = await actual(...args);
    if (++n === 1)
      throw Object.assign(new Error("扣料成功回执丢失"), { code: -1 });
    return result;
  };
  await q.onSubmitEditor();
  assert.ok(q.data.pending);
  const issueKey = q.data.pending.body.requestKey;
  input(q, "quantity", "3");
  assert.equal(q.data.editor.values.quantity, "2");
  await q.onRetry();
  assert.equal(q.data.detail.parts[0].quantity, 2);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM repair_part_ledger WHERE request_key=?",
          [issueKey],
        )
      ).n,
    ),
    1,
  );
  q.onReturn(event("id", q.data.detail.parts[0].id));
  input(q, "quantity", "1");
  await submit(q);
  assert.equal(q.data.detail.parts[0].returned, 1);
  for (const [kind, amount] of [
    ["receipt", "100.01"],
    ["refund", "0.01"],
    ["receipt", "0.01"],
    ["expense", "2"],
    ["expense_refund", "1"],
  ]) {
    q.onPayment(event("kind", kind));
    input(q, "amount", amount);
    input(q, "accepted", true);
    await submit(q);
  }
  assert.equal(q.data.detail.received, 100.01);
  assert.equal(q.data.detail.expenses, 1);
  await transition(q, "pending_pickup", { result: "更换后充放电正常" });
  q.onTransition(event("to", "completed"));
  input(q, "pickupName", "本人取机");
  input(q, "warrantyDays", "0");
  await q.onSubmitEditor();
  assert.ok(q.notices.at(-1).includes("凭证"));
  q.setData({ "editor.photos": [await f.upload("internal")] });
  await submit(q);
  assert.equal(q.data.detail.status, "completed");
  assert.equal(q.data.detail.profit, 94);
  assert.equal(q.data.transitions.length, 0);
  assert.ok(q.confirmations.every((c) => c.needReason));
  const eng = await detail("engineer", order.id);
  assert.equal(eng.data.canQuote, false);
  assert.equal(eng.data.detail.partsCost, undefined);
  assert.equal(eng.data.paymentKinds.length, 0);
  assert.ok(
    eng.data.detail.timeline.some((e) => e.data.result === "更换后充放电正常"),
  );
});
test("维修详情版本冲突拒绝旧报价覆盖，刷新后允许零元报价", async () => {
  let o = await create();
  o = await api.repair.transition(o.id, {
    requestKey: "checking_" + Date.now(),
    version: o.version,
    reason: "开始检测",
    to: "checking",
  });
  const p = await detail("boss", o.id);
  p.onQuote();
  input(p, "amount", "0");
  await api.repair.update(o.id, {
    requestKey: "edit_" + Date.now(),
    version: o.version,
    reason: "另一人保存",
    diagnosis: "已复核",
  });
  await p.onSubmitEditor();
  assert.equal(p.data.editor.conflict, true);
  assert.equal(p.data.pending, null);
  await p.onRefresh();
  p.onQuote();
  input(p, "amount", "0");
  await submit(p);
  assert.equal(p.data.detail.quote, 0);
});
test("费用附件按最高敏感性授权：工程师/店长无链接且旧签名失效，不能转普通附件", async () => {
  let o = await create();
  const appearance = await f.upload("internal");
  o = await api.repair.update(o.id, {
    requestKey: "appearance_" + Date.now(),
    version: o.version,
    reason: "追加外观",
    photos: [appearance],
  });
  const prior = (await client(f, "engineer").repair.detail(o.id)).files.find(
    (v) => v.fileId === appearance.fileId,
  );
  assert.equal((await fetch(prior.url)).status, 200);
  o = await api.repair.payment(o.id, {
    requestKey: "expense_" + Date.now(),
    version: o.version,
    reason: "实际维修费用",
    kind: "expense",
    amount: "2",
    method: "现金",
    confirmed: true,
    proof: [appearance],
  });
  for (const role of ["engineer", "manager"]) {
    const d = await client(f, role).repair.detail(o.id);
    assert.ok(!d.files.some((v) => v.fileId === appearance.fileId));
    assert.ok(!d.payments.some((v) => v.kind === "expense"));
    assert.equal(
      (await f.api("GET", "/files/" + appearance.fileId, undefined, role))
        .status,
      403,
    );
  }
  assert.equal((await fetch(prior.url)).status, 403);
  for (const role of ["finance", "boss"]) {
    const d = await client(f, role).repair.detail(o.id);
    const file = d.files.find(
      (v) => v.fileId === appearance.fileId && v.purpose === "expense",
    );
    assert.ok(file);
    assert.equal((await fetch(file.url)).status, 200);
  }
  const r = await f.api("PUT", "/repair-orders/" + o.id, {
    requestKey: "reuse_" + Date.now(),
    version: o.version,
    reason: "不得改为普通照片",
    photos: [appearance],
  });
  assert.equal(r.status, 400);
  assert.equal((await api.repair.detail(o.id)).version, o.version);
});

test("不同维修单并行处理不被事件表空键间隙锁误伤", async () => {
  const orders = [];
  for (let i = 0; i < 16; i++) orders.push(await create());
  const results = await Promise.all(
    orders.map((o, i) =>
      f.api("POST", "/repair-orders/" + o.id + "/transition", {
        requestKey: "parallel_" + Date.now() + "_" + i,
        version: o.version,
        reason: "独立工单同时开始检测",
        to: "checking",
      }),
    ),
  );
  for (const r of results) {
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.status, "checking");
  }
  const parts = [];
  for (let i = 0; i < 10; i++)
    parts.push(
      await api.repair.createPart({
        sku: "parallel-part-" + Date.now() + "_" + i,
        name: "并行配件",
      }),
    );
  const received = await Promise.all(
    parts.map((p, i) =>
      f.api("POST", "/repair-parts/" + p.id + "/receive", {
        requestKey: "parallel_receive_" + Date.now() + "_" + i,
        version: p.version,
        quantity: 1,
        unitCost: "1",
        reason: "独立配件同时入库",
      }),
    ),
  );
  for (const r of received) {
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.quantity, 1);
  }
});
