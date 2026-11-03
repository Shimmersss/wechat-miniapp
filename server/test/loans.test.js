const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client } = require("./page-helpers");
const { one } = require("../src/db");
async function fileStatus(url) {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.status;
}
let f,
  api,
  payload,
  model,
  seq = 0;
const key = () => "loan_" + Date.now() + "_" + ++seq;
async function unit() {
  return api.inbound.createUnit({ ...payload, imei1: imei() });
}
async function out(unitIds) {
  return api.loan.create({
    requestKey: key(),
    type: "loan_out",
    unitIds,
    counterparty: "测试同行",
    phone: "13800000001",
    dueAt: "2020-01-01",
    reason: "实际交接出借",
  });
}
async function back(o, unitIds, role = "warehouse") {
  return client(f, role).loan.markReturned(o.id, {
    requestKey: key(),
    version: o.version,
    reason: "实际逐台归还",
    items: await Promise.all(
      unitIds.map(async (unitId) => ({
        unitId,
        condition: "外观无新增划痕，功能正常",
        damage: "",
        photos: [await f.upload("internal", role)],
      })),
    ),
  });
}
test.before(async () => {
  f = await fixture([
    "boss",
    "warehouse",
    "sales",
    "engineer",
    "finance",
    "customer",
  ]);
  api = client(f, "boss");
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "借还验证_" + Date.now(),
      brandLabel: "借还",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const t = await api.template.detail(model.templateId),
    proof = await f.upload(),
    s = (await f.api("POST", "/suppliers", { name: "借还货源_" + Date.now() }))
      .data;
  payload = {
    modelId: model.id,
    templateVersion: t.version,
    supplierId: s.id,
    attributes: attributes(t, proof),
    cost: "100.01",
    retail: "150",
    wholesale: "130",
    agentBase: "120",
    inspectionConfirmed: true,
    flags: { showInShop: true, sharePeer: true, shareAgent: false },
  };
});
test.after(async () => f?.close());
test("真实出借：同机并发只一单、整单回滚、关闭分享且不计销售、逐台归还后必须真实复检", async () => {
  const a = await unit(),
    b = await unit();
  const make = () =>
    f.api("POST", "/loans", {
      requestKey: key(),
      type: "loan_out",
      unitIds: [a.id],
      counterparty: "并发同行",
      phone: "13800000001",
      dueAt: "2020-01-01",
      reason: "实际交接",
    });
  const raced = await Promise.all([make(), make()]);
  assert.equal(raced.filter((r) => r.status === 200).length, 1);
  assert.equal(raced.find((r) => r.status !== 200).status, 409);
  assert.equal((await api.inventory.detail(a.id)).status, "loaned_out");
  assert.equal((await api.inventory.detail(a.id)).flags.showInShop, false);
  const fail = await f.api("POST", "/loans", {
    requestKey: key(),
    type: "loan_out",
    unitIds: [b.id, a.id],
    counterparty: "整单回滚",
    phone: "13800000001",
    dueAt: "2020-01-01",
    reason: "第二台冲突",
  });
  assert.equal(fail.status, 409);
  assert.equal((await api.inventory.detail(b.id)).status, "in_stock");
  let o = await out([b.id]);
  assert.equal(o.status, "overdue");
  assert.ok(o.items[0].imei1);
  o = await back(o, [b.id]);
  assert.equal(o.status, "returned_recheck");
  assert.equal((await api.inventory.detail(b.id)).status, "recheck");
  const before = await f.api("POST", "/loans/" + o.id + "/recheck", {
    requestKey: key(),
    version: o.version,
    reason: "不得跳过实际检查",
    unitIds: [b.id],
  });
  assert.equal(before.status, 409);
  const form = await api.inventory.recheckForm(b.id);
  await client(f, "warehouse").inventory.recheck(b.id, {
    inspectionVersion: form.inspectionVersion,
    result: "pass",
    attributes: {},
    reason: "逐项真实复检通过",
  });
  const version = o.version,
    requestKey = key(),
    body = {
      requestKey,
      version,
      reason: "核验复检后完结借还",
      unitIds: [b.id],
    };
  o = await api.loan.recheck(o.id, body);
  assert.equal(o.status, "closed");
  const retry = await api.loan.recheck(o.id, body);
  assert.equal(retry.version, o.version);
  assert.equal((await api.inventory.detail(b.id)).status, "in_stock");
  assert.equal((await api.inventory.detail(b.id)).flags.showInShop, false);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM sales_items WHERE unit_id IN (?,?)",
          [a.id, b.id],
        )
      ).n,
    ),
    0,
  );
  await assert.rejects(
    () =>
      f.pool.execute(
        "UPDATE loan_events SET reason='不可修改' WHERE order_id=?",
        [o.id],
      ),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
});
test("真实借入：外部货权/跨IMEI唯一、不可售、部分归还冲销、重复借入沿用设备并保留快照", async () => {
  const code1 = imei(),
    code2 = imei(),
    code3 = imei(),
    devices = [
      {
        modelId: model.id,
        imei1: code1,
        imei2: code2,
        description: "同行借来检测",
      },
      { modelId: model.id, imei1: code3 },
    ],
    body = {
      requestKey: key(),
      type: "borrow_in",
      devices,
      counterparty: "外部货主",
      phone: "13800000001",
      dueAt: "2020-01-01",
      reason: "实际借入两台",
    };
  const both = await Promise.all([
    api.loan.create(body),
    api.loan.create(body),
  ]);
  let o = both[0];
  assert.equal(o.id, both[1].id);
  assert.equal(o.items.length, 2);
  assert.ok(
    o.items.every(
      (i) => i.ownership === "borrowed" && i.unitStatus === "borrowed_in",
    ),
  );
  const first = o.items.find((i) => i.imei1 === code1),
    second = o.items.find((i) => i.imei1 === code3);
  const view = await api.inventory.detail(first.unitId);
  assert.equal(view.ownership, "borrowed");
  assert.equal(view.flags.showInShop, false);
  assert.equal(view.cost, 0);
  const duplicate = await f.api("POST", "/loans", {
    ...body,
    requestKey: key(),
    devices: [{ modelId: model.id, imei1: code2 }],
  });
  assert.equal(duplicate.status, 409);
  assert.equal(
    (
      await f.api("POST", "/sales/quote", {
        items: [{ unitId: first.unitId, priceVersion: view.priceVersion }],
      })
    ).status,
    409,
  );
  const originalVersion = o.version,
    returnKey = key(),
    proof = await f.upload("internal", "warehouse"),
    returnedBody = {
      requestKey: returnKey,
      version: originalVersion,
      reason: "第一台实际归还货主",
      items: [
        {
          unitId: first.unitId,
          condition: "外观功能检查正常",
          damage: "无新增损坏",
          photos: [proof],
        },
      ],
    };
  o = await client(f, "warehouse").loan.markReturned(o.id, returnedBody);
  assert.equal(o.storedStatus, "active");
  assert.equal(o.items.find((i) => i.unitId === first.unitId).status, "closed");
  assert.equal((await api.inventory.detail(first.unitId)).status, "returned");
  assert.equal(
    (await client(f, "warehouse").loan.markReturned(o.id, returnedBody))
      .version,
    o.version,
  );
  const photo = o.photos[0];
  assert.equal(await fileStatus(photo.url), 200);
  assert.equal(
    (await f.api("GET", "/files/" + photo.fileId, undefined, "engineer"))
      .status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/files/" + photo.fileId, undefined, "finance")).status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/loans/" + o.id, undefined, "customer")).status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/loans/" + o.id, undefined, "sales")).status,
    403,
  );
  o = await back(o, [second.unitId]);
  assert.equal(o.status, "closed");
  const again = await api.loan.create({
    ...body,
    requestKey: key(),
    devices: [devices[0]],
  });
  assert.equal(again.items[0].unitId, first.unitId);
  assert.equal((await api.loan.detail(o.id)).status, "closed");
  assert.equal((await api.loan.detail(o.id)).items[0].status, "closed");
  assert.equal(
    (await api.inventory.detail(first.unitId)).status,
    "borrowed_in",
  );
  const old = await api.loan.detail(o.id);
  assert.equal(
    old.items.find((i) => i.unitId === first.unitId).name,
    "借还验证_" + model.name.split("_").at(-1),
  );
  await assert.rejects(
    () =>
      f.pool.execute(
        "UPDATE loan_items SET snapshot=JSON_OBJECT() WHERE order_id=?",
        [o.id],
      ),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await f.restart();
  assert.equal(
    (await api.loan.detail(again.id)).items[0].unitStatus,
    "borrowed_in",
  );
});
test("借还未知收费明确拒绝、串码整单原子性、归还证据必填与权限即时撤销", async () => {
  const u = await unit(),
    common = {
      requestKey: key(),
      type: "loan_out",
      unitIds: [u.id],
      counterparty: "收费未定",
      phone: "13800000001",
      dueAt: "2020-01-01",
      reason: "验证未定规则",
    };
  assert.equal(
    (await f.api("POST", "/loans", { ...common, deposit: "100" })).status,
    400,
  );
  assert.equal((await api.inventory.detail(u.id)).status, "in_stock");
  let o = await api.loan.create(common);
  const r = await f.api("POST", "/loans/" + o.id + "/return", {
    requestKey: key(),
    version: o.version,
    reason: "不得空凭证",
    items: [{ unitId: u.id, condition: "正常", photos: [] }],
  });
  assert.equal(r.status, 400);
  assert.equal((await api.inventory.detail(u.id)).status, "loaned_out");
  assert.equal((await api.loan.detail(o.id)).version, 1);
  const a = imei(),
    bad = await f.api("POST", "/loans", {
      requestKey: key(),
      type: "borrow_in",
      devices: [
        { modelId: model.id, imei1: a },
        { modelId: model.id, imei1: a },
      ],
      counterparty: "重复串码回滚",
      phone: "13800000001",
      dueAt: "2020-01-01",
      reason: "不得半单保存",
    });
  assert.equal(bad.status, 400);
  assert.equal(
    await one(f.pool, "SELECT unit_id FROM unit_identifiers WHERE imei=?", [a]),
    null,
  );
  o = await back(o, [u.id]);
  const photo = o.photos[0];
  await f.admin.execute("UPDATE staff SET status='disabled' WHERE user_id=?", [
    f.users.warehouse,
  ]);
  const warehouse = await f.api(
    "GET",
    "/loans/" + o.id,
    undefined,
    "warehouse",
  );
  assert.ok([401, 403].includes(warehouse.status));
  assert.ok([401, 403].includes(await fileStatus(photo.url)));
  const signed = (await client(f, "boss").loan.detail(o.id)).photos[0].url;
  assert.equal(await fileStatus(signed), 200);
});
