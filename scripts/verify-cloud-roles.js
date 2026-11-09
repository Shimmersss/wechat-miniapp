#!/usr/bin/env node
/** 隔离 OPENID + 真实PG/Storage的完整角色业务回归；不是平台身份或短信验收的替代品。 */
const fs = require("node:fs"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { pg, source, save, privateJSON } = require("./lib/cloud-verification");
const { raw, call } = source(),
  key = () => crypto.randomUUID(),
  phone = () => "199" + String(crypto.randomInt(1e8)).padStart(8, "0");
const roles = [
  "boss",
  "manager",
  "purchaser",
  "warehouse",
  "sales",
  "engineer",
  "finance",
  "customer",
  "peer",
  "agent",
];
const people = Object.fromEntries(
  roles.map((role) => [
    role,
    {
      id: key(),
      sid: key(),
      openid: "roles-regression-" + key(),
      token: crypto.randomBytes(32).toString("hex"),
      role,
    },
  ]),
);
const checks = [],
  result = { checks },
  check = (s) => {
    checks.push(s);
    console.log("PASS", s);
  };
const actor = (
  role,
  name,
  p,
  method = "GET",
  data = {},
  expected = 0,
  headers = {},
) => call(people[role], name, p, method, data, expected, headers);
const imei = () => {
  let s = "35" + String(crypto.randomInt(1e12)).padStart(12, "0"),
    n = 0;
  for (let i = 0; i < 14; i++) {
    const d = +s[i] * (i % 2 ? 2 : 1);
    n += Math.floor(d / 10) + (d % 10);
  }
  return s + ((10 - (n % 10)) % 10);
};
async function upload(scope) {
  const bytes = fs.readFileSync("miniprogram/assets/brands/apple.png");
  const intent = await actor("boss", "files", "/files/upload-intent", "POST", {
    requestKey: key(),
    scope,
    size: bytes.length,
  });
  const r = await fetch(intent.uploadUrl, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.ok(r.ok);
  let file;
  for (let i = 0; i < 10; i++) {
    file = await actor(
      "boss",
      "files",
      "/files/" + intent.uploadId + "/complete",
      "POST",
    );
    if (file.fileId) return file;
  }
  throw Error("小图上传核验未完成");
}
(async () => {
  await pg(
    "users",
    "POST",
    roles.map((r) => ({
      id: people[r].id,
      openid: people[r].openid,
      nickname: "角色回归隔离-" + r,
      role: r === "peer" ? "peer" : "customer",
    })),
  );
  await pg(
    "staff",
    "POST",
    roles
      .filter((r) => !["customer", "peer", "agent"].includes(r))
      .map((r) => ({
        id: people[r].sid,
        user_id: people[r].id,
        phone: phone(),
        name: "角色回归隔离-" + r,
        role_key: r,
      })),
  );
  await pg(
    "sessions",
    "POST",
    roles.map((r) => ({
      token_hash: crypto
        .createHash("sha256")
        .update(people[r].token)
        .digest("hex"),
      user_id: people[r].id,
      assurance: ["customer", "peer", "agent"].includes(r) ? "wechat" : "staff",
      expires_at: new Date(Date.now() + 7200000).toISOString(),
    })),
  );
  const modelId = privateJSON("reports-fixture").modelId,
    form = await actor("boss", "staff-stock", "/models/" + modelId + "/form");
  const [inside, outside] = await Promise.all([
    upload("internal"),
    upload("public"),
  ]);
  const attrs = Object.fromEntries(
    form.fields
      .filter((f) => f.required || f.default !== undefined)
      .map((f) => [
        f.key,
        f.type === "image"
          ? [
              {
                fileId: f.visibility.includes("internal")
                  ? inside.fileId
                  : outside.fileId,
              },
            ]
          : f.default !== undefined
            ? f.default
            : f.type === "select"
              ? f.options[0]
              : f.type === "number"
                ? 90
                : f.type === "boolean"
                  ? true
                  : "验证",
      ]),
  );
  const make = () =>
    actor("boss", "staff-stock", "/inbound/units", "POST", {
      modelId,
      templateVersion: form.version,
      inspectionConfirmed: true,
      attributes: attrs,
      imei1: imei(),
      cost: 1000,
      retail: 1500,
      wholesale: 1400,
      agentBase: 1300,
      flags: { showInShop: true, sharePeer: true, shareAgent: true },
    });
  const unit = await make(),
    browse = await make();
  save("role-fixture", {
    people,
    unitId: browse.id,
    saleUnitId: unit.id,
    modelId,
    insideFileId: inside.fileId,
  });
  for (const role of roles.filter((r) => r !== "agent")) {
    const me = await actor(role, "auth", "/auth/me");
    const granted = me.permissions.includes("inventory:view");
    const inv = await actor(
      role,
      "staff-stock",
      "/units/" + browse.id,
      "GET",
      {},
      granted ? 0 : 403,
    );
    if (granted) {
      assert.equal(inv.cost !== undefined, me.visibleFields.includes("cost"));
      assert.equal(
        inv.imei1 !== undefined,
        me.visibleFields.includes("fullImei"),
      );
    }
    const pub = await actor(role, "shop", "/shop/units/" + browse.id);
    assert.equal(pub.price, role === "peer" ? 1400 : 1500);
    for (const f of [
      "cost",
      "supplier",
      "imei1",
      "imei2",
      "internalNote",
      "agentBase",
    ])
      assert.equal(pub[f], undefined);
  }
  check(
    "老板/经理/采购/库管/销售/工程师/财务及顾客同行：真实库存权限、成本/完整串码裁剪、公开页零泄露与同行价",
  );
  for (const role of ["customer", "peer", "sales", "warehouse", "engineer"]) {
    await actor(role, "staff-admin", "/staff", "GET", {}, 403);
    await actor(role, "staff-reports", "/audit-logs", "GET", {}, 403);
  }
  const catalog = await actor("customer", "shop", "/shop/categories");
  assert.ok(
    catalog.some((c) =>
      c.brands.some((b) =>
        b.series.some((s) => s.models.some((m) => m.id === modelId)),
      ),
    ),
  );
  const consult = await actor(
    "customer",
    "customer",
    "/shop/consults",
    "POST",
    {
      requestKey: key(),
      unitId: browse.id,
      phone: phone(),
      name: "回归顾客",
      content: "角色流程咨询",
    },
  );
  await actor(
    "peer",
    "customer",
    "/shop/requests/" + consult.id,
    "GET",
    {},
    404,
  );
  const followed = await actor(
    "boss",
    "customer",
    "/customer-requests/" + consult.id,
  );
  await actor(
    "boss",
    "customer",
    "/customer-requests/" + consult.id + "/status",
    "PATCH",
    {
      requestKey: key(),
      version: followed.version,
      status: "contacted",
      reason: "角色回归内部跟进",
    },
  );
  const customerDetail = await actor(
    "customer",
    "customer",
    "/shop/requests/" + consult.id,
  );
  assert.ok(!JSON.stringify(customerDetail).includes("角色回归内部跟进"));
  const options = await actor("customer", "customer", "/shop/contact-options");
  const appointment = await actor(
    "customer",
    "customer",
    "/shop/appointments",
    "POST",
    {
      requestKey: key(),
      unitId: browse.id,
      phone: phone(),
      name: "回归预约",
      date: options.minDate,
      timeSlot: options.timeSlots[0],
    },
  );
  await actor(
    "customer",
    "customer",
    "/shop/requests/" + appointment.id + "/cancel",
    "PATCH",
    { requestKey: key(), version: appointment.version, reason: "本人取消预约" },
  );
  check(
    "顾客目录/详情→咨询→老板跟进但内部原因不外泄→预约→本人取消；同行不能读他人意向",
  );
  const peerShare = await actor("peer", "agent", "/share/links", "POST", {
    unitId: browse.id,
    channel: "peer",
  });
  assert.equal(
    (await actor("peer", "agent", "/shop/shares/" + peerShare.shareId)).units[0]
      .price,
    1400,
  );
  await actor(
    "customer",
    "agent",
    "/shop/shares/" + peerShare.shareId,
    "GET",
    {},
    403,
  );
  await pg("users?id=eq." + people.peer.id, "PATCH", { status: "disabled" });
  await actor(
    "customer",
    "agent",
    "/shop/shares/" + peerShare.shareId,
    "GET",
    {},
    410,
  );
  await pg("users?id=eq." + people.peer.id, "PATCH", { status: "active" });
  check("同行分享需授权，普通顾客拒绝，分享人停用后旧链接立即失效");
  await actor("agent", "agent", "/agent/applications", "POST", {
    name: "隔离回归代理",
    phone: phone(),
    region: "测试地区",
    agreed: true,
  });
  const application = (
    await actor("boss", "agent", "/admin/agent-applications")
  ).list.find((a) => a.id === people.agent.id);
  assert.ok(application);
  await actor(
    "boss",
    "agent",
    "/admin/agent-applications/" + people.agent.id + "/review",
    "POST",
    {
      approve: true,
      markupMax: 100,
      remark: "角色回归审批",
      version: application.version,
    },
  );
  await actor(
    "agent",
    "agent",
    "/agent/units/" + unit.id + "/markup",
    "PUT",
    { markup: 101 },
    400,
  );
  const marked = await actor(
    "agent",
    "agent",
    "/agent/units/" + unit.id + "/markup",
    "PUT",
    { markup: 80 },
  );
  assert.equal(marked.sharePrice, 1380);
  const link = await actor("agent", "agent", "/share/links", "POST", {
    unitId: unit.id,
    channel: "agent",
  });
  await actor("agent", "staff-admin", "/staff", "GET", {}, 403);
  const shown = (
    await actor("customer", "agent", "/shop/shares/" + link.shareId)
  ).units[0];
  assert.equal(shown.price, 1380);
  assert.equal(shown.agentBase, undefined);
  const order = await actor(
    "customer",
    "customer",
    "/shop/orders",
    "POST",
    { requestKey: key(), unitId: unit.id, name: "回归买家", phone: phone() },
    0,
    { "X-Channel": link.shareId },
  );
  const looked = await actor("sales", "staff-sales", "/sales/lookup", "GET", {
    code: unit.id,
    customerRequestId: order.id,
  });
  const saleBody = {
    requestKey: key(),
    customerRequestId: order.id,
    items: [
      { unitId: unit.id, channel: "agent", priceVersion: looked.priceVersion },
    ],
    paymentConfirmed: true,
    payMethod: "现金",
  };
  const sale = await actor(
    "sales",
    "staff-sales",
    "/sales-orders",
    "POST",
    saleBody,
  );
  assert.equal(sale.amount, 1380);
  const detail = await actor("boss", "staff-sales", "/sales-orders/" + sale.id);
  const salesDetail = await actor(
    "sales",
    "staff-sales",
    "/sales-orders/" + sale.id,
  );
  assert.equal(salesDetail.agentSources[0].markup, undefined);
  const earned = await actor("agent", "agent", "/agent/commissions");
  assert.equal(earned.summary.pendingAmount, 80);
  assert.ok(
    (await actor("agent", "agent", "/agent/orders")).list.every(
      (o) => !o.phone || o.phone.includes("*"),
    ),
  );
  const money = earned.list.find((e) => e.amount === 80);
  await actor("boss", "agent", "/admin/agent-earnings/settle", "POST", {
    ids: [money.id],
    reason: "回归确认线下已转账",
  });
  await actor(
    "boss",
    "staff-sales",
    "/sales-orders/" + sale.id + "/refund",
    "POST",
    {
      requestKey: key(),
      kind: "return",
      reason: "角色回归实际退货冲回",
      items: [{ itemId: detail.items[0].id }],
    },
  );
  const reversed = await actor("agent", "agent", "/agent/commissions");
  assert.equal(reversed.summary.pendingAmount, -80);
  assert.equal(reversed.summary.settledAmount, 80);
  assert.equal(
    (await actor("boss", "staff-stock", "/units/" + unit.id)).status,
    "recheck",
  );
  check(
    "代理申请/老板审批→限额加价/分享→顾客下单→销售按快照收银→收益/转账→老板退款冲回；销售不见加价，代理顾客信息脱敏",
  );
  const blob = await actor("boss", "files", "/files/" + inside.fileId);
  assert.ok((await fetch(blob.url)).ok);
  await actor("customer", "files", "/files/" + inside.fileId, "GET", {}, 403);
  await actor("sales", "auth", "/auth/logout", "POST");
  await actor("sales", "staff-stock", "/units/" + browse.id, "GET", {}, 401);
  const boss = await actor("boss", "auth", "/auth/me");
  const salesRow = (
    await actor("boss", "staff-admin", "/staff", "GET", {
      keyword: "角色回归隔离-sales",
    })
  ).list.find((s) => s.id === people.sales.sid);
  assert.ok(salesRow);
  await actor("boss", "staff-admin", "/staff/" + people.sales.sid, "PATCH", {
    status: "disabled",
    version: salesRow.version,
    reason: "角色回归停用员工",
  });
  // 新建一个旧令牌会话，确认禁用身份也不能仅靠有会话拿员工权限。
  await pg("sessions", "POST", {
    token_hash: crypto
      .createHash("sha256")
      .update(people.sales.token)
      .digest("hex"),
    user_id: people.sales.id,
    assurance: "staff",
    expires_at: new Date(Date.now() + 7200000).toISOString(),
  });
  await actor("sales", "staff-stock", "/units/" + browse.id, "GET", {}, 403);
  await actor("sales", "files", "/files/" + inside.fileId, "GET", {}, 403);
  check(
    "内部凭证真实签名下载与顾客拒绝；登出旧令牌401，停用身份即使重放会话也不能获得员工/凭证权限",
  );
  Object.assign(result, {
    passed: true,
    roles,
    unitId: browse.id,
    saleUnitId: unit.id,
    modelId,
    consultId: consult.id,
    appointmentId: appointment.id,
    saleId: sale.id,
    shareId: link.shareId,
    people,
    insideFileId: inside.fileId,
  });
  save("role-fixture", result);
  save("role-results", {
    passed: true,
    roles,
    checks,
    boundaries: [
      "仅在函数源码运行器注入隔离平台OPENID，实际PG/会话/权限/事务/Storage均真实；真实SDK页面回归另记。",
      "签发出的内部链接仍可在300秒内有效；登出/停用立即禁止新授权，不宣称已签发链接即时失效。",
    ],
  });
  console.log(JSON.stringify({ passed: true, roles, checks }));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
