const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
let f,
  g,
  photo,
  model,
  payload,
  seq = 0;
const key = () => "repair_fixture_" + Date.now() + "_" + ++seq;
test.before(async () => {
  f = await fixture([
    "boss",
    "manager",
    "engineer",
    "finance",
    "purchaser",
    "warehouse",
    "sales",
    "customer",
  ]);
  g = await fixture(["engineer"]);
  photo = await f.upload("internal");
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "维修自有机_" + Date.now(),
      brandLabel: "维修",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const template = (await f.api("GET", "/templates/" + model.templateId)).data,
    receipt = await f.upload(),
    supplier = (
      await f.api("POST", "/suppliers", { name: "维修货源_" + Date.now() })
    ).data;
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, receipt),
    cost: "1000.12",
    retail: "1300.58",
    wholesale: "1200.25",
    agentBase: "1100",
    flags: { showInShop: true, sharePeer: true, shareAgent: false },
  };
});
test.after(async () => {
  await f?.close();
  await g?.close();
});
async function external(engineerId = f.users.engineer) {
  const r = await f.api("POST", "/repair-orders", {
    requestKey: key(),
    kind: "external",
    model: "外部送修验证",
    identifier: imei(),
    customer: "验证顾客",
    phone: "13800000001",
    fault: "不能正常充电",
    engineerId,
    photos: [{ fileId: photo.fileId }],
  });
  assert.equal(r.status, 200, r.message);
  return r.data;
}
async function action(order, path, data, role = "engineer") {
  const result = await f.api(
    path === "update" ? "PUT" : "POST",
    "/repair-orders/" + order.id + (path === "update" ? "" : "/" + path),
    {
      requestKey: key(),
      version: order.version,
      reason: "真实数据库验证处理",
      ...data,
    },
    role,
  );
  assert.equal(result.status, 200, result.message);
  return result.data;
}
async function started(order) {
  let r = await action(order, "transition", { to: "checking" });
  r = await action(r, "update", { diagnosis: "已完成检测，需更换配件" });
  r = await action(r, "quote", { amount: "0" }, "boss");
  r = await action(r, "transition", { to: "pending_confirm" });
  r = await action(
    r,
    "confirm",
    { quoteVersion: r.quoteVersion, confirmed: true },
    r.kind === "inventory" ? "boss" : "engineer",
  );
  return action(r, "transition", { to: "repairing" });
}
async function part(qty = 3, price = "10.01") {
  const r = await f.api("POST", "/repair-parts", {
    sku: key(),
    name: "验证配件",
    unit: "件",
  });
  assert.equal(r.status, 200, r.message);
  const p = await f.api("POST", "/repair-parts/" + r.data.id + "/receive", {
    quantity: qty,
    unitCost: price,
    version: r.data.version,
    reason: "实际配件入库",
    requestKey: key(),
  });
  assert.equal(p.status, 200, p.message);
  return p.data;
}
test("维修真实权限/内部图片/节点：工程师仅本人，密码不保存，报价/确认版本不可绕过", async () => {
  let order = await external();
  const first = order;
  assert.equal(order.status, "pending_check");
  assert.equal(
    (await f.api("GET", "/repair-orders/" + order.id, undefined, "customer"))
      .status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/repair-orders/" + order.id, undefined, "sales"))
      .status,
    403,
  );
  assert.equal(
    (
      await f.api("GET", "/repair-orders/" + order.id, undefined, null, {
        Authorization: "Bearer " + g.tokens.engineer,
      })
    ).status,
    404,
  );
  const eng = (
    await f.api("GET", "/repair-orders/" + order.id, undefined, "engineer")
  ).data;
  assert.equal(eng.identifier, undefined);
  assert.equal(eng.partsCost, undefined);
  assert.equal(eng.expenses, undefined);
  assert.equal(eng.profit, undefined);
  assert.equal(eng.files[0].scope, "internal");
  assert.equal((await fetch(eng.files[0].url)).status, 200);
  assert.equal(
    (await f.api("GET", "/files/" + photo.fileId, undefined, "purchaser"))
      .status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/files/" + photo.fileId, undefined, "engineer"))
      .status,
    200,
  );
  await assert.rejects(f.upload("public", "engineer"));
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders",
        {
          requestKey: key(),
          model: "不存密码",
          customer: "测试",
          phone: "13800000001",
          fault: "故障",
          password: "secret",
        },
        "engineer",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/transition",
        {
          requestKey: key(),
          version: order.version,
          reason: "不能跳过检测",
          to: "repairing",
        },
        "engineer",
      )
    ).status,
    409,
  );
  order = await action(order, "transition", { to: "checking" });
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/quote",
        {
          requestKey: key(),
          version: order.version,
          reason: "无权报价",
          amount: "1",
        },
        "engineer",
      )
    ).status,
    403,
  );
  order = await action(order, "update", { diagnosis: "检测报告" });
  order = await action(order, "quote", { amount: "550.25" }, "boss");
  order = await action(order, "transition", { to: "pending_confirm" });
  order = await action(order, "confirm", {
    quoteVersion: order.quoteVersion,
    confirmed: true,
  });
  order = await action(order, "quote", { amount: "600.25" }, "boss");
  assert.equal(order.confirmedVersion, null);
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/transition",
        {
          requestKey: key(),
          version: order.version,
          reason: "旧确认不得开工",
          to: "repairing",
        },
        "engineer",
      )
    ).status,
    409,
  );
  order = await action(order, "confirm", {
    quoteVersion: order.quoteVersion,
    confirmed: true,
  });
  order = await action(order, "transition", { to: "repairing" });
  const media = (
    await f.api("GET", "/repair-orders/" + order.id, undefined, "engineer")
  ).data.files[0];
  order = await action(
    order,
    "update",
    { engineerId: g.users.engineer },
    "boss",
  );
  assert.equal((await fetch(media.url)).status, 403);
  assert.equal(
    (await f.api("GET", "/repair-orders/" + order.id, undefined, "engineer"))
      .status,
    404,
  );
  await assert.rejects(
    f.pool.execute("UPDATE repair_events SET note=? WHERE order_id=?", [
      "篡改",
      first.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await f.restart();
  assert.equal(
    (await f.api("GET", "/repair-orders/" + order.id)).data.engineerId,
    g.users.engineer,
  );
});
test("外部维修：配件领退/收退款/取机与毛利真实核算，操作重放不重复扣料", async () => {
  let order = await started(await external());
  order = await action(order, "transition", {
    to: "pending_pickup",
    result: "维修已完成",
  });
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/transition",
        {
          requestKey: key(),
          version: order.version,
          reason: "缺凭证",
          to: "completed",
          pickupName: "顾客",
          warrantyDays: 30,
        },
        "engineer",
      )
    ).status,
    400,
  );
  // Start a separate paid job to exercise part use and receipts.
  let paid = await external();
  paid = await action(paid, "transition", { to: "checking" });
  paid = await action(paid, "update", { diagnosis: "需换件" });
  paid = await action(paid, "quote", { amount: "550.25" }, "boss");
  paid = await action(paid, "transition", { to: "pending_confirm" });
  paid = await action(paid, "confirm", {
    quoteVersion: paid.quoteVersion,
    confirmed: true,
  });
  paid = await action(paid, "transition", { to: "repairing" });
  const p = await part(),
    body = {
      requestKey: key(),
      version: paid.version,
      reason: "领用两件",
      partId: p.id,
      quantity: 2,
    };
  let result = await f.api(
    "POST",
    "/repair-orders/" + paid.id + "/parts/issue",
    body,
    "engineer",
  );
  assert.equal(result.status, 200, result.message);
  paid = result.data;
  assert.equal(paid.parts[0].cost, undefined);
  assert.equal(paid.timeline.at(-1).costData, undefined);
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + paid.id + "/parts/issue",
        body,
        "engineer",
      )
    ).status,
    200,
  );
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM repair_part_ledger WHERE order_id=? AND kind='issue'",
          [paid.id],
        )
      ).n,
    ),
    1,
  );
  paid = await action(paid, "parts/return", {
    issueId: paid.parts[0].id,
    quantity: 1,
  });
  assert.equal(
    (await f.api("GET", "/repair-orders/" + paid.id)).data.partsCost,
    10.01,
  );
  assert.equal(
    (await f.api("GET", "/repair-parts?keyword="+encodeURIComponent(p.sku), undefined, "engineer")).data.list.find(
      (i) => i.id === p.id,
    ).stockValue,
    undefined,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + paid.id + "/payment",
        {
          requestKey: key(),
          version: paid.version,
          reason: "工程师不能收款",
          kind: "receipt",
          amount: "550.25",
          method: "现金",
          confirmed: true,
        },
        "engineer",
      )
    ).status,
    403,
  );
  paid = await action(
    paid,
    "payment",
    { kind: "receipt", amount: "550.25", method: "现金", confirmed: true },
    "finance",
  );
  paid = await action(
    paid,
    "payment",
    { kind: "expense", amount: "2.02", method: "现金", confirmed: true },
    "finance",
  );
  paid = await action(paid, "transition", {
    to: "pending_pickup",
    result: "更换完成，功能复测正常",
  });
  const proof = await f.upload("internal", "engineer");
  paid = await action(paid, "transition", {
    to: "completed",
    pickupName: "验证取机人",
    pickupProof: [{ fileId: proof.fileId }],
    warrantyDays: 30,
  });
  assert.equal(paid.status, "completed");
  paid = await action(
    paid,
    "payment",
    { kind: "refund", amount: "1.25", method: "现金", confirmed: true },
    "finance",
  );
  assert.equal(paid.received, 549);
  assert.equal(paid.profit, 536.97);
  assert.equal(paid.partsCost, 10.01);
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + paid.id + "/payment",
        {
          requestKey: key(),
          version: paid.version,
          reason: "不能超退",
          kind: "refund",
          amount: "550",
          method: "现金",
          confirmed: true,
        },
        "finance",
      )
    ).status,
    400,
  );
  await assert.rejects(
    f.pool.execute("UPDATE repair_payments SET amount=0 WHERE order_id=?", [
      paid.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
});
test("本店送修关共享且不可售，完工转复检并只记一次实际配件/费用成本", async () => {
  const u = (
      await f.api("POST", "/inbound/units", { ...payload, imei1: imei() })
    ).data,
    share = (
      await f.api("POST", "/share/links", { unitId: u.id, channel: "customer" })
    ).data;
  let order = (
    await f.api("POST", "/repair-orders", {
      requestKey: key(),
      kind: "inventory",
      unitId: u.id,
      fault: "店内复测异常",
      engineerId: f.users.engineer,
    })
  ).data;
  assert.ok(order.id);
  assert.equal((await f.api("GET", "/units/" + u.id)).data.status, "repairing");
  assert.equal(
    (await f.api("GET", "/shop/shares/" + share.shareId, undefined, null))
      .status,
    410,
  );
  assert.equal(
    (await f.api("GET", "/sales/lookup?code=" + u.id, undefined, "sales"))
      .status,
    409,
  );
  order = await started(order);
  const p = await part(1);
  order = await action(order, "parts/issue", { partId: p.id, quantity: 1 });
  order = await action(
    order,
    "payment",
    { kind: "expense", amount: "2.02", method: "现金", confirmed: true },
    "finance",
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/payment",
        {
          requestKey: key(),
          version: order.version,
          reason: "本店不对客收款",
          kind: "receipt",
          amount: "1",
          method: "现金",
          confirmed: true,
        },
        "finance",
      )
    ).status,
    400,
  );
  order = await action(order, "transition", {
    to: "pending_pickup",
    result: "已修复待复检",
  });
  const proof = await f.upload("internal");
  const body = {
    requestKey: key(),
    version: order.version,
    reason: "交回库存复检",
    to: "completed",
    pickupName: "库管",
    pickupProof: [{ fileId: proof.fileId }],
    warrantyDays: 0,
  };
  let result = await f.api(
    "POST",
    "/repair-orders/" + order.id + "/transition",
    body,
    "boss",
  );
  assert.equal(result.status, 200, result.message);
  assert.equal(
    (
      await f.api(
        "POST",
        "/repair-orders/" + order.id + "/transition",
        body,
        "boss",
      )
    ).status,
    200,
  );
  const current = (await f.api("GET", "/units/" + u.id)).data;
  assert.equal(current.status, "recheck");
  assert.equal(current.cost, 1012.15);
  assert.equal(current.flags.showInShop, false);
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM repair_cost_allocations WHERE order_id=?",
          [order.id],
        )
      ).n,
    ),
    1,
  );
  await assert.rejects(
    f.pool.execute(
      "UPDATE repair_cost_allocations SET total_cost=0 WHERE order_id=?",
      [order.id],
    ),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
});
test("配件加权分摊守恒与库存并发：不足不透支，部分退料沿原领用成本", async () => {
  const p = await part(2, "0.01");
  let r = await f.api("POST", "/repair-parts/" + p.id + "/receive", {
    requestKey: key(),
    version: p.version,
    quantity: 1,
    unitCost: "0.02",
    reason: "第二批实际成本",
  });
  assert.equal(r.status, 200, r.message);
  let order = await started(await external());
  order = await action(
    order,
    "parts/issue",
    { partId: p.id, quantity: 2 },
    "boss",
  );
  assert.equal(order.partsCost, 0.03);
  const issue = order.parts[0].id;
  order = await action(
    order,
    "parts/return",
    { issueId: issue, quantity: 1 },
    "boss",
  );
  assert.equal(order.partsCost, 0.01);
  order = await action(
    order,
    "parts/return",
    { issueId: issue, quantity: 1 },
    "boss",
  );
  assert.equal(order.partsCost, 0);
  const restored = await one(f.pool, "SELECT * FROM repair_parts WHERE id=?", [
    p.id,
  ]);
  assert.equal(restored.quantity, 3);
  assert.equal(Number(restored.stock_value), 0.04);
  const last = await part(1),
    a = await started(await external()),
    b = await started(await external());
  const results = await Promise.all(
    [a, b].map((o) =>
      f.api(
        "POST",
        "/repair-orders/" + o.id + "/parts/issue",
        {
          requestKey: key(),
          version: o.version,
          reason: "并发最后一件",
          partId: last.id,
          quantity: 1,
        },
        "engineer",
      ),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await one(f.pool, "SELECT quantity FROM repair_parts WHERE id=?", [
        last.id,
      ])
    ).quantity,
    0,
  );
});

