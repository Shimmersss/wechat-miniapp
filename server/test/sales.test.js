const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
let f, payload, model, code;
test.before(async () => {
  f = await fixture();
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "销售验证_" + Date.now(),
      brandLabel: "验证",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const template = (await f.api("GET", "/templates/" + model.templateId)).data,
    supplier = (
      await f.api("POST", "/suppliers", { name: "销售货源_" + Date.now() })
    ).data,
    receipt = await f.upload();
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, receipt),
    cost: "1000.12",
    retail: "1300.58",
    wholesale: "1200.25",
    agentBase: "1200.25",
    flags: { showInShop: true, sharePeer: true, shareAgent: true },
  };
});
test.after(async () => {
  await f?.close();
});
async function unit() {
  code = imei();
  const r = await f.api("POST", "/inbound/units", { ...payload, imei1: code });
  assert.equal(r.status, 200);
  return r.data.id;
}
const sale = (ids, key) => ({
  requestKey: key,
  items: ids.map((unitId) => ({ unitId, priceVersion: 1 })),
  payMethod: "现金",
  paymentConfirmed: true,
});
test("真实销售：服务端金额、越权改价、并发一机一卖、整单回滚与快照不可改", async () => {
  const id = await unit();
  let r = await f.api("GET", "/sales/lookup?code=" + code, undefined, "sales");
  assert.equal(r.data.cost, undefined);
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales-orders",
        {
          ...sale([id], "unauth_" + id),
          items: [{ unitId: id, priceVersion: 1, price: "1" }],
        },
        "sales",
      )
    ).status,
    403,
  );
  const request = sale([id], "paid_" + id);
  const quote = await f.api("POST", "/sales/quote", request, "sales");
  assert.equal(quote.data.total, 1300.58);
  const competing = await Promise.all([
    f.api("POST", "/sales-orders", request, "sales"),
    f.api("POST", "/sales-orders", sale([id], "race_" + id), "sales"),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  const order = competing.find((r) => r.status === 200).data;
  assert.equal(order.amount, 1300.58);
  assert.equal(order.profit, undefined);
  assert.equal(order.items[0].cost, undefined);
  assert.equal((await f.api("GET", "/units/" + id)).data.status, "sold");
  assert.equal(
    (await f.api("GET", "/units/" + id)).data.flags.showInShop,
    false,
  );
  const second = await unit();
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales-orders",
        sale([second, id], "rollback_" + second),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.api("GET", "/units/" + second)).data.status,
    "in_stock",
  );
  assert.equal(
    (
      await f.api("POST", "/sales-orders", {
        ...sale([second], "no_reason_" + second),
        items: [{ unitId: second, priceVersion: 1, price: "1250" }],
      })
    ).status,
    400,
  );
  await assert.rejects(
    f.pool.execute("UPDATE sales_items SET price=1 WHERE order_id=?", [
      order.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  const boss = (await f.api("GET", "/sales-orders/" + order.id)).data;
  assert.equal(boss.profit, 300.46);
  assert.equal(boss.items[0].cost, 1000.12);
  assert.equal(
    (await f.api("GET", "/sales-orders/" + order.id, undefined, "customer"))
      .status,
    403,
  );
});
test("真实退款：差价累计上限、退货复检、同请求重放与旧订单不可重复退货", async () => {
  const id = await unit(),
    request = sale([id], "refund_sale_" + id);
  let r = await f.api("POST", "/sales-orders", request);
  assert.equal(r.status, 200);
  const order = r.data,
    item = order.items[0];
  const adjustment = {
    requestKey: "adj_" + id,
    kind: "adjustment",
    items: [{ itemId: item.id, amount: "100.25" }],
    reason: "验证差价退款",
  };
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales-orders/" + order.id + "/refund",
        adjustment,
        "sales",
      )
    ).status,
    403,
  );
  const replay = await Promise.all(
    [1, 2].map(() =>
      f.api("POST", "/sales-orders/" + order.id + "/refund", adjustment),
    ),
  );
  assert.ok(replay.every((x) => x.status === 200));
  assert.equal(replay[0].data.refunds.length, 1);
  assert.equal(replay[1].data.refunds.length, 1);
  r = replay[0];
  assert.equal(r.status, 200);
  assert.equal(r.data.netAmount, 1200.33);
  assert.equal(r.data.profit, 200.21);
  assert.equal((await f.api("GET", "/units/" + id)).data.status, "sold");
  assert.equal(
    (
      await f.api("POST", "/sales-orders/" + order.id + "/refund", {
        ...adjustment,
        requestKey: "too_" + id,
        items: [{ itemId: item.id, amount: "1300" }],
      })
    ).status,
    400,
  );
  const back = {
    requestKey: "return_" + id,
    kind: "return",
    items: [{ itemId: item.id }],
    reason: "验证退货入复检",
  };
  r = await f.api("POST", "/sales-orders/" + order.id + "/refund", back);
  assert.equal(r.data.status, "refunded");
  assert.equal(r.data.refundAmount, 1300.58);
  assert.equal(r.data.profit, 0);
  assert.equal(
    (await f.api("POST", "/sales-orders/" + order.id + "/refund", back)).data
      .refundAmount,
    1300.58,
  );
  assert.equal((await f.api("GET", "/units/" + id)).data.status, "recheck");
  assert.equal(
    (
      await f.api("POST", "/sales-orders/" + order.id + "/refund", {
        ...back,
        requestKey: "again_" + id,
      })
    ).status,
    409,
  );
  await f.restart();
  assert.equal(
    (await f.api("GET", "/sales-orders/" + order.id)).data.amount,
    1300.58,
  );
  const form = (await f.api("GET", "/units/" + id + "/recheck-form")).data;
  r = await f.api("POST", "/units/" + id + "/recheck", {
    result: "pass",
    reason: "退货检查通过",
    inspectionVersion: form.inspectionVersion,
    attributes: {},
  });
  assert.equal(r.status, 200);
  const resold = await f.api(
    "POST",
    "/sales-orders",
    sale([id], "resell_" + id),
  );
  assert.equal(resold.status, 200);
  assert.equal(
    (
      await f.api("POST", "/sales-orders/" + order.id + "/refund", {
        ...back,
        requestKey: "old_" + id,
      })
    ).status,
    409,
  );
});
test("真实统计：型号按成交/退款快照汇总、利润裁剪和空日期补零", async () => {
  const r = await f.api("GET", "/stats/breakdown?dimension=model");
  assert.equal(r.status, 200);
  const row = r.data.list.find((x) => x.key === model.id);
  assert.equal(row.qty, 3);
  assert.equal(row.returnedQty, 1);
  assert.equal(row.amount, 2601.16);
  assert.equal(row.profit, 600.92);
  const sales = await f.api(
    "GET",
    "/stats/breakdown?dimension=model",
    undefined,
    "sales",
  );
  assert.equal(
    sales.data.list.find((x) => x.key === model.id).profit,
    undefined,
  );
  const empty = await f.api(
    "GET",
    "/stats/trend?from=2090-01-01&to=2090-01-03",
  );
  assert.equal(empty.status, 200);
  assert.equal(empty.data.list.length, 3);
  assert.ok(empty.data.list.every((x) => x.amount === 0));
  assert.equal(
    (await f.api("GET", "/stats/overview?from=2090-02-01&to=2090-01-01"))
      .status,
    400,
  );
  assert.equal(
    (await f.api("GET", "/stats/overview", undefined, "customer")).status,
    403,
  );
});

