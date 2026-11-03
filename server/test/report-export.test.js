const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers"),
  { client, page } = require("./page-helpers"),
  { one } = require("../src/db");
const { csvCell } = require("../src/report-export");
let f, boss, model, order, request, meta;
test.before(async () => {
  f = await fixture();
  boss = client(f, "boss");
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "=SUM(1,2)_" + Date.now(),
      brandLabel: "导出验证",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const template = await boss.template.detail(model.templateId),
    proof = await f.upload(),
    supplier = (
      await f.api("POST", "/suppliers", { name: "导出货源_" + Date.now() })
    ).data;
  const u = await boss.inbound.createUnit({
    modelId: model.id,
    templateVersion: template.version,
    inspectionConfirmed: true,
    supplierId: supplier.id,
    attributes: attributes(template, proof),
    imei1: imei(),
    cost: "1000.12",
    retail: "1300.58",
    wholesale: "1200.25",
    agentBase: "1200.25",
  });
  const r = await f.api("POST", "/sales-orders", {
    requestKey: "export_sale_" + u.id,
    items: [{ unitId: u.id, priceVersion: 1 }],
    payMethod: "现金",
    paymentConfirmed: true,
  });
  assert.equal(r.status, 200);
  order = r.data;
  request = {
    requestKey: "export_" + order.id,
    range: "day",
    reason: "验证销售对账",
  };
});
test.after(async () => {
  await f?.close();
});
test("报表实际快照：原因、幂等、CSV编码/公式转义、历史不随退款改变", async () => {
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.equal(csvCell(" +cmd"), '"\' +cmd"');
  assert.equal(csvCell(-1.25), "-1.25");
  assert.equal(
    (await f.api("POST", "/stats/export", { ...request, reason: "" })).status,
    400,
  );
  const rows = await Promise.all(
    [1, 2].map(() => f.api("POST", "/stats/export", request)),
  );
  assert.ok(rows.every((r) => r.status === 200));
  meta = rows[0].data;
  assert.equal(rows[1].data.id, meta.id);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM report_exports WHERE actor_id=? AND request_key=?",
          [f.users.boss, request.requestKey],
        )
      ).n,
    ),
    1,
  );
  const content = await boss.stats.exportContent(meta.id);
  assert.ok(content.csv.startsWith("\uFEFF"));
  assert.ok(content.csv.includes("\"'=SUM(1,2)_"));
  assert.ok(content.csv.includes("净成本"));
  assert.ok(content.csv.includes("净毛利"));
  await f.api("POST", "/sales-orders/" + order.id + "/refund", {
    requestKey: "export_refund_" + order.id,
    kind: "return",
    reason: "快照后退货",
    items: [{ itemId: order.items[0].id }],
  });
  assert.equal((await boss.stats.exportContent(meta.id)).csv, content.csv);
  await assert.rejects(
    f.pool.execute("UPDATE report_exports SET payload=? WHERE id=?", [
      "{}",
      meta.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  assert.equal(
    (await f.api("POST", "/stats/export", { ...request, reason: "变化原因" }))
      .status,
    409,
  );
});
test("下载重新鉴权、他人隔离、降权裁列、过期拒绝及统计页面防重复", async () => {
  const other = await fixture();
  try {
    assert.equal(
      (await other.api("GET", "/stats/exports/" + meta.id)).status,
      404,
    );
  } finally {
    await other.close();
  }
  assert.equal(
    (await f.api("GET", "/stats/exports/" + meta.id, undefined, "sales"))
      .status,
    403,
  );
  await f.admin.execute("UPDATE staff SET role_key='manager' WHERE user_id=?", [
    f.users.boss,
  ]);
  const lower = await boss.stats.exportContent(meta.id);
  assert.equal(lower.csv.includes("净成本"), false);
  assert.equal(lower.csv.includes("净毛利"), false);
  await f.admin.execute("UPDATE staff SET role_key='boss' WHERE user_id=?", [
    f.users.boss,
  ]);
  const p = page("miniprogram/packages/staff/stats/index.js", boss);
  await p.onLoad();
  assert.equal(p.data.canExport, true);
  const original = boss.stats.exportReport;
  let count = 0,
    snapshots = [];
  boss.stats.exportReport = async (data) => {
    snapshots.push(JSON.parse(JSON.stringify(data)));
    const r = await original(data);
    if (++count === 1)
      throw Object.assign(new Error("合成响应丢失"), { code: -1 });
    return r;
  };
  await p.onExport();
  assert.ok(p.data.exportPending);
  await p.onRetryExport();
  assert.equal(p.data.exportPending, null);
  assert.ok(p.data.exportReport.id);
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.equal(p.confirmations.at(-1).needReason, true);
  await f.admin.execute(
    "UPDATE report_exports SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
    [meta.id],
  );
  assert.equal((await f.api("GET", "/stats/exports/" + meta.id)).status, 410);
});
