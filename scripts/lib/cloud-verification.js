/** 真实云端验收辅助。凭据只读忽略目录；不会记录手机号、OPENID、令牌或网关标识。 */
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  Module = require("node:module"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../.."),
  local = path.join(root, ".local/cloudbase");
const privateJSON = (n) =>
  JSON.parse(fs.readFileSync(path.join(local, n + ".json")));
const variables = Object.fromEntries(
  fs
    .readFileSync(path.join(local, "functions.env"), "utf8")
    .split("\n")
    .map((s) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(s.trim()))
    .filter(Boolean)
    .map((x) => [x[1], x[2]]),
);
const envId = privateJSON("sms-config-before").envId;
async function pg(resource, method = "GET", body) {
  const r = await fetch(
    `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/${resource}`,
    {
      method,
      headers: {
        Authorization: "Bearer " + variables.CLOUDBASE_API_KEY,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!r.ok) {
    let body;
    try {
      body = await r.json();
    } catch {}
    const e = Error(
      "验收PG请求失败 HTTP " + r.status + " " + (body?.code || ""),
    );
    e.pgCode = body?.code;
    e.httpStatus = r.status;
    fs.writeFileSync(
      path.join(local, "verification-last-pg-error.json"),
      JSON.stringify({ status: r.status, body }),
      { mode: 0o600 },
    );
    throw e;
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const rpc = (name, data) => pg("rpc/" + name, "POST", data);
function evaluate(fn, args = []) {
  const file = path.join(local, "coverage-evaluate-args.json");
  fs.writeFileSync(file, JSON.stringify(args), { mode: 0o600 });
  const text = execFileSync(
    "wechatide",
    [
      "-c",
      "Codex",
      "automation_evaluate",
      "--project",
      root,
      "--fn-source",
      typeof fn === "function" ? fn.toString() : fn,
      "--args-file",
      file,
    ],
    { encoding: "utf8", maxBuffer: 5e6, stdio: ["ignore", "pipe", "pipe"] },
  );
  const r = JSON.parse(text.slice(text.indexOf("{")));
  assert.equal(r.ok, true);
  assert.equal(r.result.success, true);
  return r.result.result.result;
}
const native = (name, p, method = "GET", data = {}, headers = {}) =>
  evaluate(
    async function (i) {
      return (
        await wx.cloud.callFunction({
          name: i.name,
          data: {
            path: i.path,
            method: i.method,
            data: i.data,
            headers: {
              Authorization: "Bearer " + wx.getStorageSync("xm_token"),
              ...i.headers,
            },
          },
        })
      ).result;
    },
    [{ name, path: p, method, data, headers }],
  );
function navigate(url, action = "navigateTo") {
  execFileSync(
    "wechatide",
    [
      "-c",
      "Codex",
      "automation_navigate",
      "--project",
      root,
      "--action",
      action,
      "--url",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}
const save = (name, data) =>
  fs.writeFileSync(
    path.join(local, name + ".json"),
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
async function guest() {
  const result = evaluate(async function () {
    const auth = async (path) =>
      (
        await wx.cloud.callFunction({
          name: "auth",
          data: {
            path,
            method: "POST",
            data: {},
            headers: {
              Authorization: "Bearer " + wx.getStorageSync("xm_token"),
            },
          },
        })
      ).result;
    await auth("/auth/logout");
    const r = await auth("/auth/wx-login");
    if (r.code === 0) {
      wx.setStorageSync("xm_token", r.data.token);
      wx.setStorageSync("xm_user", r.data.user);
      getApp().globalData.user = r.data.user;
    }
    return { code: r.code, id: r.data?.user?.id, role: r.data?.user?.role };
  });
  assert.equal(result.code, 0);
  return result;
}
async function staffLogin() {
  const login = privateJSON("live-login-args")[0];
  const r = evaluate(
    async function (i) {
      const auth = async (path, data) =>
        (
          await wx.cloud.callFunction({
            name: "auth",
            data: { path, method: "POST", data },
          })
        ).result;
      const sent = await auth("/auth/sms-code", { phone: i.phone });
      if (sent.code !== 0) return { code: sent.code };
      const r = await auth("/auth/staff-login", {
        account: i.phone,
        smsCode: i.code,
      });
      if (r.code === 0) {
        wx.setStorageSync("xm_token", r.data.token);
        wx.setStorageSync("xm_user", r.data.user);
        getApp().globalData.user = r.data.user;
      }
      return { code: r.code, role: r.data?.user?.role };
    },
    [login],
  );
  assert.equal(r.code, 0, "开发员工登录应成功；本运行器不触发真实短信");
  return r;
}
function source() {
  execFileSync(
    process.execPath,
    [path.join(root, "scripts/sync-cloudfunctions.js")],
    { stdio: "ignore" },
  );
  Object.assign(process.env, variables, { TCB_ENV: envId });
  let openid = "";
  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === "wx-server-sdk")
      return { init() {}, getWXContext: () => ({ OPENID: openid }) };
    return original.call(this, name, ...args);
  };
  const fns = {};
  for (const n of fs.readdirSync(path.join(root, "cloudfunctions")))
    if (
      fs.existsSync(path.join(root, "cloudfunctions", n, "index.js")) &&
      !["agent-expiry"].includes(n)
    )
      fns[n] = require(path.join(root, "cloudfunctions", n)).main;
  Module._load = original;
  const raw = (who, name, p, method = "GET", data = {}, headers = {}) => {
    openid = who.openid;
    return fns[name](
      {
        path: p,
        method,
        data,
        headers: { Authorization: "Bearer " + who.token, ...headers },
      },
      { request_id: "role-regression-" + crypto.randomUUID() },
    );
  };
  const call = async (
    who,
    name,
    p,
    method = "GET",
    data = {},
    expected = 0,
    headers = {},
  ) => {
    const r = await raw(who, name, p, method, data, headers);
    assert.equal(r.code, expected, `${method} ${p}: ${r.code} ${r.message}`);
    return r.data;
  };
  return { raw, call };
}
module.exports = {
  root,
  local,
  variables,
  privateJSON,
  pg,
  rpc,
  evaluate,
  native,
  navigate,
  save,
  guest,
  staffLogin,
  source,
};