test("销售员筛选：选项只列出有销售单的员工，按 sellerId 过滤", async () => {
  const id = await unit();
  const r = await f.api(
    "POST",
    "/sales-orders",
    sale([id], "seller_" + id),
    "sales",
  );
  assert.equal(r.status, 200, r.message);
  const sellers = await f.api(
    "GET",
    "/sales-orders/sellers",
    undefined,
    "sales",
  );
  assert.equal(sellers.status, 200);
  assert.ok(sellers.data.some((s) => s.id === f.users.sales && s.name));
  const list = await f.api(
    "GET",
    "/sales-orders?pageSize=100&sellerId=" + f.users.sales,
    undefined,
    "boss",
  );
  assert.ok(list.data.list.length > 0);
  assert.ok(list.data.list.every((o) => o.sellerId === f.users.sales));
  assert.ok(list.data.list.some((o) => o.id === r.data.id));
  assert.equal(
    (await f.api("GET", "/sales-orders/sellers", undefined, "customer")).status,
    403,
  );
});

test("收款凭证：开单可选上传、补传需说明且可重试、按销售权限读取、不能跨单或跨业务复用", async () => {
  const mine = await f.upload("internal", "sales"),
    boss = await f.upload("internal", "boss"),
    pub = await f.upload("public", "boss");
  const id = await unit();
  // 不能引用他人的或公开图片
  for (const [file, status] of [
    [boss, 403],
    [pub, 400],
  ]) {
    const bad = await f.api(
      "POST",
      "/sales-orders",
      { ...sale([id], "receipt_bad_" + file.fileId), receipts: [file] },
      "sales",
    );
    assert.equal(bad.status, status, bad.message);
  }
  const created = await f.api(
    "POST",
    "/sales-orders",
    { ...sale([id], "receipt_" + id), receipts: [{ fileId: mine.fileId }] },
    "sales",
  );
  assert.equal(created.status, 200, created.message);
  let detail = (
    await f.api("GET", "/sales-orders/" + created.data.id, undefined, "sales")
  ).data;
  assert.deepEqual(
    detail.receipts.map((x) => x.fileId),
    [mine.fileId],
  );
  assert.ok(detail.receipts[0].url);
  // 库管没有销售权限，看不到收款凭证；老板可以
  assert.equal(
    (await f.api("GET", "/files/" + mine.fileId, undefined, "warehouse"))
      .status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/files/" + mine.fileId, undefined, "boss")).status,
    200,
  );
  // 补传：缺说明拒绝；成功后原样重试不重复；库管无权补传
  const more = await f.upload("internal", "sales"),
    body = { receipts: [{ fileId: more.fileId }], reason: "补传小票" },
    url = "/sales-orders/" + created.data.id + "/receipts";
  assert.equal(
    (await f.api("POST", url, { receipts: body.receipts }, "sales")).status,
    400,
  );
  assert.equal((await f.api("POST", url, body, "warehouse")).status, 403);
  detail = (await f.api("POST", url, body, "sales")).data;
  // R2-4：退款首次与重放都返回完整详情，不丢收款凭证/代理来源
  const refund = {
    requestKey: "receipt_refund_" + created.data.id,
    kind: "adjustment",
    reason: "回包验证差价",
    items: [{ itemId: detail.items[0].id, amount: "1" }],
  };
  for (let i = 0; i < 2; i++) {
    const r = await f.api(
      "POST",
      "/sales-orders/" + created.data.id + "/refund",
      refund,
    );
    assert.equal(r.status, 200, r.message);
    assert.equal(r.data.receipts.length, 2);
    assert.deepEqual(r.data.agentSources, []);
  }
  assert.equal(detail.receipts.length, 2);
  assert.equal(
    (await f.api("POST", url, body, "sales")).data.receipts.length,
    2,
  );
  const [logs] = await f.admin.execute(
    "SELECT COUNT(*) n FROM audit_logs WHERE action='补传收款凭证' AND object_id=?",
    [created.data.id],
  );
  assert.equal(Number(logs[0].n), 1);
  // 已关联的凭证不能用于另一张销售单或入库
  const other = await unit();
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales-orders",
        {
          ...sale([other], "receipt_reuse_" + other),
          receipts: [{ fileId: mine.fileId }],
        },
        "sales",
      )
    ).status,
    409,
  );
  const reused = JSON.parse(
    JSON.stringify(payload).replace(
      /"fileId":"[^"]+"/,
      '"fileId":"' + mine.fileId + '"',
    ),
  );
  const inbound = await f.api("POST", "/inbound/units", {
    ...reused,
    imei1: imei(),
  });
  assert.equal(inbound.status, 400);
  assert.match(inbound.message, /收款凭证/);
});
