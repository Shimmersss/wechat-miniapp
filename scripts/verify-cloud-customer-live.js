#!/usr/bin/env node
/** 已部署顾客意向与访问 + 真实微信SDK验收。使用忽略目录中的隔离夹具；临时切换测试员工，finally恢复原角色/状态及顾客会话。 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
process.chdir(root);
const local = ".local/cloudbase",
  login = JSON.parse(fs.readFileSync(local + "/live-login-args.json"))[0];
assert.match(login.phone, /^\d{11}$/);
function control(tool, args) {
  const listing = execFileSync("tcb", ["env", "list", "--json"], {
      encoding: "utf8",
    }),
    envId = JSON.parse(listing.slice(listing.indexOf("{"))).data[0].EnvId;
  const raw = execFileSync(
    "npx",
    [
      "-y",
      "mcporter",
      "call",
      "--stdio",
      "npx -y @cloudbase/cloudbase-mcp@latest",
      tool,
      "--args",
      JSON.stringify({ ...args, envId }),
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 4e6 },
  );
  const r = JSON.parse(raw.slice(raw.indexOf("{")));
  if (!r.success) throw Error(r.message);
  return r;
}
function evaluate(fn, args = []) {
  const file = path.join(root, local + "/customer-eval-args.json");
  fs.writeFileSync(file, JSON.stringify(args), { mode: 0o600 });
  const raw = execFileSync(
    "wechatide",
    [
      "-c",
      "Codex",
      "automation_evaluate",
      "--project",
      root,
      "--fn-source",
      fn,
      "--args-file",
      file,
    ],
    { encoding: "utf8", maxBuffer: 2e6 },
  );
  const r = JSON.parse(raw.slice(raw.indexOf("{")));
  assert.equal(r.ok, true);
  assert.equal(r.result.success, true);
  return r.result.result.result;
}
const request = async function (i) {
  const start = Date.now();
  const r = await wx.cloud.callFunction({
    name: i.name || "customer",
    data: {
      path: i.path,
      method: i.method || "GET",
      data: i.data || {},
      headers: {
        Authorization: "Bearer " + wx.getStorageSync("xm_token"),
        ...(i.shareId !== undefined ? { "X-Channel": i.shareId } : {}),
      },
    },
  });
  return { ...r.result, e2eMs: Date.now() - start };
};
function call(path, method = "GET", data = {}, name, shareId) {
  const r = evaluate(request.toString(), [
    { path, method, data, name, shareId },
  ]);
  assert.equal(r.code, 0, r.message);
  return r;
}
const results = { checks: [], timings: [], pages: [] },
  fixture = JSON.parse(fs.readFileSync(local + "/customer-fixture.json"));
const staff = control("queryPgDatabase", {
  action: "sql",
  sql: `SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`,
}).data.rows[0];
assert.ok(staff);
assert.match(staff.id, /^[0-9a-f-]{36}$/);
assert.match(staff.role_key, /^[a-z_]+$/);
fs.writeFileSync(
  local + "/customer-live-original-staff.json",
  JSON.stringify(staff),
  { mode: 0o600 },
);
const setRole = (role, status = "active") =>
  control("managePgDatabase", {
    action: "execute",
    confirm: true,
    sql: `UPDATE staff SET role_key='${role}',status='${status}' WHERE id='${staff.id}'`,
  });
const customerLogin = () =>
  evaluate(
    async function () {
      const r = (
        await wx.cloud.callFunction({
          name: "auth",
          data: { path: "/auth/wx-login", method: "POST", data: {} },
        })
      ).result;
      if (r.code === 0) {
        wx.setStorageSync("xm_token", r.data.token);
        wx.setStorageSync("xm_user", r.data.user);
        getApp().globalData.user = r.data.user;
      }
      return { code: r.code, role: r.data?.user?.role };
    }.toString(),
  );
async function page(url, kind, status) {
  execFileSync(
    "wechatide",
    [
      "-c",
      "Codex",
      "automation_navigate",
      "--project",
      root,
      "--action",
      "navigateTo",
      "--url",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let p;
  for (let i = 0; i < 12; i++) {
    p = evaluate(
      "function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,loading:p.data.loading,kind:p.data.detail?.kind,status:p.data.detail?.status,rows:p.data.list?.length};}",
    );
    if (p.loading === false && (p.status || p.rows !== undefined)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(p.error, "");
  if (kind) assert.equal(p.kind, kind);
  if (status) assert.equal(p.status, status);
  results.pages.push(p);
}
(async () => {
  try {
    assert.equal(customerLogin().code, 0);
    for (let i = 0; i < 3; i++) {
      const r = call("/shop/contact-options");
      results.timings.push({
        endpoint: "/shop/contact-options",
        e2eMs: r.e2eMs,
        ...r.timing,
      });
    }
    const options = call("/shop/contact-options").data,
      share = call(
        "/share/links",
        "POST",
        { unitId: fixture.nativeUnitId, channel: "customer" },
        "agent",
      ).data,
      body = {
        requestKey: "wechat-consult-" + crypto.randomUUID(),
        unitId: fixture.nativeUnitId,
        name: "微信意向验证",
        phone: "199" + String(Date.now()).slice(-8),
        content: "真实微信咨询电池情况",
      };
    const submitted = evaluate(
      async function (i) {
        return Promise.all(
          [1, 2].map(async () => {
            const r = await wx.cloud.callFunction({
              name: "customer",
              data: {
                path: "/shop/consults",
                method: "POST",
                data: i.body,
                headers: {
                  Authorization: "Bearer " + wx.getStorageSync("xm_token"),
                  "X-Channel": i.shareId,
                },
              },
            });
            return r.result;
          }),
        );
      }.toString(),
      [{ body, shareId: share.shareId }],
    );
    assert.ok(
      submitted.every((x) => x.code === 0),
      submitted.map((x) => x.message).join(","),
    );
    const c = submitted[0].data;
    assert.equal(c.id, submitted[1].data.id);
    assert.equal(c.source, "customer");
    assert.equal(c.unit.cost, undefined);
    assert.equal(c.unit.imei1, undefined);
    results.checks.push(
      "真实微信顾客咨询同标识并发幂等、来源快照与公开字段裁剪",
    );
    const ap = call(
      "/shop/appointments",
      "POST",
      {
        ...body,
        requestKey: crypto.randomUUID(),
        date: options.minDate,
        timeSlot: options.timeSlots[0],
      },
      undefined,
      "",
    ).data;
    assert.equal(ap.status, "new");
    assert.equal(ap.date, options.minDate);
    assert.ok(call("/shop/requests").data.list.some((x) => x.id === ap.id));
    await page(
      "/packages/shop/requests/detail?id=" + ap.id,
      "appointment",
      "new",
    );
    results.checks.push("真实微信预约落库、本人列表及预约详情页加载");
    const visitor = "wechat_visitor_" + crypto.randomUUID(),
      events = [
        {
          eventId: "wechat_event_" + crypto.randomUUID(),
          type: "pv",
          route: "packages/shop/product/index",
          unitId: fixture.nativeUnitId,
        },
        {
          eventId: "wechat_event_" + crypto.randomUUID(),
          type: "pv",
          route: "packages/staff/consults/index",
        },
        {
          eventId: "wechat_event_" + crypto.randomUUID(),
          type: "event",
          name: "consult_click",
        },
      ];
    const visit = call(
      "/visits/batch",
      "POST",
      { visitorId: visitor, events },
      undefined,
      share.shareId,
    ).data;
    assert.equal(visit.accepted, 2);
    assert.equal(visit.ignored, 1);
    assert.equal(
      call(
        "/visits/batch",
        "POST",
        { visitorId: visitor, events },
        undefined,
        share.shareId,
      ).data.accepted,
      0,
    );
    results.checks.push("已部署访问上报真实接收、重试去重与员工路径忽略");
    setRole("boss");
    const session = evaluate(
      async function (i) {
        const call = async (path, data) =>
          (
            await wx.cloud.callFunction({
              name: "auth",
              data: { path, method: "POST", data },
            })
          ).result;
        await call("/auth/sms-code", { phone: i.phone });
        const r = await call("/auth/staff-login", {
          account: i.phone,
          smsCode: i.code,
        });
        if (r.code === 0) {
          wx.setStorageSync("xm_token", r.data.token);
          wx.setStorageSync("xm_user", r.data.user);
          getApp().globalData.user = r.data.user;
        }
        return { code: r.code, role: r.data?.user?.role };
      }.toString(),
      [login],
    );
    assert.equal(session.code, 0);
    assert.equal(session.role, "boss");
    const change = {
      version: 1,
      status: "contacted",
      reason: "微信内部跟进备注",
    };
    const race = evaluate(
      async function (i) {
        return Promise.all(
          [1, 2].map(async () => {
            return (
              await wx.cloud.callFunction({
                name: "customer",
                data: {
                  path: "/customer-requests/" + i.id + "/status",
                  method: "PATCH",
                  data: {
                    ...i.body,
                    requestKey:
                      "wechat_status_" + Date.now() + "_" + Math.random(),
                  },
                  headers: {
                    Authorization: "Bearer " + wx.getStorageSync("xm_token"),
                  },
                },
              })
            ).result;
          }),
        );
      }.toString(),
      [{ id: c.id, body: change }],
    );
    assert.deepEqual(race.map((x) => x.code).sort(), [0, 409]);
    assert.equal(
      call("/customer-requests/" + c.id).data.timeline.at(-1).note,
      change.reason,
    );
    assert.ok(
      !JSON.stringify(call("/shop/requests/" + c.id).data).includes(
        change.reason,
      ),
    );
    results.checks.push(
      "真实微信门店同版本并发跟进只有一次成功，内部备注不返回顾客视图",
    );
    call("/customer-requests/" + ap.id + "/status", "PATCH", {
      requestKey: crypto.randomUUID(),
      version: 1,
      status: "confirmed",
      reason: "电话核实到店预约",
    });
    call("/customer-requests/" + ap.id + "/status", "PATCH", {
      requestKey: crypto.randomUUID(),
      version: 2,
      status: "completed",
      reason: "实际完成到店接待",
    });
    assert.equal(call("/customer-requests/" + ap.id).data.status, "completed");
    const saleBody = {
      requestKey: crypto.randomUUID(),
      customerRequestId: c.id,
      items: [{ unitId: fixture.nativeUnitId, priceVersion: 1 }],
      paymentConfirmed: true,
      payMethod: "现金",
    };
    const quote = call("/sales/quote", "POST", saleBody, "staff-sales").data;
    assert.equal(quote.total, 1500);
    const sale = call("/sales-orders", "POST", saleBody, "staff-sales").data;
    assert.equal(sale.customerRequestId, c.id);
    assert.equal(sale.amount, 1500);
    assert.equal(call("/customer-requests/" + c.id).data.status, "closed");
    results.checks.push(
      "真实微信预约确认/完成、普通咨询收银成交与归因原子落库",
    );
    await page(
      "/packages/staff/consults/detail?id=" + c.id,
      "consult",
      "closed",
    );
    setRole("warehouse");
    assert.equal(
      evaluate(request.toString(), [{ path: "/customer-requests/" + c.id }])
        .code,
      403,
    );
    setRole("boss", "disabled");
    assert.equal(
      evaluate(request.toString(), [{ path: "/customer-requests/" + c.id }])
        .code,
      403,
    );
    results.checks.push("员工意向详情页真实加载，缺权限和停用员工拒绝读取");
    assert.equal(customerLogin().code, 0);
    await page(
      "/packages/shop/requests/detail?id=" + c.id,
      "consult",
      "closed",
    );
    await page("/packages/shop/requests/index");
    results.checks.push("顾客咨询详情/我的预约列表实际加载，无页面业务错误");
    results.consultId = c.id;
    results.appointmentId = ap.id;
    results.saleId = sale.id;
  } finally {
    setRole(staff.role_key, staff.status);
    results.restoredRole = staff.role_key;
    const restored = customerLogin();
    assert.equal(restored.code, 0);
    results.restoredSessionRole = restored.role;
    execFileSync(
      "wechatide",
      [
        "-c",
        "Codex",
        "automation_navigate",
        "--project",
        root,
        "--action",
        "switchTab",
        "--url",
        "/pages/shop/index",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    fs.writeFileSync(
      local + "/customer-live-results.json",
      JSON.stringify(results, null, 2),
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.checks,
      timings: results.timings,
      pages: results.pages,
      restoredRole: results.restoredRole,
      restoredSessionRole: results.restoredSessionRole,
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
