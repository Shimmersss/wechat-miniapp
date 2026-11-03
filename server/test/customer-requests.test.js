const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
let f, payload, model;
test.before(async () => {
  f = await fixture(["boss", "sales", "customer", "peer", "warehouse"]);
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "咨询验证_" + Date.now(),
      brandLabel: "意向",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const t = (await f.api("GET", "/templates/" + model.templateId)).data,
    s = (await f.api("POST", "/suppliers", { name: "咨询货源_" + Date.now() }))
      .data,
    r = await f.upload();
  payload = {
    modelId: model.id,
    templateVersion: t.version,
    supplierId: s.id,
    inspectionConfirmed: true,
    attributes: attributes(t, r),
    cost: "1000.12",
    retail: "1300.58",
    wholesale: "1200.25",
    agentBase: "1100",
    flags: { showInShop: true, sharePeer: true, shareAgent: false },
  };
});
test.after(async () => f?.close());
async function unit() {
  const r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: imei(),
  });
  assert.equal(r.status, 200, r.message);
  return r.data.id;
}
const body = (id, key) => ({
  unitId: id,
  requestKey: key,
  phone: "13800000001",
  name: "验证顾客",
  content: "想了解电池和到店核验",
});
const headers = (id) => ({ "X-Channel": id });
test("咨询/预约实际落库：双提交幂等、来源快照、账号隔离、电话日期校验与不可改原单", async () => {
  const u = await unit(),
    share = (
      await f.api("POST", "/share/links", { unitId: u, channel: "customer" })
    ).data,
    b = body(u, "consult_" + u);
  assert.equal((await f.api("POST", "/shop/consults", b, null)).status, 401);
  const responses = await Promise.all(
    [1, 2].map(() =>
      f.api("POST", "/shop/consults", b, "customer", headers(share.shareId)),
    ),
  );
  assert.ok(
    responses.every((r) => r.status === 200),
    JSON.stringify(responses),
  );
  const c = responses[0].data;
  assert.equal(c.id, responses[1].data.id);
  assert.equal(c.status, "new");
  assert.equal(c.unit.price, 1300.58);
  assert.equal(c.source, "customer");
  assert.equal(c.shareOwnerId, undefined);
  assert.equal(c.unit.imei1, undefined);
  assert.equal(c.unit.cost, undefined);
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        { ...b, phone: "13800000002" },
        "customer",
        headers(share.shareId),
      )
    ).status,
    409,
  );
  assert.equal(
    (await f.api("GET", "/shop/requests/" + c.id, undefined, "peer")).status,
    404,
  );
  assert.ok(
    !(await f.api("GET", "/shop/requests", undefined, "peer")).data.list.some(
      (i) => i.id === c.id,
    ),
  );
  assert.equal(
    (await f.api("GET", "/customer-requests/" + c.id, undefined, "warehouse"))
      .status,
    403,
  );
  const staff = (
    await f.api("GET", "/customer-requests/" + c.id, undefined, "sales")
  ).data;
  assert.equal(staff.phone, b.phone);
  assert.equal(staff.shareOwnerId, f.users.boss);
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        { ...b, requestKey: "bad_" + u, phone: "110" },
        "customer",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        { ...b, requestKey: "fake_" + u },
        "customer",
        headers("agent_forged"),
      )
    ).status,
    404,
  );
  const o = (await f.api("GET", "/shop/contact-options", undefined, null)).data,
    appointment = {
      ...body(u, "appointment_" + u),
      date: o.minDate,
      timeSlot: o.timeSlots[0],
    };
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/appointments",
        { ...appointment, date: "2026-99-99" },
        "customer",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/appointments",
        { ...appointment, date: "2000-01-01" },
        "customer",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/appointments",
        { ...appointment, timeSlot: "凌晨虚构时段" },
        "customer",
      )
    ).status,
    400,
  );
  const ap = await f.api("POST", "/shop/appointments", appointment, "customer");
  assert.equal(ap.status, 200, ap.message);
  assert.equal(ap.data.date, o.minDate);
  assert.equal((await f.api("GET", "/units/" + u)).data.status, "in_stock");
  await f.api("PATCH", "/share/links/" + share.shareId + "/revoke", {
    reason: "旧分享撤销",
  });
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        b,
        "customer",
        headers(share.shareId),
      )
    ).data.id,
    c.id,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        { ...b, requestKey: "new_revoked_" + u },
        "customer",
        headers(share.shareId),
      )
    ).status,
    404,
  );
  await assert.rejects(
    f.pool.execute("UPDATE customer_requests SET phone=? WHERE id=?", [
      "100",
      c.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await f.restart();
  assert.equal(
    (await f.api("GET", "/shop/requests/" + c.id, undefined, "customer")).data
      .phone,
    b.phone,
  );
  const stats = (await f.api("GET", "/stats/visits")).data;
  assert.ok(stats.consults >= 1);
  assert.ok(stats.appointments >= 1);
  assert.equal(stats.phone, undefined);
});
test("员工跟进与本人取消：内部备注裁剪、版本并发、丢失响应重试与终态守卫", async () => {
  const u = await unit(),
    c = (
      await f.api("POST", "/shop/consults", body(u, "follow_" + u), "customer")
    ).data;
  const action = {
    status: "contacted",
    version: 1,
    requestKey: "handle_" + c.id,
    reason: "内部跟进内容不可给顾客看",
  };
  const updates = await Promise.all(
    [1, 2].map(() =>
      f.api("PATCH", "/customer-requests/" + c.id + "/status", action, "sales"),
    ),
  );
  assert.ok(
    updates.every((r) => r.status === 200),
    JSON.stringify(updates),
  );
  assert.equal(updates[0].data.version, 2);
  const publicView = (
    await f.api("GET", "/shop/requests/" + c.id, undefined, "customer")
  ).data;
  assert.ok(!JSON.stringify(publicView).includes(action.reason));
  assert.equal(publicView.status, "contacted");
  assert.equal(
    (await f.api("GET", "/customer-requests/" + c.id)).data.timeline.at(-1)
      .note,
    action.reason,
  );
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/customer-requests/" + c.id + "/status",
        { ...action, requestKey: "stale_" + c.id, status: "closed" },
        "sales",
      )
    ).status,
    409,
  );
  const cancel = {
    version: 2,
    reason: "暂时不需要了",
    requestKey: "cancel_" + c.id,
  };
  assert.equal(
    (await f.api("PATCH", "/shop/requests/" + c.id + "/cancel", cancel, "peer"))
      .status,
    404,
  );
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/shop/requests/" + c.id + "/cancel",
        cancel,
        "customer",
      )
    ).data.status,
    "cancelled",
  );
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/shop/requests/" + c.id + "/cancel",
        cancel,
        "customer",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/customer-requests/" + c.id + "/status",
        {
          status: "contacted",
          version: 3,
          reason: "不允许恢复",
          requestKey: "after_" + c.id,
        },
        "sales",
      )
    ).status,
    409,
  );
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM customer_request_events WHERE request_id=?",
          [c.id],
        )
      ).n,
    ),
    3,
  );
  await assert.rejects(
    f.pool.execute(
      "UPDATE customer_request_events SET note=? WHERE request_id=?",
      ["篡改", c.id],
    ),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
});
test("意向成交同事务：沿用核验分享归因，以现价收银，禁止错设备/取消意向与重复归因", async () => {
  const u = await unit(),
    other = await unit(),
    share = (
      await f.api("POST", "/share/links", { unitId: u, channel: "customer" })
    ).data,
    c = (
      await f.api(
        "POST",
        "/shop/consults",
        body(u, "sale_intent_" + u),
        "customer",
        headers(share.shareId),
      )
    ).data;
  const sale = {
    requestKey: "sale_referral_" + u,
    customerRequestId: c.id,
    payMethod: "现金",
    paymentConfirmed: true,
    items: [{ unitId: other, priceVersion: 1 }],
  };
  assert.equal(
    (await f.api("POST", "/sales-orders", sale, "sales")).status,
    400,
  );
  assert.equal((await f.api("GET", "/units/" + other)).data.status, "in_stock");
  await f.api("PATCH", "/units/" + u + "/price", {
    retail: "1400.66",
    priceVersion: 1,
    reason: "当前售价更新",
  });
  sale.items = [{ unitId: u, priceVersion: 2 }];
  let result = await f.api("POST", "/sales-orders", sale, "sales");
  assert.equal(result.status, 200, result.message);
  assert.equal(result.data.amount, 1400.66);
  assert.equal(result.data.customerRequestId, c.id);
  assert.equal(result.data.shareOwnerId, f.users.boss);
  const order = result.data;
  assert.equal(
    (await f.api("POST", "/sales-orders", sale, "sales")).data.id,
    order.id,
  );
  assert.equal(
    Number(
      (
        await one(
          f.pool,
          "SELECT COUNT(*) n FROM sales_attributions WHERE customer_request_id=?",
          [c.id],
        )
      ).n,
    ),
    1,
  );
  assert.equal(
    (await f.api("GET", "/shop/requests/" + c.id, undefined, "customer")).data
      .saleRecorded,
    true,
  );
  assert.equal(
    (await f.api("GET", "/shop/requests/" + c.id, undefined, "customer")).data
      .status,
    "closed",
  );
  await assert.rejects(
    f.pool.execute("UPDATE sales_attributions SET source=? WHERE order_id=?", [
      "agent",
      order.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  const cancelled = (
    await f.api(
      "POST",
      "/shop/consults",
      body(other, "cancel_before_sale_" + other),
      "customer",
    )
  ).data;
  await f.api(
    "PATCH",
    "/shop/requests/" + cancelled.id + "/cancel",
    { requestKey: "cancel_sale_" + other, version: 1, reason: "取消意向" },
    "customer",
  );
  result = await f.api(
    "POST",
    "/sales-orders",
    {
      ...sale,
      requestKey: "cancelled_sale_" + other,
      customerRequestId: cancelled.id,
      items: [{ unitId: other, priceVersion: 1 }],
    },
    "sales",
  );
  assert.equal(result.status, 409);
  assert.equal((await f.api("GET", "/units/" + other)).data.status, "in_stock");
});

test("取消与收银并发：旧事务快照不能覆盖已提交取消，失败销售不扣库不写归因", async () => {
  const u = await unit(),
    created = (
      await f.api(
        "POST",
        "/shop/consults",
        body(u, "race_intent_" + u),
        "customer",
      )
    ).data;
  const blocker = await f.pool.getConnection();
  let pending;
  try {
    await blocker.beginTransaction();
    await blocker.execute("SELECT id FROM units WHERE id=? FOR UPDATE", [u]);
    pending = f.api(
      "POST",
      "/sales-orders",
      {
        requestKey: "race_sale_" + u,
        customerRequestId: created.id,
        payMethod: "现金",
        paymentConfirmed: true,
        items: [{ unitId: u, priceVersion: 1 }],
      },
      "sales",
    );
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const result = await one(
        f.admin,
        "SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN information_schema.innodb_trx b ON b.trx_id=w.BLOCKING_ENGINE_TRANSACTION_ID WHERE b.trx_mysql_thread_id=?",
        [blocker.threadId],
      );
      if (Number(result.n) > 0) {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(waiting, true, "须实际观察收银事务等待本台库存锁");
    const cancelled = await f.api(
      "PATCH",
      "/shop/requests/" + created.id + "/cancel",
      { requestKey: "race_cancel_" + u, version: 1, reason: "取消早于成交" },
      "customer",
    );
    assert.equal(cancelled.status, 200, cancelled.message);
    await blocker.commit();
    const result = await pending;
    assert.equal(result.status, 409, result.message);
    assert.equal((await f.api("GET", "/units/" + u)).data.status, "in_stock");
    assert.equal(
      (
        await f.api(
          "GET",
          "/shop/requests/" + created.id,
          undefined,
          "customer",
        )
      ).data.status,
      "cancelled",
    );
    assert.equal(
      Number(
        (
          await one(
            f.pool,
            "SELECT COUNT(*) n FROM sales_attributions WHERE customer_request_id=?",
            [created.id],
          )
        ).n,
      ),
      0,
    );
  } finally {
    await blocker.rollback();
    blocker.release();
    if (pending) await pending;
  }
});

test("同行意向按当前身份裁剪历史快照，客户端不能自报报价或归因", async () => {
  const u = await unit();
  await f.api("PATCH", "/units/" + u + "/share-flags", { showInShop: false });
  const share = (
    await f.api("POST", "/share/links", { unitId: u, channel: "peer" })
  ).data;
  const b = body(u, "peer_contact_" + u);
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/consults",
        { ...b, price: 1 },
        "peer",
        headers(share.shareId),
      )
    ).status,
    400,
  );
  const result = await f.api(
    "POST",
    "/shop/consults",
    b,
    "peer",
    headers(share.shareId),
  );
  assert.equal(result.status, 200, result.message);
  assert.equal(result.data.unit.price, 1200.25);
  await f.admin.execute("UPDATE users SET role='customer' WHERE id=?", [
    f.users.peer,
  ]);
  try {
    const own = (
      await f.api("GET", "/shop/requests/" + result.data.id, undefined, "peer")
    ).data;
    assert.equal(own.phone, b.phone);
    assert.equal(own.unit.price, undefined);
    assert.equal(own.unit.publicFields, undefined);
    assert.equal(own.shareOwnerId, undefined);
  } finally {
    await f.admin.execute("UPDATE users SET role='peer' WHERE id=?", [
      f.users.peer,
    ]);
  }
});
