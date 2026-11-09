const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk")
    return { init() {}, getWXContext: () => ({ OPENID: "platform-only" }) };
  return original.call(this, name, ...args);
};
const provider = require("../cloudfunctions/common/sms-provider");
Module._load = original;
function environment() {
  const names = ["TCB_ENV", "OTP_HASH_KEY", "CLOUDBASE_API_KEY"],
    saved = names.map((n) => process.env[n]);
  process.env.TCB_ENV = "unit-test";
  process.env.OTP_HASH_KEY = "test-only-key";
  process.env.CLOUDBASE_API_KEY = "never-send-service-key";
  const old = global.fetch;
  return () => {
    global.fetch = old;
    names.forEach((n, i) =>
      saved[i] === undefined
        ? delete process.env[n]
        : (process.env[n] = saved[i]),
    );
  };
}
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
test("平台生成短信，ANY/+86，服务端验证标识且不发送数据库密钥", async () => {
  const restore = environment();
  try {
    let called;
    global.fetch = async (url, o) => {
      called = { url, ...o };
      return response({ verification_id: "private-id", expires_in: 600 });
    };
    const r = await provider.send("19900000001", "wx-test");
    assert.equal(r.verificationId, "private-id");
    assert.equal(r.expiresIn, 300);
    assert.deepEqual(JSON.parse(called.body), {
      phone_number: "+86 19900000001",
      target: "ANY",
    });
    assert.equal(called.headers.Authorization, undefined);
    assert.equal(
      JSON.stringify(called).includes("never-send-service-key"),
      false,
    );
    assert.ok(called.url.endsWith("/auth/v1/verification"));
  } finally {
    restore();
  }
});
test("验证码校验只调用verify，缺verification_token不认成功，不注册平台身份", async () => {
  const restore = environment();
  try {
    let calls = [];
    global.fetch = async (url, o) => {
      calls.push(url);
      assert.deepEqual(JSON.parse(o.body), {
        verification_id: "private-id",
        verification_code: "012345",
      });
      return response({ verification_token: "server-proof" });
    };
    assert.equal(
      await provider.verify("private-id", "012345", "wx-test"),
      true,
    );
    assert.deepEqual(
      calls.map((x) => new URL(x).pathname),
      ["/auth/v1/verification/verify"],
    );
    global.fetch = async () => response({});
    await assert.rejects(
      provider.verify("private-id", "012345", "wx-test"),
      (e) => e.statusCode === 503,
    );
  } finally {
    restore();
  }
});
test("平台captcha/限频/错码/网络故障分别明确失败，错误描述不回显", async () => {
  const restore = environment();
  try {
    for (const [body, status, expected] of [
      [{ error: "captcha_required", error_code: 4028 }, 400, 428],
      [{ error: "rate_limit_exceeded" }, 429, 429],
      [
        {
          error: "invalid_verification_code",
          error_description: "private-provider-payload",
        },
        400,
        401,
      ],
    ]) {
      global.fetch = async () => response(body, status);
      await assert.rejects(
        provider.verify("id", "123456", "wx-test"),
        (e) =>
          e.statusCode === expected &&
          !e.message.includes("private-provider-payload"),
      );
    }
    global.fetch = async () => {
      throw Error("private-network-data");
    };
    await assert.rejects(
      provider.send("19900000001", "wx-test"),
      (e) => e.statusCode === 503 && !e.message.includes("private-network"),
    );
  } finally {
    restore();
  }
});
test("图片验证按微信派生设备摘要，限制图像类型和大小，仅透传图片挑战", async () => {
  const restore = environment();
  try {
    assert.equal(provider.device("one"), provider.device("one"));
    assert.notEqual(provider.device("one"), provider.device("two"));
    assert.equal(provider.device("one").length, 64);
    global.fetch = async () =>
      response({
        type: "image",
        data: "data:image/gif;base64,R0lGODlh",
        token: "image-challenge",
      });
    assert.equal((await provider.captcha("wx-test")).token, "image-challenge");
    global.fetch = async () =>
      response({
        type: "image",
        data: "data:text/html;base64,abcd",
        token: "x",
      });
    await assert.rejects(
      provider.captcha("wx-test"),
      (e) => e.statusCode === 503,
    );
    global.fetch = async () =>
      response({ captcha_token: "private-captcha-proof" });
    assert.equal(
      await provider.requestCaptcha(
        { token: "challenge", key: "text" },
        "wx-test",
      ),
      "private-captcha-proof",
    );
  } finally {
    restore();
  }
});

