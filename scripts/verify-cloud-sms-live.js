#!/usr/bin/env node
/** 已部署短信登录 + 真实微信SDK验收。使用忽略目录中的隔离夹具；临时切换测试员工，finally恢复原角色/状态及顾客会话。 */
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
function evaluate(fn, args = []) {
  const file = path.join(root, local + "/sms-eval-args.json");
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
    name: i.name || "auth",
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

// 验收夹具用服务端 PG REST 读写单行，避免每条 SQL 启动管理 MCP；多表业务仍走云函数 RPC。
const privateVars = Object.fromEntries(
  fs
    .readFileSync(local + "/functions.env", "utf8")
    .split("\n")
    .map((x) => /^([A-Z_]+)=(.*)$/.exec(x))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const privateEnv = JSON.parse(
  fs.readFileSync(local + "/sms-config-before.json"),
).envId;
async function pg(resource, method = "GET", data) {
  const r = await fetch(
    `https://${privateEnv}.api.tcloudbasegateway.com/v1/rdb/rest/${resource}`,
    {
      method,
      headers: {
        Authorization: "Bearer " + privateVars.CLOUDBASE_API_KEY,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!r.ok) throw Error("验收夹具PG网关操作失败，HTTP " + r.status);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function auditCount(id) {
  const r = await fetch(
    `https://${privateEnv}.api.tcloudbasegateway.com/v1/rdb/rest/audit_logs?object_id=eq.${id}&action=eq.${encodeURIComponent("员工登录并绑定微信")}&select=id`,
    {
      headers: {
        Authorization: "Bearer " + privateVars.CLOUDBASE_API_KEY,
        Prefer: "count=exact",
        Range: "0-0",
      },
      signal: AbortSignal.timeout(12000),
    },
  );
  if (!r.ok) throw Error("验收审计计数失败");
  const total = Number((r.headers.get("content-range") || "").split("/")[1]);
  if (!Number.isInteger(total)) throw Error("验收审计计数缺失");
  return total;
}
const phase = process.argv[2] || "inspect",
  results = { checks: [] };
const raw = (path, data = {}) =>
  evaluate(request.toString(), [{ path, method: "POST", data, name: "auth" }]);
(async () => {
  if (phase === "inspect") {
    let r = raw("/auth/sms-code", { phone: "bad" });
    assert.equal(r.code, 400);
    const phone = "199" + String(crypto.randomInt(1e8)).padStart(8, "0");
    const exists = await pg("staff?phone=eq." + phone + "&select=id");
    assert.equal(exists.length, 0);
    r = raw("/auth/sms-code", { phone });
    assert.equal(r.code, 0);
    assert.equal(r.data.verification_id, undefined);
    assert.equal(r.data.message.includes(login.code), false);
    r = raw("/auth/staff-login", {
      account: phone,
      smsCode: "000000",
      verified: true,
      mockRole: "boss",
    });
    assert.equal(r.code, 401);
    results.checks.push(
      "真实微信已部署正式短信路径：非法手机号拒绝、未知员工统一响应且无发信/固定码泄露、伪造身份登录拒绝",
    );
    r = raw("/auth/sms-captcha");
    assert.equal(r.code, 0);
    assert.match(r.data.image, /^data:image\/(gif|png|jpeg);base64,/);
    assert.ok(r.data.token);
    results.captchaBytes = r.data.image.length;
    results.checks.push(
      "真实平台图片验证码可获取，响应仅包含图片及本人作答challenge",
    );
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
        "/pages/login/index",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const page = evaluate(
      async function () {
        const p = getCurrentPages().slice(-1)[0];
        await p.refreshCaptcha();
        const fs = wx.getFileSystemManager();
        let exists = false;
        try {
          exists = fs.readFileSync(p.data.captchaImage).byteLength > 0;
        } catch {}
        return {
          route: p.route,
          error: p.data.error,
          hasCaptcha: !!p.data.captchaToken,
          imageSaved: exists,
          sendingCode: p.data.sendingCode,
          submitting: p.data.submitting,
        };
      }.toString(),
    );
    assert.equal(page.error, "");
    assert.equal(page.hasCaptcha, true);
    assert.equal(page.imageSaved, true);
    results.page = page;
    results.checks.push(
      "真实登录页从云端获取图片并保存为微信本地文件，风控补救界面正常加载",
    );
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
  } else if (["send", "verify"].includes(phase)) {
    const input = JSON.parse(fs.readFileSync(local + "/sms-live-input.json"));
    assert.match(
      input.phone,
      /^1\d{10}$/,
      "请在忽略目录提供本人可收短信的手机号",
    );
    const employee = (
      await pg("staff?phone=eq." + login.phone + "&select=id,phone,user_id")
    )[0];
    assert.ok(employee, "找不到原测试员工，先核对本机夹具");
    assert.match(employee.id, /^[0-9a-f-]{36}$/);
    const duplicate = (
      await pg("staff?phone=eq." + input.phone + "&select=id")
    )[0];
    assert.ok(
      !duplicate || duplicate.id === employee.id,
      "收信号码已属于另一员工，不能替换其绑定；请使用当前微信对应员工本人手机号",
    );
    fs.writeFileSync(
      local + "/sms-live-staff-before.json",
      JSON.stringify(employee),
      { mode: 0o600 },
    );
    const setPhone = (phone) =>
      pg("staff?id=eq." + employee.id, "PATCH", { phone });
    const before = await auditCount(employee.id);
    try {
      // 仅给现有本机测试员工临时换上已确认的收信号码；不改绑定/角色，finally还原。
      const current = evaluate(
        async function () {
          await wx.cloud.callFunction({
            name: "auth",
            data: {
              path: "/auth/logout",
              method: "POST",
              data: {},
              headers: {
                Authorization: "Bearer " + wx.getStorageSync("xm_token"),
              },
            },
          });
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
          return { code: r.code, id: r.data?.user?.id };
        }.toString(),
      );
      assert.equal(current.code, 0);
      assert.equal(
        current.id,
        employee.user_id,
        "微信身份与原测试员工不一致，禁止改动他人账户",
      );
      await setPhone(input.phone);
      if (phase === "send") {
        const data = { phone: input.phone };
        if (input.captchaCode) {
          const cap = JSON.parse(
            fs.readFileSync(local + "/sms-live-captcha.json"),
          );
          data.captchaToken = cap.token;
          data.captchaCode = input.captchaCode;
        }
        const r = raw("/auth/sms-code", data);
        if (r.code === 428) {
          const cap = raw("/auth/sms-captcha");
          assert.equal(cap.code, 0);
          fs.writeFileSync(
            local + "/sms-live-captcha.json",
            JSON.stringify(cap.data),
            { mode: 0o600 },
          );
          fs.writeFileSync(
            local + "/sms-live-captcha.gif",
            Buffer.from(cap.data.image.split(",")[1], "base64"),
          );
          throw Error(
            "平台要求图片验证码，图片已保存在本机忽略目录，须作答后重试",
          );
        }
        assert.equal(r.code, 0, r.message);
        assert.equal(r.data.verification_id, undefined);
        assert.equal(r.data.message.includes(login.code), false);
        const challenge = (
          await pg(
            "sms_challenges?phone=eq." +
              input.phone +
              "&select=provider_kind,delivered,verification_id,consumed,expires_at",
          )
        )[0];
        challenge.has_id = !!challenge.verification_id;
        assert.equal(challenge.provider_kind, "cloudbase");
        assert.ok([true, "true"].includes(challenge.delivered));
        assert.ok([true, "true"].includes(challenge.has_id));
        assert.ok([false, "false"].includes(challenge.consumed));
        results.sent = true;
        results.challenge = {
          providerKind: challenge.provider_kind,
          delivered: true,
          serverOnlyVerificationId: true,
        };
        results.checks.push(
          "真实微信调用已部署函数，平台接受真实短信发送；PG仅服务端保存验证标识，前端不返回验证码",
        );
      } else {
        assert.match(input.code, /^\d{6}$/, "请在忽略目录填写收到的六位验证码");
        const probe = evaluate(
          async function (i) {
            const invoke = async (
              path,
              data,
              token = wx.getStorageSync("xm_token"),
            ) =>
              (
                await wx.cloud.callFunction({
                  name: "auth",
                  data: {
                    path,
                    method: path === "/auth/me" ? "GET" : "POST",
                    data,
                    headers: { Authorization: "Bearer " + token },
                  },
                })
              ).result;
            const oldToken = wx.getStorageSync("xm_token");
            const wrong = String((Number(i.code) + 1) % 1000000).padStart(
              6,
              "0",
            );
            const rejected = await invoke("/auth/staff-login", {
              account: i.phone,
              smsCode: wrong,
            });
            const concurrent = await Promise.all([
              invoke("/auth/staff-login", {
                account: i.phone,
                smsCode: i.code,
              }),
              invoke("/auth/staff-login", {
                account: i.phone,
                smsCode: i.code,
              }),
            ]);
            const accepted = concurrent.find((x) => x.code === 0);
            if (accepted) {
              wx.setStorageSync("xm_token", accepted.data.token);
              wx.setStorageSync("xm_user", accepted.data.user);
              getApp().globalData.user = accepted.data.user;
            }
            const me = await invoke("/auth/me", {}),
              guest = await invoke("/auth/me", {}, oldToken),
              replay = await invoke("/auth/staff-login", {
                account: i.phone,
                smsCode: i.code,
              });
            return {
              wrongCode: rejected.code,
              codes: concurrent.map((x) => x.code),
              role: me.data?.role,
              oldGuestCode: guest.code,
              replayCode: replay.code,
              leakedProof:
                !!accepted &&
                (accepted.data.verification_id !== undefined ||
                  accepted.data.verification_token !== undefined),
            };
          }.toString(),
          [input],
        );
        assert.equal(probe.wrongCode, 401);
        assert.equal(probe.codes.filter((x) => x === 0).length, 1);
        assert.ok(probe.codes.some((x) => [401, 409].includes(x)));
        assert.equal(probe.role, "sales");
        assert.equal(probe.oldGuestCode, 401);
        assert.equal(probe.replayCode, 401);
        assert.equal(probe.leakedProof, false);
        results.probe = probe;
        const unit = JSON.parse(
          fs.readFileSync(local + "/customer-fixture.json"),
        ).unitId;
        const inventory = evaluate(request.toString(), [
          { name: "staff-stock", path: "/units/" + unit, method: "GET" },
        ]);
        assert.equal(inventory.code, 0);
        assert.equal(inventory.data.cost, undefined);
        const after = await auditCount(employee.id);
        assert.equal(after - before, 1);
        results.checks.push(
          "真实收到的短信：错码拒绝，正确码并发仅一次登录，旧顾客会话和重放均拒绝，平台证明不返回客户端",
        );
        results.checks.push(
          "真实短信登录后的销售仍看不到成本，员工登录审计恰增一条",
        );
      }
    } finally {
      await setPhone(employee.phone);
      const restoredEmployee = (
        await pg("staff?id=eq." + employee.id + "&select=phone,user_id")
      )[0];
      assert.equal(restoredEmployee.phone, employee.phone);
      assert.equal(restoredEmployee.user_id, employee.user_id);
      results.originalPhoneRestored = true;
      const restored = evaluate(
        async function () {
          await wx.cloud.callFunction({
            name: "auth",
            data: {
              path: "/auth/logout",
              method: "POST",
              data: {},
              headers: {
                Authorization: "Bearer " + wx.getStorageSync("xm_token"),
              },
            },
          });
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
    }
  } else {
    throw Error("支持 inspect/send/verify 三个验收阶段");
  }

  results.passed = true;
  fs.writeFileSync(
    local + "/sms-live-" + phase + "-results.json",
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
