#!/usr/bin/env node
/** 已部署统计导出与审计 + 真实微信SDK验收。使用忽略目录中的隔离夹具；临时切换测试员工，finally恢复原角色/状态及顾客会话。 */
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
  const file = path.join(root, local + "/reports-eval-args.json");
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
    name: i.name || "staff-reports",
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
  fixture = JSON.parse(fs.readFileSync(local + "/reports-fixture.json"));
const staff = control("queryPgDatabase", {
  action: "sql",
  sql: `SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`,
}).data.rows[0];
assert.ok(staff);
assert.match(staff.id, /^[0-9a-f-]{36}$/);
assert.match(staff.role_key, /^[a-z_]+$/);
fs.writeFileSync(
  local + "/reports-live-original-staff.json",
  JSON.stringify(staff),
  { mode: 0o600 },
);
const setRole = (role, status = "active") =>
  control("managePgDatabase", {
    action: "execute",
    confirm: true,
    sql: `UPDATE staff SET role_key='${role}',status='${status}' WHERE id='${staff.id}'`,
  });
async function page(url) {
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
  for (let i = 0; i < 15; i++) {
    p = evaluate(
      "function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,loading:p.data.loading,overview:!!p.data.overview,visits:!!p.data.visits,rows:p.data.list?.length,ageing:p.data.ageing?.length};}",
    );
    if (p.loading === false) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(p.error, "");
  results.pages.push(p);
}
function download(report, variant) {
  return evaluate(
    async function (i) {
      const fs = wx.getFileSystemManager(),
        dir = wx.env.USER_DATA_PATH + "/reports";
      await new Promise((resolve, reject) =>
        fs.access({
          path: dir,
          success: resolve,
          fail: () =>
            fs.mkdir({
              dirPath: dir,
              recursive: true,
              success: resolve,
              fail: reject,
            }),
        }),
      );
      const filePath = dir + "/" + i.report.id + "_" + i.variant + ".csv";
      const download = await new Promise((resolve, reject) =>
        wx.downloadFile({
          url: i.report.url,
          filePath,
          success: resolve,
          fail: reject,
        }),
      );
      if (download.statusCode !== 200) throw Error("CSV下载失败");
      const bytes = new Uint8Array(fs.readFileSync(filePath)),
        text = fs.readFileSync(filePath, "utf8");
      return {
        bom: bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191,
        bytes: bytes.length,
        hasCost: text.includes("净成本"),
        hasProfit: text.includes("净毛利"),
        hasHeader: text.includes("销售单号"),
        hasFormulaEscape: text.includes("'=SUM(1,2)_"),
      };
    }.toString(),
    [{ report, variant }],
  );
}
(async () => {
  try {
    setRole("boss");
    const session = evaluate(
      async function (i) {
        const invoke = async (path, data) =>
          (
            await wx.cloud.callFunction({
              name: "auth",
              data: { path, method: "POST", data },
            })
          ).result;
        await invoke("/auth/sms-code", { phone: i.phone });
        const r = await invoke("/auth/staff-login", {
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
    for (let i = 0; i < 3; i++) {
      const r = call("/stats/overview", "GET", fixture.period);
      results.timings.push({ e2eMs: r.e2eMs, ...r.timing });
      assert.equal(r.data.amount, 490);
      assert.equal(r.data.profit, 190);
    }
    const trend = call("/stats/trend", "GET", fixture.period).data;
    assert.equal(trend.list.length, 2);
    for (const dimension of ["model", "staff", "store"])
      assert.equal(
        call("/stats/breakdown", "GET", {
          ...fixture.period,
          dimension,
        }).data.list.reduce((n, x) => n + x.amount, 0),
        490,
      );
    assert.ok(call("/stats/visits").data.pv >= 3);
    assert.ok(
      call("/stats/visit-trend", "GET", fixture.period).data.list.every(
        (x) => x.pv === 0,
      ),
    );
    assert.ok(call("/staff/dashboard").data.todos.length > 0);
    assert.equal(call("/stats/agent-earnings").code, 0);
    results.checks.push(
      "已部署统计实际读取收退款净额/毛利、三维拆分、补零趋势、访问、工作台与代理对账",
    );
    const body = {
      ...fixture.period,
      requestKey: "wechat_report_" + crypto.randomUUID(),
      reason: "真实微信经营对账验收",
    };
    const metas = evaluate(
      async function (i) {
        return Promise.all(
          [1, 2].map(
            async () =>
              (
                await wx.cloud.callFunction({
                  name: "staff-reports",
                  data: {
                    path: "/stats/export",
                    method: "POST",
                    data: i,
                    headers: {
                      Authorization: "Bearer " + wx.getStorageSync("xm_token"),
                    },
                  },
                })
              ).result,
          ),
        );
      }.toString(),
      [body],
    );
    assert.ok(
      metas.every((x) => x.code === 0),
      metas.map((x) => x.message).join(","),
    );
    assert.equal(metas[0].data.id, metas[1].data.id);
    const meta = metas[0].data;
    const saved = download(call("/stats/exports/" + meta.id).data, "boss");
    assert.ok(
      saved.bom &&
        saved.hasCost &&
        saved.hasProfit &&
        saved.hasHeader &&
        saved.hasFormulaEscape,
    );
    results.csvBoss = saved;
    results.checks.push(
      "真实微信导出同标识并发幂等，私有CSV实际保存，BOM/中文列名/公式转义正确",
    );
    setRole("manager");
    const cropped = download(call("/stats/exports/" + meta.id).data, "manager");
    assert.ok(cropped.hasHeader && !cropped.hasCost && !cropped.hasProfit);
    assert.ok(cropped.bytes < saved.bytes);
    results.csvManager = cropped;
    const audit = call("/audit-logs", "GET", {
      action: "导出销售退款报表",
      objectId: meta.id,
    }).data;
    assert.equal(audit.total, 1);
    assert.equal(audit.list[0].reason, body.reason);
    assert.equal(audit.list[0].after.costAccess, "无权限查看");
    results.checks.push(
      "真实经理下载重新裁掉成本/毛利，原因审计恰一条并按字段递归脱敏",
    );
    setRole("sales");
    assert.equal(call("/stats/overview").data.profit, undefined);
    assert.equal(call("/staff/dashboard").data.inventory.stockCost, undefined);
    for (const i of [
      { path: "/stats/exports/" + meta.id },
      { path: "/audit-logs" },
      { path: "/stats/agent-earnings" },
    ])
      assert.equal(evaluate(request.toString(), [i]).code, 403);
    setRole("engineer");
    const dashboard = call("/staff/dashboard").data,
      repair = call("/repair-orders/stats", "GET", {}, "staff-repair").data;
    assert.equal(dashboard.repair.created, repair.created);
    assert.equal(dashboard.repair.partsCost, undefined);
    setRole("boss", "disabled");
    assert.equal(
      evaluate(request.toString(), [{ path: "/stats/overview" }]).code,
      403,
    );
    results.checks.push(
      "真实角色与停用即时生效：销售裁剪/禁导出审计对账，工程师维修统计保持本人范围",
    );
    setRole("boss");
    await page("/packages/staff/stats/index");
    assert.equal(results.pages.at(-1).overview, true);
    assert.equal(results.pages.at(-1).visits, true);
    await page("/packages/staff/audit/index");
    results.checks.push("经营统计页面与审计筛选/列表实际加载，无页面业务错误");
    results.reportId = meta.id;
  } finally {
    setRole(staff.role_key, staff.status);
    results.restoredRole = staff.role_key;
    const restored = evaluate(
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
      local + "/reports-live-results.json",
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
      csvBoss: results.csvBoss,
      csvManager: results.csvManager,
      restoredRole: results.restoredRole,
      restoredSessionRole: results.restoredSessionRole,
    }),
  );
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
