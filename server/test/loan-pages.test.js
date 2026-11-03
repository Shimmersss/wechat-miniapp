const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers"),
  { client, page } = require("./page-helpers");
const staff = "miniprogram/packages/staff/";
let f, boss, warehouse, model, payload;
const unit = async () =>
  (await boss.inbound.createUnit({ ...payload, imei1: imei() })).id;
const wait = async (ready) => {
  for (let i = 0; i < 100 && !ready(); i++)
    await new Promise((r) => setTimeout(r, 20));
};
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
  warehouse = client(f, "warehouse");
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "借还页面_" + Date.now(),
      brandLabel: "借还",
      series: "页面",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const t = await boss.template.detail(model.templateId),
    proof = await f.upload(),
    s = (
      await f.api("POST", "/suppliers", { name: "借还页面货源_" + Date.now() })
    ).data;
  payload = {
    modelId: model.id,
    templateVersion: t.version,
    supplierId: s.id,
    attributes: attributes(t, proof),
    cost: "100",
    retail: "150",
    wholesale: "130",
    agentBase: "120",
    inspectionConfirmed: true,
    flags: { showInShop: true, sharePeer: false, shareAgent: false },
  };
});
test.after(async () => f?.close());

test("出借页面：库存多选带回、回执丢失原样重试只一单、逐台归还→库存复检→完结", async () => {
  const a = await unit(),
    b = await unit();
  const edit = page(staff + "loans/edit.js", warehouse, "warehouse");
  edit.onLoad({ type: "loan_out" });
  edit.onPickUnits();
  assert.equal(edit.navigation.at(-1).query.pick, "loan");
  const picker = page(staff + "inventory/list.js", warehouse, "warehouse");
  await picker.onLoad({ pick: "loan" });
  assert.equal(picker.data.pickFor, "loan");
  for (const id of [a, b])
    picker.onItemTap({
      currentTarget: { dataset: { id, status: "in_stock" } },
    });
  picker.onConfirmPick();
  assert.equal(picker.navigation.at(-1), "back");
  await wait(() => edit.data.units.length === 2);
  assert.deepEqual(edit.data.units.map((u) => u.id).sort(), [a, b].sort());
  Object.assign(edit.data.form, {
    counterparty: "页面同行",
    phone: "13800000009",
    dueAt: "2020-01-01",
    reason: "当面交接",
  });
  const create = warehouse.loan.create;
  let calls = 0;
  warehouse.loan.create = async (body) => {
    const r = await create(body);
    if (++calls === 1)
      throw Object.assign(new Error("合成回执丢失"), { code: -1 });
    return r;
  };
  await edit.onSubmit();
  assert.ok(edit.data.pending);
  await edit.onRetry();
  warehouse.loan.create = create;
  assert.equal(edit.data.pending, null);
  const id = edit.data.result.id;
  assert.equal(edit.data.result.items.length, 2);
  assert.equal(
    (await warehouse.loan.list({ keyword: edit.data.result.no })).total,
    1,
  );
  assert.equal((await boss.inventory.detail(a)).status, "loaned_out");
  edit.onUnload();
  picker.onUnload();

  const detail = page(staff + "loans/detail.js", warehouse, "warehouse");
  await detail.onLoad({ id });
  assert.equal(detail.data.detail.status, "overdue");
  assert.equal(detail.data.detail.openCount, 2);
  detail.onOpenReturn();
  const row = detail.data.editor.items.findIndex((i) => i.unitId === a);
  detail.onToggleReturn({ currentTarget: { dataset: { index: row } } });
  await detail.onSubmitReturn();
  assert.match(detail.notices.at(-1), /外观功能结论/);
  const photo = await f.upload("internal", "warehouse");
  detail.data.editor.items[row].condition = "外观无新增磕碰，开机正常";
  detail.data.editor.items[row].photos = [photo];
  detail.data.editor.reason = "同行当面归还";
  await detail.onSubmitReturn();
  assert.equal(detail.data.error, "");
  assert.equal(detail.data.editor, null);
  assert.equal(detail.data.detail.openCount, 1);
  assert.equal((await boss.inventory.detail(a)).status, "recheck");
  const queue = await warehouse.loan.list({ status: "returned_recheck" });
  assert.ok(queue.list.some((o) => o.id === id));
  const todos = (await warehouse.dashboard.overview()).todos;
  assert.ok(todos.find((t) => t.key === "loanRecheck").count >= 1);
  assert.ok(todos.find((t) => t.key === "loanOverdue").count >= 1);

  await detail.onCloseItem({ currentTarget: { dataset: { id: a } } });
  assert.match(detail.data.error, /复检/);
  assert.equal(detail.data.pending, null);
  const form = await warehouse.inventory.recheckForm(a);
  await warehouse.inventory.recheck(a, {
    inspectionVersion: form.inspectionVersion,
    result: "pass",
    attributes: {},
    reason: "逐项复检通过",
  });
  await detail.load();
  const item = detail.data.detail.items.find((i) => i.unitId === a);
  assert.equal(item.unitStatus, "in_stock");
  await detail.onCloseItem({ currentTarget: { dataset: { id: a } } });
  assert.equal(detail.data.error, "");
  assert.equal(
    detail.data.detail.items.find((i) => i.unitId === a).status,
    "closed",
  );
  assert.ok(
    detail.data.detail.timeline.some(
      (e) => e.action === "return" && e.photos.length,
    ),
  );
  detail.onUnload();
});

test("借入页面：型号库选择、串码校验、归还即冲销", async () => {
  const edit = page(staff + "loans/edit.js", warehouse, "warehouse");
  edit.onLoad({ type: "borrow_in" });
  assert.equal(edit.data.form.type, "borrow_in");
  edit.onChooseModel({ currentTarget: { dataset: { index: 0 } } });
  const events = require("../../miniprogram/utils/events");
  events.emit("loan:model-selected", { id: model.id, name: model.name });
  assert.equal(edit.data.devices[0].model.id, model.id);
  Object.assign(edit.data.form, {
    counterparty: "借入同行",
    phone: "13800000010",
    dueAt: "2099-01-01",
    reason: "临时借入展示",
  });
  edit.data.devices[0].imei1 = "123";
  edit.onSubmit();
  assert.match(edit.notices.at(-1), /IMEI1/);
  edit.data.devices[0].imei1 = imei();
  await edit.onSubmit();
  assert.equal(edit.data.error, "");
  const id = edit.data.result.id,
    unitId = edit.data.result.items[0].unitId;
  assert.equal((await boss.inventory.detail(unitId)).status, "borrowed_in");
  edit.onUnload();

  const detail = page(staff + "loans/detail.js", warehouse, "warehouse");
  await detail.onLoad({ id });
  assert.equal(detail.data.detail.status, "active");
  detail.onOpenReturn();
  assert.equal(detail.data.editor.items[0].selected, true);
  Object.assign(detail.data.editor.items[0], {
    condition: "原样归还",
    photos: [await f.upload("internal", "warehouse")],
  });
  detail.data.editor.reason = "归还同行";
  await detail.onSubmitReturn();
  assert.equal(detail.data.error, "");
  assert.equal(detail.data.detail.status, "closed");
  assert.equal((await boss.inventory.detail(unitId)).status, "returned");
  detail.onUnload();
});