test("维修统计按范围与权限取真实记录，空范围补零，来源工程师筛选生效", async () => {
  const empty = await f.api(
    "GET",
    "/repair-orders/stats?engineerId=00000000-0000-0000-0000-000000000000",
  );
  assert.equal(empty.status, 200, empty.message);
  assert.equal(empty.data.created, 0);
  assert.equal(empty.data.revenue, 0);
  assert.equal(empty.data.profit, 0);
  const own = await f.api("GET", "/repair-orders/stats", undefined, "engineer");
  assert.equal(own.status, 200, own.message);
  assert.ok(own.data.created >= 1);
  assert.equal(own.data.partsCost, undefined);
  assert.equal(own.data.expenses, undefined);
  assert.equal(own.data.profit, undefined);
  const finance = await f.api(
    "GET",
    "/repair-orders/stats",
    undefined,
    "finance",
  );
  assert.equal(finance.status, 200, finance.message);
  assert.equal(typeof finance.data.profit, "number");
  assert.equal(
    (await f.api("GET", "/repair-orders/stats", undefined, "customer")).status,
    403,
  );
});
test("外部串码活动占用与创建幂等：并发只一单，取消释放后才可入库存", async () => {
  const code = imei(),
    body = {
      requestKey: key(),
      kind: "external",
      model: "外部串码占用",
      identifier: code,
      customer: "验证顾客",
      phone: "13800000001",
      fault: "待检测",
      engineerId: f.users.engineer,
    };
  const results = await Promise.all(
    [1, 2].map(() => f.api("POST", "/repair-orders", body)),
  );
  assert.ok(
    results.every((r) => r.status === 200),
    JSON.stringify(results),
  );
  assert.equal(results[0].data.id, results[1].data.id);
  const order = results[0].data;
  assert.equal(
    (await f.api("POST", "/repair-orders", { ...body, requestKey: key() }))
      .status,
    409,
  );
  assert.equal(
    (await f.api("POST", "/inbound/units", { ...payload, imei1: code })).status,
    409,
  );
  await action(order, "transition", { to: "cancelled" });
  const inbound = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: code,
  });
  assert.equal(inbound.status, 200, inbound.message);
  assert.equal(
    (await f.api("POST", "/repair-orders", { ...body, requestKey: key() }))
      .status,
    409,
  );
  const file = (await external()).files[0];
  const bad = {
    ...payload,
    imei1: imei(),
    attributes: { ...payload.attributes, receipt: [{ fileId: file.fileId }] },
  };
  assert.equal((await f.api("POST", "/inbound/units", bad)).status, 400);
});
test("本店成本策略可配置，未知配置回滚；单列成本不重复改变库存采购成本", async () => {
  const u = (
    await f.api("POST", "/inbound/units", { ...payload, imei1: imei() })
  ).data;
  let order = (
    await f.api("POST", "/repair-orders", {
      requestKey: key(),
      kind: "inventory",
      unitId: u.id,
      fault: "检测撤销",
      engineerId: f.users.engineer,
    })
  ).data;
  order = await action(
    order,
    "payment",
    { kind: "expense", amount: "10.01", method: "现金", confirmed: true },
    "finance",
  );
  f.cfg.repair.internalCostPolicy = "invalid";
  try {
    assert.equal(
      (
        await f.api(
          "POST",
          "/repair-orders/" + order.id + "/transition",
          {
            requestKey: key(),
            version: order.version,
            reason: "配置错误不得记账",
            to: "cancelled",
          },
          "boss",
        )
      ).status,
      503,
    );
    assert.equal(
      (await f.api("GET", "/units/" + u.id)).data.status,
      "repairing",
    );
    f.cfg.repair.internalCostPolicy = "separate";
    const done = await action(order, "transition", { to: "cancelled" }, "boss");
    assert.equal(done.costAllocation.policy, "separate");
    assert.equal((await f.api("GET", "/units/" + u.id)).data.cost, 1000.12);
  } finally {
    f.cfg.repair.internalCostPolicy = "capitalize";
  }
});
