const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client } = require("./page-helpers");
let f,
  api,
  payload,
  seq = 0;
const key = (p) => p + "_" + Date.now() + "_" + ++seq;
test.before(async () => {
  f = await fixture(["boss", "sales", "finance", "warehouse"]);
  api = client(f, "boss");
  const model = (
      await f.api("POST", "/models", {
        category: "phone",
        name: "凭证认领_" + Date.now(),
        brandLabel: "验证",
        series: "验证",
        copyTemplateId: "t_phone",
        tacs: [],
      })
    ).data,
    template = (await f.api("GET", "/templates/" + model.templateId)).data,
    supplier = (
      await f.api("POST", "/suppliers", { name: "凭证认领货源_" + Date.now() })
    ).data;
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, await f.upload()),
    cost: "100",
    retail: "200",
    wholesale: "180",
    agentBase: "180",
    flags: { showInShop: true, sharePeer: false, shareAgent: false },
  };
});
test.after(async () => f?.close());
async function sale() {
  const unit = (
    await f.api("POST", "/inbound/units", { ...payload, imei1: imei() })
  ).data;
  const r = await f.api("POST", "/sales-orders", {
    requestKey: key("claim_sale"),
    items: [{ unitId: unit.id, priceVersion: 1 }],
    payMethod: "现金",
    paymentConfirmed: true,
  });
  assert.equal(r.status, 200, r.message);
  return r.data;
}
async function repair() {
  return api.repair.create({
    requestKey: key("claim_repair"),
    kind: "external",
    model: "凭证认领验证",
    customer: "测试联系人",
    phone: "13800000001",
    expectedAt: "2030-01-01",
    fault: "检测异常",
  });
}

test("同一内部图片被销售补传与维修费用并发认领时只有一方成功", async () => {
  for (let trial = 0; trial < 3; trial++) {
    const s = await sale(),
      o = await repair(),
      file = await f.upload("internal", "boss");
    const [receipt, expense] = await Promise.all([
      f.api("POST", "/sales-orders/" + s.id + "/receipts", {
        receipts: [{ fileId: file.fileId }],
        reason: "并发补传",
      }),
      f.api("POST", "/repair-orders/" + o.id + "/payment", {
        requestKey: key("claim_expense"),
        version: o.version,
        reason: "并发费用",
        kind: "expense",
        amount: "1",
        method: "现金",
        confirmed: true,
        proof: [{ fileId: file.fileId }],
      }),
    ]);
    assert.deepEqual(
      [receipt.status, expense.status].sort(),
      [200, 400],
      receipt.message + " / " + expense.message,
    );
    const [[s1], [r1]] = await Promise.all([
      f.admin.execute("SELECT COUNT(*) n FROM sales_files WHERE file_id=?", [
        file.fileId,
      ]),
      f.admin.execute("SELECT COUNT(*) n FROM repair_files WHERE file_id=?", [
        file.fileId,
      ]),
    ]);
    assert.equal(Number(s1[0].n) + Number(r1[0].n), 1);
  }
});

test("同时关联销售与维修费用的历史文件：销售权限不能绕过维修费用授权", async () => {
  const s = await sale(),
    o = await repair(),
    file = await f.upload("internal", "boss");
  assert.equal(
    (
      await f.api("POST", "/sales-orders/" + s.id + "/receipts", {
        receipts: [{ fileId: file.fileId }],
        reason: "补传",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.api("GET", "/files/" + file.fileId, undefined, "sales")).status,
    200,
  );
  // 模拟修复前并发写入留下的双重关联
  await f.admin.execute(
    "INSERT INTO repair_files (order_id,file_id,purpose,position) VALUES (?,?,'expense',0)",
    [o.id, file.fileId],
  );
  assert.equal(
    (await f.api("GET", "/files/" + file.fileId, undefined, "sales")).status,
    403,
  );
  // 财务同时具备销售查看与维修费用权限
  assert.equal(
    (await f.api("GET", "/files/" + file.fileId, undefined, "finance")).status,
    200,
  );
});
