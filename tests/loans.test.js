const test = require("node:test"),
  assert = require("node:assert/strict");
let role = "boss";
global.wx = { getStorageSync: () => role };
const mock = require("../miniprogram/mock"),
  db = require("../miniprogram/mock/data");
const call = (url, method = "GET", data = {}) =>
  mock.handle({ url, method, data });
let sequence = 0;
const key = () => "loan_mock_" + ++sequence;
function imei(prefix) {
  let sum = 0;
  [...prefix].forEach((v, i) => {
    let n = Number(v) * (i % 2 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return prefix + ((10 - (sum % 10)) % 10);
}
test("借还mock保存单据/设备/归还检查，拒绝空凭证和未复检完结，未知收费不假成功", async () => {
  let r = await call("/loans", "POST", {
    requestKey: key(),
    type: "loan_out",
    unitIds: ["u1", "u2"],
    counterparty: "验证同行",
    phone: "13800000001",
    dueAt: "2020-01-01",
    reason: "实际出借",
  });
  assert.equal(r.code, 0, r.message);
  let o = r.data;
  assert.equal(o.items.length, 2);
  assert.equal(o.status, "overdue");
  assert.equal((await call("/units/u1")).data.status, "loaned_out");
  assert.equal((await call("/units/u1")).data.flags.showInShop, false);
  const bad = await call("/loans/" + o.id + "/return", "POST", {
    requestKey: key(),
    version: o.version,
    reason: "空凭证应整体失败",
    items: [{ unitId: "u1", condition: "正常", photos: [] }],
  });
  assert.equal(bad.code, 400);
  assert.equal((await call("/units/u1")).data.status, "loaned_out");
  role = "warehouse";
  const photo = mock.registerFile({
      filePath: "/tmp/loan-return.jpg",
      scope: "internal",
    }),
    data = {
      requestKey: key(),
      version: o.version,
      reason: "第一台实际归还",
      items: [{ unitId: "u1", condition: "功能外观正常", photos: [photo] }],
    };
  r = await call("/loans/" + o.id + "/return", "POST", data);
  assert.equal(r.code, 0, r.message);
  o = r.data;
  assert.equal(o.storedStatus, "active");
  assert.equal((await call("/units/u1")).data.status, "recheck");
  assert.equal(
    (await call("/loans/" + o.id + "/return", "POST", data)).data.version,
    o.version,
  );
  assert.equal(
    (
      await call("/loans/" + o.id + "/recheck", "POST", {
        requestKey: key(),
        version: o.version,
        reason: "不得跳过检查",
        unitIds: ["u1"],
      })
    ).code,
    409,
  );
  let form = (await call("/units/u1/recheck-form")).data;
  r = await call("/units/u1/recheck", "POST", {
    inspectionVersion: form.inspectionVersion,
    result: "pass",
    attributes: {},
    reason: "逐项复检通过",
  });
  assert.equal(r.code, 0, r.message);
  r = await call("/loans/" + o.id + "/recheck", "POST", {
    requestKey: key(),
    version: o.version,
    reason: "核验实际复检",
    unitIds: ["u1"],
  });
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.items.find((i) => i.unitId === "u1").status, "closed");
  role = "engineer";
  assert.equal((await call("/files/" + photo.fileId)).code, 403);
  assert.equal((await call("/loans/" + o.id)).code, 403);
  role = "boss";
  const common = {
    requestKey: key(),
    type: "borrow_in",
    devices: [{ modelId: db.models[0].id, imei1: imei("98123456780001") }],
    counterparty: "外部货主",
    phone: "13800000001",
    dueAt: "2020-01-01",
    reason: "实际借入",
  };
  r = await call("/loans", "POST", common);
  assert.equal(r.code, 0, r.message);
  const b = r.data;
  assert.equal((await call("/loans", "POST", common)).data.id, b.id);
  assert.equal(
    (await call("/units/" + b.items[0].unitId)).data.ownership,
    "borrowed",
  );
  assert.equal(
    (
      await call("/loans", "POST", {
        ...common,
        requestKey: key(),
        deposit: "100",
      })
    ).code,
    400,
  );
  const proof = mock.registerFile({
    filePath: "/tmp/borrow-return.jpg",
    scope: "internal",
  });
  r = await call("/loans/" + b.id + "/return", "POST", {
    requestKey: key(),
    version: b.version,
    reason: "归还外部货主",
    items: [
      { unitId: b.items[0].unitId, condition: "检查正常", photos: [proof] },
    ],
  });
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.status, "closed");
  assert.equal(
    (await call("/units/" + b.items[0].unitId)).data.status,
    "returned",
  );
  assert.equal(
    (await call("/loans", "POST", { ...common, requestKey: key() })).data
      .items[0].unitId,
    b.items[0].unitId,
  );
  const dash = (await call("/staff/dashboard")).data;
  assert.ok(dash.repair);
  assert.equal(typeof dash.repair.internalRepairCost, "number");
});

test("库存详情借还入口 mock：在借还单中的设备带单据，无借还权限不返回", async () => {
  role = "boss";
  const u = db.units.find((x) => x.status === "in_stock" && (!x.ownership || x.ownership === "own"));
  assert.ok(u);
  assert.equal((await call("/units/" + u.id)).data.loan, undefined);
  const r = await call("/loans", "POST", { requestKey: key(), type: "loan_out", unitIds: [u.id], counterparty: "详情入口", phone: "13800000002", dueAt: "2030-01-01", reason: "验证入口" });
  assert.equal(r.code, 0, r.message);
  assert.deepEqual((await call("/units/" + u.id)).data.loan, { id: r.data.id, no: r.data.no, type: "loan_out" });
  role = "sales";
  assert.equal((await call("/units/" + u.id)).data.loan, undefined);
  role = "boss";
});
