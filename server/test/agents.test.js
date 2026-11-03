const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers"),
  { client } = require("./page-helpers");
let f,
  boss,
  payload,
  seq = 0;
const key = () => "agent_" + Date.now() + "_" + ++seq;
const unit = async (shareAgent = true) =>
  (
    await boss.inbound.createUnit({
      ...payload,
      imei1: imei(),
      flags: { showInShop: true, sharePeer: false, shareAgent },
    })
  ).id;
const as = (role, shareId) => (method, url, body) =>
  f.api(method, url, body, role, shareId ? { "X-Channel": shareId } : {});
test.before(async () => {
  f = await fixture([
    "boss",
    "sales",
    "finance",
    "warehouse",
    "customer",
    "customer:b",
    "customer:c",
  ]);
  boss = client(f, "boss");
  const model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "代理验证_" + Date.now(),
      brandLabel: "代理",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const t = await boss.template.detail(model.templateId),
    proof = await f.upload(),
    s = (await f.api("POST", "/suppliers", { name: "代理货源_" + Date.now() }))
      .data;
  payload = {
    modelId: model.id,
    templateVersion: t.version,
    supplierId: s.id,
    attributes: attributes(t, proof),
    inspectionConfirmed: true,
    cost: "900",
    retail: "1300",
    wholesale: "1150",
    agentBase: "1100",
  };
});
test.after(async () => f?.close());

async function approve(role, markupMax) {
  const me = (await f.api("GET", "/agent/me", undefined, role)).data;
  const app = (
    await f.api(
      "GET",
      "/admin/agent-applications?keyword=" + encodeURIComponent(me.phone),
    )
  ).data.list.find((a) => a.id === f.users[role]);
  return f.api("POST", "/admin/agent-applications/" + app.id + "/review", {
    approve: true,
    remark: "资料核实",
    version: app.version,
    ...(markupMax !== undefined ? { markupMax } : {}),
  });
}

