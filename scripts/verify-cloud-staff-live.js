#!/usr/bin/env node
/** 已部署员工与角色维护 + 真实微信SDK验收。使用忽略目录中的隔离夹具；临时切换测试员工，finally恢复原角色/状态及顾客会话。 */
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
  const file = path.join(root, local + "/staff-eval-args.json");
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
    name: i.name || "staff-admin",
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

const finishing = process.argv.includes("--finish");
const results = finishing
  ? JSON.parse(fs.readFileSync(local + "/staff-live-results.json"))
  : { checks: [], timings: [], pages: [] };
const staff = control("queryPgDatabase", {
  action: "sql",
  sql: `SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`,
}).data.rows[0];
assert.ok(staff);
assert.match(staff.id, /^[0-9a-f-]{36}$/);
assert.match(staff.role_key, /^[a-z_]+$/);
fs.writeFileSync(
  local + "/staff-live-original-staff.json",
  JSON.stringify(staff),
  { mode: 0o600 },
);
const setRole = (role, status = "active") =>
  control("managePgDatabase", {
    action: "execute",
    confirm: true,
    sql: `UPDATE staff SET role_key='${role}',status='${status}' WHERE id='${staff.id}'`,
  });
const raw = (path, method = "GET", data = {}, name) =>
  evaluate(request.toString(), [{ path, method, data, name }]);
function denied(path, method, data, code) {
  assert.equal(raw(path, method, data).code, code);
}
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
      "function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,loading:p.data.loading,rows:p.data.list?.length,roles:p.data.roles?.length,canEdit:p.data.canEdit,isBoss:p.data.isBoss,activeEditable:p.data.activeEditable};}",
    );
    if (p.loading === false) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(p.error, "");
  assert.ok(p.rows > 0 || p.roles === 7);
  results.pages.push(p);
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
    if (!finishing) {
      for (let i = 0; i < 3; i++) {
        const r = call("/staff", "GET", { pageSize: 5 });
        assert.ok(r.data.total > 0);
        results.timings.push({ e2eMs: r.e2eMs, ...r.timing });
      }
      const roles = call("/roles").data;
      assert.equal(roles.canEdit, true);
      assert.equal(roles.list.length, 7);
      const phone = "199" + String(crypto.randomInt(1e8)).padStart(8, "0");
      let target = call("/staff", "POST", {
        name: "微信员工验收_" + crypto.randomUUID().slice(0, 8),
        phone,
        roleKey: "sales",
        reason: "真实微信员工管理验收",
      }).data;
      assert.equal(target.wechatBound, false);
      assert.equal(target.user_id, undefined);
      assert.equal(call("/staff", "GET", { keyword: phone }).data.total, 1);
      results.checks.push(
        "真实微信 SDK 已部署名单/角色读取、新增未绑定员工、过滤与白名单字段",
      );
      const edits = evaluate(
        async function (i) {
          return Promise.all(
            ["甲", "乙"].map(
              async (suffix) =>
                (
                  await wx.cloud.callFunction({
                    name: "staff-admin",
                    data: {
                      path: "/staff/" + i.id,
                      method: "PATCH",
                      data: {
                        name: "微信并发" + suffix,
                        reason: "真实微信员工并发验收",
                        version: i.version,
                      },
                      headers: {
                        Authorization:
                          "Bearer " + wx.getStorageSync("xm_token"),
                      },
                    },
                  })
                ).result,
            ),
          );
        }.toString(),
        [target],
      );
      assert.deepEqual(
        edits.map((x) => x.code).sort((a, b) => a - b),
        [0, 409],
      );
      target = edits.find((x) => x.code === 0).data;
      target = call("/staff/" + target.id, "PATCH", {
        status: "disabled",
        version: target.version,
        reason: "微信停用未绑定隔离员工",
      }).data;
      assert.equal(target.status, "disabled");
      target = call("/staff/" + target.id, "PATCH", {
        status: "active",
        version: target.version,
        reason: "微信恢复隔离员工",
      }).data;
      assert.equal(target.status, "active");
      denied(
        "/staff/" + target.id + "/unbind",
        "POST",
        { version: target.version, reason: "未绑定拒绝" },
        409,
      );
      results.targetId = target.id;
      results.checks.push(
        "真实微信同版本并发修改 [0,409]、停用/恢复与未绑定解绑冲突",
      );
      const me = call("/staff", "GET", { keyword: login.phone }).data.list.find(
        (x) => x.isSelf,
      );
      assert.ok(me);
      denied(
        "/staff/" + me.id,
        "PATCH",
        { status: "disabled", version: me.version, reason: "自停用拒绝" },
        400,
      );
      denied(
        "/staff/" + me.id + "/unbind",
        "POST",
        { version: me.version, reason: "自解绑拒绝" },
        400,
      );
      const role = roles.list.find((x) => x.key === "warehouse");
      const saved = call("/roles/warehouse", "PUT", {
        permissions: role.permissions,
        visibleFields: role.visibleFields,
        version: role.version,
        reason: "微信角色同授权配置保存验收",
      }).data;
      assert.equal(saved.version, role.version + 1);
      assert.deepEqual(
        saved.permissions,
        [...new Set(role.permissions)].sort(),
      );
      denied(
        "/roles/boss",
        "PUT",
        {
          permissions: [],
          visibleFields: [],
          version: 1,
          reason: "老板固定拒绝",
        },
        400,
      );
      results.checks.push(
        "真实微信禁止自停用/自解绑；角色原因保存及版本增加、老板固定；授权内容保持一致",
      );
      await page("/packages/staff/staff/index");
      await page("/packages/staff/staff/roles");
    }
    setRole("manager");
    assert.equal(call("/roles").data.canEdit, false);
    const saved = call("/roles").data.list.find((x) => x.key === "warehouse");
    const protectedBoss = call("/staff", "GET", {
      roleKey: "boss",
      pageSize: 1,
    }).data.list[0];
    assert.ok(protectedBoss && !protectedBoss.isSelf);
    denied(
      "/roles/warehouse",
      "PUT",
      {
        permissions: saved.permissions,
        visibleFields: saved.visibleFields,
        version: saved.version,
        reason: "经理越权拒绝",
      },
      403,
    );
    denied(
      "/staff/" + protectedBoss.id,
      "PATCH",
      {
        name: "越权",
        version: protectedBoss.version,
        reason: "经理修改老板拒绝",
      },
      403,
    );
    setRole("sales");
    denied("/staff", "GET", {}, 403);
    denied("/roles", "GET", {}, 403);
    results.checks.push(
      "同令牌经理立即只读角色、禁止改老板；销售拒绝员工与角色维护",
    );
    results.passed = true;
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
      local + "/staff-live-results.json",
      JSON.stringify(results, null, 2),
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
