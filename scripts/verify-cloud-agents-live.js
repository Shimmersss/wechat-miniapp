#!/usr/bin/env node
/** 已部署代理链路 + 真实微信SDK验收。使用忽略目录中的隔离夹具；临时切换测试员工，finally恢复原角色/状态及顾客会话。 */
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
  const file = path.join(root, local + "/agent-eval-args.json");
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
    name: i.name || "agent",
    data: {
      path: i.path,
      method: i.method || "GET",
      data: i.data || {},
      headers: { Authorization: "Bearer " + wx.getStorageSync("xm_token") },
    },
  });
  return { ...r.result, e2eMs: Date.now() - start };
};
function call(path, method = "GET", data = {}, name) {
  const r = evaluate(request.toString(), [{ path, method, data, name }]);
  assert.equal(r.code, 0, r.message);
  return r;
}
const pageOnly = process.argv.includes("--page");
const results = pageOnly
  ? JSON.parse(fs.readFileSync(local + "/agent-live-results.json"))
  : { checks: [], timings: [] };
const fixture = JSON.parse(fs.readFileSync(local + "/agent-fixture.json"));
const staff = control("queryPgDatabase", {
  action: "sql",
  sql: `SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`,
}).data.rows[0];
assert.ok(staff);
assert.match(staff.id, /^[0-9a-f-]{36}$/);
assert.match(staff.role_key, /^[a-z_]+$/);
fs.writeFileSync(
  local + "/agent-live-original-staff.json",
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
(async () => {
  try {
    let order;
    if (!pageOnly) {
      assert.equal(customerLogin().code, 0);
      for (let i = 0; i < 3; i++) {
        const r = call("/shop/shares/" + fixture.shareId);
        results.timings.push({ e2eMs: r.e2eMs, ...r.timing });
        assert.equal(r.data.price, fixture.expectedSharePrice);
        assert.equal(r.data.units[0].cost, undefined);
      }
      const orderResult = evaluate(
        async function (i) {
          const r = (
            await wx.cloud.callFunction({
              name: "agent",
              data: {
                path: "/shop/orders",
                method: "POST",
                data: i.body,
                headers: {
                  Authorization: "Bearer " + wx.getStorageSync("xm_token"),
                  "X-Channel": i.shareId,
                },
              },
            })
          ).result;
          return r;
        }.toString(),
        [
          {
            shareId: fixture.shareId,
            body: {
              requestKey: "wechat-agent-" + crypto.randomUUID(),
              unitId: fixture.unitId,
              name: "微信代理顾客",
              phone: login.phone,
            },
          },
        ],
      );
      assert.equal(orderResult.code, 0, orderResult.message);
      order = orderResult.data;
      assert.equal(order.agentOrder.status, "locked");
      results.checks.push(
        "真实微信顾客读取代理分享价并下单锁库，公开结果不返回成本",
      );
    }
    setRole("boss");
    const session = evaluate(
      async function (i) {
        const c = async (path, data) =>
          (
            await wx.cloud.callFunction({
              name: "auth",
              data: { path, method: "POST", data },
            })
          ).result;
        await c("/auth/sms-code", { phone: i.phone });
        const s = await c("/auth/staff-login", {
          account: i.phone,
          smsCode: i.code,
        });
        if (s.code === 0) {
          wx.setStorageSync("xm_token", s.data.token);
          wx.setStorageSync("xm_user", s.data.user);
          getApp().globalData.user = s.data.user;
        }
        return { code: s.code, role: s.data?.user?.role };
      }.toString(),
      [login],
    );
    assert.equal(session.code, 0);
    assert.equal(session.role, "boss");
    if (!pageOnly) {
      assert.equal(
        call("/customer-requests/" + order.id).data.agentOrder.status,
        "locked",
      );
      const body = {
        requestKey: crypto.randomUUID(),
        customerRequestId: order.id,
        items: [{ unitId: fixture.unitId, channel: "agent", priceVersion: 1 }],
        paymentConfirmed: true,
        payMethod: "现金",
      };
      assert.equal(
        call("/sales/quote", "POST", body, "staff-sales").data.total,
        fixture.expectedSharePrice,
      );
      const sale = call("/sales-orders", "POST", body, "staff-sales").data;
      const detail = call(
        "/sales-orders/" + sale.id,
        "GET",
        {},
        "staff-sales",
      ).data;
      assert.equal(detail.agentSources[0].markup, fixture.expectedMarkup);
      const earning = call("/admin/agent-earnings", "GET", {
        agentId: fixture.agentId,
      }).data.list.find((x) => x.orderId === order.id);
      assert.ok(earning);
      assert.equal(earning.amount, fixture.expectedMarkup);
      call("/admin/agent-earnings/settle", "POST", {
        ids: [earning.id],
        reason: "真实微信线下转账登记验收",
      });
      results.checks.push(
        "真实微信门店按分享快照成交，收益一次生成并按原因标记转账",
      );
      call(
        "/sales-orders/" + sale.id + "/refund",
        "POST",
        {
          requestKey: crypto.randomUUID(),
          kind: "return",
          reason: "微信已转账收益退货冲回",
          items: [{ itemId: detail.items[0].id }],
        },
        "staff-sales",
      );
      const earnings = call("/admin/agent-earnings", "GET", {
        agentId: fixture.agentId,
      }).data.list;
      assert.ok(
        earnings.some(
          (x) =>
            x.orderId === order.id &&
            x.kind === "reversal" &&
            x.amount === -fixture.expectedMarkup,
        ),
      );
      results.checks.push("真实微信已转账收益退货追加负向冲回");
      results.orderId = order.id;
      results.saleId = sale.id;
    }
    setRole("sales");
    const orders = call("/admin/agent-orders").data;
    assert.ok(
      orders.list.every(
        (x) => x.markup === undefined && x.agentBase === undefined,
      ),
    );
    assert.equal(
      evaluate(request.toString(), [{ path: "/admin/agent-earnings" }]).code,
      403,
    );
    results.checks.push("真实销售身份可读订单但不返回底价与加价，拒绝收益台账");
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
        "/packages/staff/agents/orders?status=",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let page;
    for (let i = 0; i < 10; i++) {
      page = evaluate(
        "function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,loading:p.data.loading,total:p.data.total,rows:p.data.list?.length};}",
      );
      if (page.loading === false) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(page.error, "");
    assert.ok(page.rows > 0);
    results.page = page;
    results.checks.push("代理订单页面真实加载，无页面业务错误");
  } finally {
    setRole(staff.role_key, staff.status);
    results.restoredRole = staff.role_key;
    assert.equal(customerLogin().code, 0);
    results.restoredSessionRole = "customer";
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
      local + "/agent-live-results.json",
      JSON.stringify(results, null, 2),
      { mode: 0o600 },
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.checks,
      timings: results.timings,
      page: results.page,
      restoredRole: results.restoredRole,
      restoredSessionRole: results.restoredSessionRole,
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