test("代理申请审核、一级邀请、默认/单独加价上限与权限", async () => {
  const apply = (role, body) =>
    f.api("POST", "/agent/applications", body, role);
  assert.equal(
    (
      await apply("customer", {
        name: "张三",
        phone: "13800000001",
        region: "深圳",
        agreed: false,
      })
    ).status,
    400,
  );
  let r = await apply("customer", {
    name: "张三",
    phone: "13800000001",
    region: "深圳",
    agreed: true,
  });
  assert.equal(r.data.status, "pending");
  assert.equal(
    (
      await apply("customer", {
        name: "张三",
        phone: "13800000001",
        region: "深圳",
        agreed: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await apply("sales", {
        name: "员工",
        phone: "13800000002",
        region: "深圳",
        agreed: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/admin/agent-applications", undefined, "sales"))
      .status,
    403,
  );
  r = await approve("customer", "300");
  assert.equal(r.status, 200);
  assert.equal(r.data.status, "active");
  assert.equal(r.data.markupMax, 300);
  const me = (await f.api("GET", "/agent/me", undefined, "customer")).data;
  assert.equal(me.status, "active");
  assert.equal(me.inviteCode.length, 8);

  const settings = (await f.api("GET", "/admin/agent-settings")).data;
  assert.equal(
    (
      await f.api("PUT", "/admin/agent-settings", {
        defaultMarkupMax: "150",
        version: settings.version + 9,
        reason: "旧版本",
      })
    ).status,
    409,
  );
  r = await f.api("PUT", "/admin/agent-settings", {
    defaultMarkupMax: "150",
    version: settings.version,
    reason: "老板定上限",
  });
  assert.equal(r.data.defaultMarkupMax, 150);
  assert.equal(
    (
      await apply("customer:b", {
        name: "李四",
        phone: "13800000003",
        region: "广州",
        agreed: true,
        inviteCode: "BADCODE1",
      })
    ).status,
    400,
  );
  r = await apply("customer:b", {
    name: "李四",
    phone: "13800000003",
    region: "广州",
    agreed: true,
    inviteCode: me.inviteCode,
  });
  assert.equal(r.data.inviterName, "张三");
  r = await approve("customer:b");
  assert.equal(r.data.markupMax, 150);
  assert.equal(r.data.inviterName, "张三");
  const invite = (await f.api("GET", "/agent/invite", undefined, "customer"))
    .data;
  assert.equal(invite.members[0].name, "李*");
  assert.equal(
    (await f.api("GET", "/agent/invite", undefined, "customer:c")).status,
    403,
  );
});

test("加价上限、代理分享价快照、链接下单锁库、按分享价成交记收益、转账与退货冲回", async () => {
  const agent = as("customer");
  const a = await unit(),
    hidden = await unit(false);
  assert.equal(
    (
      await agent("PUT", "/agent/units/" + hidden + "/markup", {
        markup: "100",
      })
    ).status,
    409,
  );
  assert.equal(
    (await agent("PUT", "/agent/units/" + a + "/markup", { markup: "301" }))
      .status,
    400,
  );
  let r = await agent("PUT", "/agent/units/" + a + "/markup", {
    markup: "200",
  });
  assert.equal(r.data.sharePrice, 1300);
  assert.equal(r.data.aboveRetail, false);
  assert.ok(
    (await agent("GET", "/agent/units?pageSize=100")).data.list.some(
      (u) => u.id === a,
    ),
  );
  assert.equal(
    (
      await agent("POST", "/share/links", {
        channel: "agent",
        unitIds: [hidden],
      })
    ).status,
    409,
  );
  const share = (
    await agent("POST", "/share/links", { channel: "agent", unitIds: [a] })
  ).data;
  assert.equal(share.units[0].price, 1300);
  assert.equal(share.units[0].priceType, "agent");
  const viewed = (
    await f.api("GET", "/shop/shares/" + share.shareId, undefined, "customer:c")
  ).data;
  assert.equal(viewed.units[0].price, 1300);
  assert.equal(viewed.units[0].agentBase, undefined);

  const order = (role, unitId = a) =>
    f.api(
      "POST",
      "/shop/orders",
      { requestKey: key(), unitId, name: "王五", phone: "13900000001" },
      role,
      { "X-Channel": share.shareId },
    );
  assert.equal((await order("customer")).status, 400);
  assert.equal(
    (
      await f.api(
        "POST",
        "/shop/orders",
        { requestKey: key(), unitId: a, name: "王五", phone: "13900000001" },
        "customer:c",
      )
    ).status,
    400,
  );
  const placed = await Promise.all([order("customer:c"), order("customer:b")]);
  // 同一台只能一单成功；另一单因设备已锁定被拒（链接整体失效 410 或锁库冲突 409）
  assert.equal(placed.filter((x) => x.status === 200).length, 1);
  assert.ok([409, 410].includes(placed.find((x) => x.status !== 200).status));
  const req = placed.find((x) => x.status === 200).data;
  assert.equal(req.kind, "order");
  assert.equal(req.agentOrder.sharePrice, 1300);
  assert.equal(req.agentOrder.markup, undefined);
  assert.equal((await f.api("GET", "/units/" + a)).data.status, "locked");

  const internal = (
    await f.api("GET", "/customer-requests/" + req.id, undefined, "sales")
  ).data;
  assert.equal(internal.agentOrder.markup, 200);
  assert.equal(internal.canStartSale, true);
  const unitView = (
    await f.api(
      "GET",
      "/sales/lookup?code=" + a + "&customerRequestId=" + req.id,
      undefined,
      "sales",
    )
  ).data;
  assert.equal(
    (await f.api("GET", "/sales/lookup?code=" + a, undefined, "sales")).status,
    409,
  );
  const item = {
    unitId: a,
    channel: "agent",
    priceVersion: unitView.priceVersion,
  };
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales/quote",
        { items: [{ ...item, channel: "retail" }] },
        "sales",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/sales/quote",
        { customerRequestId: req.id, items: [{ ...item, price: "1250" }] },
        "sales",
      )
    ).status,
    400,
  );
  const quote = (
    await f.api(
      "POST",
      "/sales/quote",
      { customerRequestId: req.id, items: [item] },
      "sales",
    )
  ).data;
  assert.equal(quote.total, 1300);
  const sale = (
    await f.api(
      "POST",
      "/sales-orders",
      {
        requestKey: key(),
        payMethod: "微信",
        paymentConfirmed: true,
        customerRequestId: req.id,
        items: [item],
      },
      "sales",
    )
  ).data;
  assert.equal(sale.amount, 1300);
  assert.equal((await f.api("GET", "/units/" + a)).data.status, "sold");
  let overview = (await agent("GET", "/agent/overview")).data;
  assert.equal(overview.soldOrders, 1);
  assert.equal(overview.pendingAmount, 200);
  const earning = (
    await f.api(
      "GET",
      "/admin/agent-earnings?status=pending",
      undefined,
      "finance",
    )
  ).data.list.find((e) => e.orderId === req.id);
  assert.equal(earning.amount, 200);
  assert.equal(
    (
      await f.api(
        "POST",
        "/admin/agent-earnings/settle",
        { ids: [earning.id], reason: "微信转账" },
        "warehouse",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/admin/agent-earnings/settle",
        { ids: [earning.id], reason: "微信转账" },
        "finance",
      )
    ).data.settled,
    1,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/admin/agent-earnings/settle",
        { ids: [earning.id], reason: "重复" },
        "finance",
      )
    ).status,
    409,
  );
  overview = (await agent("GET", "/agent/overview")).data;
  assert.equal(overview.settledAmount, 200);

  const itemId = sale.items[0].id;
  r = await f.api("POST", "/sales-orders/" + sale.id + "/refund", {
    requestKey: key(),
    kind: "return",
    reason: "顾客退货",
    items: [{ itemId }],
  });
  assert.equal(r.status, 200);
  const mine = (await agent("GET", "/agent/commissions")).data;
  assert.ok(
    mine.list.some(
      (e) =>
        e.kind === "reversal" && e.amount === -200 && e.status === "pending",
    ),
  );
  assert.equal(mine.summary.pendingAmount, -200);
  assert.equal(mine.summary.settledAmount, 200);
});