function authHarness(env) {
  const calls = [],
    gateway = require("../cloudfunctions/common/gateway"),
    api = {
      send: async () => {
        calls.push({ provider: "send" });
        return { verificationId: "private-id", expiresIn: 300 };
      },
      verify: async () => {
        calls.push({ provider: "verify" });
        return true;
      },
      device: () => "a".repeat(64),
    };
  const exports = {},
    ctx = {
      exports,
      process: { env },
      require(name) {
        if (name === "node:crypto") return require(name);
        if (name === "./shared/gateway")
          return {
            ...gateway,
            secret: (n) => env[n] || gateway.fail(503, "missing test setting"),
            rpc: async (fn, p) => {
              calls.push({ fn, ...p });
              if (p.p_action === "reserve") return { reserved: true };
              if (p.p_action === "begin")
                return {
                  nonce: "nonce",
                  verificationId: "private-id",
                  codeHash: gateway.hmac("unit-key", "19900000001:123456"),
                };
              if (p.p_action === "complete") return { user: { role: "sales" } };
              return {};
            },
          };
        if (name === "./shared/sms-provider") return api;
        if (name === "./shared/identity") return { userView: (r) => r.user };
        throw Error(name);
      },
    };
  require("node:vm").runInNewContext(
    require("node:fs").readFileSync(
      require.resolve("../cloudfunctions/auth/index.js"),
      "utf8",
    ),
    ctx,
  );
  return { main: exports.main, calls };
}
test("production始终忽略固定码，开发显式cloudbase也走平台；客户端身份与证明字段不能覆盖平台上下文", async () => {
  for (const env of [
    { NODE_ENV: "production", SMS_PROVIDER: "development" },
    { NODE_ENV: "development", SMS_PROVIDER: "cloudbase" },
  ]) {
    const { main, calls } = authHarness({
      ...env,
      OTP_DEV_CODE: "123456",
      OTP_HASH_KEY: "unit-key",
    });
    const sent = await main(
      {
        path: "/auth/sms-code",
        method: "POST",
        data: { phone: "19900000001", provider: "development" },
      },
      {},
    );
    assert.equal(sent.code, 0);
    assert.equal(sent.data.message.includes("123456"), false);
    assert.ok(calls.some((x) => x.provider === "send"));
    const login = await main(
      {
        path: "/auth/staff-login",
        method: "POST",
        data: {
          account: "19900000001",
          smsCode: "123456",
          openid: "forged",
          verified: true,
          mockRole: "boss",
        },
      },
      {},
    );
    assert.equal(login.code, 0);
    assert.equal(login.data.user.role, "sales");
    assert.ok(calls.some((x) => x.provider === "verify"));
    const complete = calls.find((x) => x.p_action === "complete").p_data;
    assert.equal(complete.openid, "platform-only");
    assert.equal(complete.kind, "cloudbase");
    assert.equal(login.data.verification_id, undefined);
  }
});
test("非production显式开发模式保留固定码，成功证明只由服务端产生", async () => {
  const { main, calls } = authHarness({
    NODE_ENV: "development",
    SMS_PROVIDER: "development",
    OTP_DEV_CODE: "123456",
    OTP_HASH_KEY: "unit-key",
  });
  assert.equal(
    (
      await main(
        {
          path: "/auth/sms-code",
          method: "POST",
          data: { phone: "19900000001" },
        },
        {},
      )
    ).code,
    0,
  );
  assert.equal(
    (
      await main(
        {
          path: "/auth/staff-login",
          method: "POST",
          data: { account: "19900000001", smsCode: "123456" },
        },
        {},
      )
    ).code,
    0,
  );
  assert.equal(
    calls.some((x) => x.provider),
    false,
  );
  assert.equal(
    calls.find((x) => x.p_action === "complete").p_data.verified,
    true,
  );
});