test("取消与到期释放锁库；未转账收益退货直接冲回；停用代理后分享失效", async () => {
  const agent = as("customer");
  const b = await unit(),
    c = await unit(),
    d = await unit();
  const share = (
    await agent("POST", "/share/links", {
      channel: "agent",
      unitIds: [b, c, d],
    })
  ).data;
  const order = (unitId) =>
    f.api(
      "POST",
      "/shop/orders",
      { requestKey: key(), unitId, name: "赵六", phone: "13900000002" },
      "customer:c",
      { "X-Channel": share.shareId },
    );
  let req = (await order(b)).data;
  const cancel = await f.api(
    "PATCH",
    "/shop/requests/" + req.id + "/cancel",
    { requestKey: key(), reason: "不要了", version: req.version },
    "customer:c",
  );
  assert.equal(cancel.data.status, "cancelled");
  assert.equal((await f.api("GET", "/units/" + b)).data.status, "in_stock");

  req = (await order(c)).data;
  await f.admin.execute(
    "UPDATE agent_orders SET lock_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 MINUTE) WHERE request_id=?",
    [req.id],
  );
  const orders = (await agent("GET", "/agent/orders")).data.list;
  assert.equal(orders.find((o) => o.id === req.id).status, "released");
  assert.match(orders.find((o) => o.id === req.id).customerPhone, /\*\*\*\*/);
  assert.equal((await f.api("GET", "/units/" + c)).data.status, "in_stock");
  assert.equal(
    (await f.api("GET", "/customer-requests/" + req.id, undefined, "sales"))
      .data.canStartSale,
    false,
  );

  req = (await order(d)).data;
  const v = (
    await f.api(
      "GET",
      "/sales/lookup?code=" + d + "&customerRequestId=" + req.id,
      undefined,
      "sales",
    )
  ).data;
  const sale = (
    await f.api(
      "POST",
      "/sales-orders",
      {
        requestKey: key(),
        payMethod: "现金",
        paymentConfirmed: true,
        customerRequestId: req.id,
        items: [{ unitId: d, channel: "agent", priceVersion: v.priceVersion }],
      },
      "sales",
    )
  ).data;
  await f.api("POST", "/sales-orders/" + sale.id + "/refund", {
    requestKey: key(),
    kind: "return",
    reason: "七天退货",
    items: [{ itemId: sale.items[0].id }],
  });
  const reversed = (
    await f.api(
      "GET",
      "/admin/agent-earnings?status=reversed",
      undefined,
      "finance",
    )
  ).data.list;
  assert.ok(reversed.some((e) => e.orderId === req.id && e.kind === "earning"));

  const agents = (await f.api("GET", "/admin/agents?status=active")).data.list,
    me = agents.find((x) => x.id === f.users.customer);
  assert.equal(
    (
      await f.api("PATCH", "/admin/agents/" + me.id, {
        status: "disabled",
        reason: "违规",
        version: me.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api(
        "GET",
        "/shop/shares/" + share.shareId,
        undefined,
        "customer:c",
      )
    ).status,
    410,
  );
  assert.equal((await agent("GET", "/agent/overview")).status, 403);
});
