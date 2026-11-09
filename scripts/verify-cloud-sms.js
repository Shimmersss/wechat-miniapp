#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的短信挑战/登录事务集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-reports.js。使用已登录 tcb/mcporter、functions.env。
 * 创建随机隔离验证员工；保留数据和审计作为验证证据，不自动删除。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
process.chdir(root);
execFileSync(process.execPath, ["scripts/sync-cloudfunctions.js"]);
const local = ".local/cloudbase";
fs.mkdirSync(local, { recursive: true });
const variables = Object.fromEntries(
  fs
    .readFileSync(`${local}/functions.env`, "utf8")
    .split("\n")
    .map((x) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(x.trim()))
    .filter(Boolean)
    .map((x) => [x[1], x[2]]),
);
const listing = execFileSync("tcb", ["env", "list", "--json"], {
  encoding: "utf8",
});
const envId = JSON.parse(listing.slice(listing.indexOf("{"))).data[0].EnvId;
process.env.TCB_ENV = envId;
process.env.CLOUDBASE_API_KEY = variables.CLOUDBASE_API_KEY;
process.env.OTP_HASH_KEY = variables.OTP_HASH_KEY;
process.env.WHOLESALE_DISCOUNT = variables.WHOLESALE_DISCOUNT || "0";
if (!process.env.CLOUDBASE_API_KEY) throw new Error("缺少 CLOUDBASE_API_KEY");
function control(tool, args) {
  let raw;
  try {
    raw = execFileSync(
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
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (e) {
    if (!e.stdout) throw Error("CloudBase control request failed");
    raw = String(e.stdout);
  }
  const result = JSON.parse(raw.slice(raw.indexOf("{")));
  if (!result.success) throw new Error(result.message || result.errorCode);
  return result;
}

process.env.NODE_ENV = variables.NODE_ENV || "development";
process.env.OTP_DEV_CODE = variables.OTP_DEV_CODE;

process.env.NODE_ENV = "development";
process.env.SMS_PROVIDER = "development";
process.env.OTP_DEV_CODE = variables.OTP_DEV_CODE;
const fixture = { openid: "sms-guard-" + crypto.randomUUID() },
  uid = crypto.randomUUID(),
  sid = crypto.randomUUID(),
  phone = "199" + String(crypto.randomInt(1e8)).padStart(8, "0");
const execute = (sql) =>
  control("managePgDatabase", { action: "execute", confirm: true, sql });
const query = (sql) =>
  control("queryPgDatabase", { action: "sql", sql, limit: 100 }).data.rows;
execute(
  `INSERT INTO users(id,openid,nickname) VALUES('${uid}','${fixture.openid}','短信隔离验证');INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${sid}','${uid}','${phone}','短信隔离验证','sales');`,
);
const old = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk")
    return { init() {}, getWXContext: () => ({ OPENID: fixture.openid }) };
  return old.call(this, name, ...args);
};
const auth = require("../cloudfunctions/auth").main,
  { rpc } = require("../cloudfunctions/auth/shared/gateway"),
  provider = require("../cloudfunctions/auth/shared/sms-provider");
Module._load = old;
const results = { checks: [] },
  check = (s) => {
    results.checks.push(s);
    console.log("PASS", s);
  };
const event = (path, data) =>
  auth({ path, method: "POST", data }, { request_id: "sms-guard-" + sid });
const actor = provider.device(fixture.openid),
  hash = () => crypto.randomBytes(32).toString("hex");
const flow = (action, data) =>
  rpc("api_sms_flow", {
    p_action: action,
    p_data: { phone, ...data },
    p_actor: actor,
    p_request_id: "sms-guard-" + sid,
  });
const expect = async (action, data, code) => {
  const r = await flow(action, data);
  assert.equal(r.error, code);
  return r;
};
(async () => {
  let sent = await event("/auth/sms-code", { phone });
  assert.equal(sent.code, 0);
  let guest = await event("/auth/wx-login", {});
  assert.equal(guest.data.user.role, "customer");
  const login = await event("/auth/staff-login", {
    account: phone,
    smsCode: variables.OTP_DEV_CODE,
    openid: "forged",
    mockRole: "boss",
  });
  assert.equal(login.code, 0);
  assert.equal(login.data.user.role, "sales");
  assert.equal(login.data.verification_id, undefined);
  assert.equal(
    (
      await event("/auth/staff-login", {
        account: phone,
        smsCode: variables.OTP_DEV_CODE,
      })
    ).code,
    401,
  );
  assert.equal(
    Number(
      query(`SELECT count(*) n FROM sessions WHERE user_id='${uid}'`)[0].n,
    ),
    1,
  );
  check(
    "真实PG+函数源码开发固定码登录仍绑定真实微信上下文；撤销旧顾客会话且重放拒绝，无身份字段伪造",
  );
  // 以下直接调用真实PG守卫，合成验证标识用于测试事务边界，不声称发送或平台验证了真实短信。
  let attempt = hash();
  let r = await flow("reserve", {
    kind: "development",
    attemptHash: attempt,
    dailyLimit: 10,
  });
  assert.equal(r.reserved, true);
  await flow("mark", { attemptHash: attempt, delivered: true });
  const concurrent = await Promise.all([
    flow("begin", { kind: "development" }),
    flow("begin", { kind: "development" }),
  ]);
  assert.equal(concurrent.filter((x) => !x.error).length, 1);
  assert.equal(concurrent.find((x) => x.error).error, 409);
  const lease = concurrent.find((x) => !x.error);
  await expect(
    "complete",
    { kind: "development", nonce: crypto.randomUUID(), verified: true },
    409,
  );
  await expect(
    "complete",
    { kind: "development", nonce: lease.nonce, verified: false },
    401,
  );
  for (let i = 0; i < 4; i++) {
    const l = await flow("begin", { kind: "development" });
    assert.ok(l.nonce);
    await expect(
      "complete",
      { kind: "development", nonce: l.nonce, verified: false },
      401,
    );
  }
  await expect("begin", { kind: "development" }, 401);
  assert.equal(
    Number(
      query(`SELECT attempts FROM sms_challenges WHERE phone='${phone}'`)[0]
        .attempts,
    ),
    5,
  );
  check(
    "真实PG同一挑战并发验证只发一个租约；伪造nonce拒绝，五次失败计数提交且正确码也不能绕过封锁",
  );
  attempt = hash();
  await flow("reserve", {
    kind: "development",
    attemptHash: attempt,
    dailyLimit: 10,
  });
  await flow("mark", { attemptHash: attempt, delivered: true });
  const stale = await flow("begin", { kind: "development" });
  await flow("reserve", {
    kind: "development",
    attemptHash: hash(),
    dailyLimit: 10,
  });
  await expect(
    "complete",
    { kind: "development", nonce: stale.nonce, verified: true },
    401,
  );
  await expect("mark", { attemptHash: attempt, delivered: true }, 409);
  check("重新发码使旧校验租约和迟到的发送登记失效，不覆盖新挑战");
  // 换隔离来源避免前面刻意失败次数触发同来源每分钟限频；不是跳过PG限频验证。
  fixture.openid = "sms-guard-" + crypto.randomUUID();
  const cloudActor = provider.device(fixture.openid);
  const f = (action, data) =>
    rpc("api_sms_flow", {
      p_action: action,
      p_data: { phone, ...data },
      p_actor: cloudActor,
      p_request_id: "sms-cloud-guard-" + sid,
    });
  execute(
    `UPDATE sms_challenges SET sent_at=now()-interval '2 minutes' WHERE phone='${phone}';`,
  );
  attempt = hash();
  r = await f("reserve", {
    kind: "cloudbase",
    attemptHash: attempt,
    dailyLimit: 100,
  });
  assert.equal(r.reserved, true);
  r = await f("reserve", {
    kind: "cloudbase",
    attemptHash: hash(),
    dailyLimit: 100,
  });
  assert.equal(r.error, 429);
  await f("mark", {
    attemptHash: attempt,
    delivered: false,
    captchaRequired: true,
  });
  r = await f("reserve", {
    kind: "cloudbase",
    attemptHash: hash(),
    dailyLimit: 100,
  });
  assert.equal(r.error, 428);
  attempt = hash();
  r = await f("reserve", {
    kind: "cloudbase",
    attemptHash: attempt,
    dailyLimit: 100,
    captchaPassed: true,
  });
  assert.equal(r.reserved, true);
  await f("mark", {
    attemptHash: attempt,
    delivered: true,
    verificationId: "synthetic-guard-only",
    expiresIn: 60,
  });
  assert.equal((await f("begin", { kind: "development" })).error, 401);
  const cl = await f("begin", { kind: "cloudbase" });
  assert.equal(cl.verificationId, "synthetic-guard-only");
  execute(
    `UPDATE sms_challenges SET expires_at=now()-interval '1 second' WHERE phone='${phone}';`,
  );
  assert.equal(
    (
      await f("complete", {
        kind: "cloudbase",
        nonce: cl.nonce,
        verified: true,
      })
    ).error,
    401,
  );
  check(
    "真实PG正式挑战60秒冷却、图片风控重试、开发/正式模式隔离与到期拒绝；合成标识只测数据库边界",
  );
  for (let i = 0; i < 6; i++)
    r = await rpc("api_sms_flow", {
      p_action: "reserve",
      p_data: {
        phone: "199" + String(crypto.randomInt(1e8)).padStart(8, "0"),
        kind: "cloudbase",
        attemptHash: hash(),
        dailyLimit: 100,
      },
      p_actor: hashRateActor,
      p_request_id: "sms-rate-guard",
    });
  assert.equal(r.error, 429);
  check("未知员工外观相同且不发送短信；按微信摘要5次/分钟限频在真实PG生效");
  execute(`DO $probe$ DECLARE r jsonb;before_n int;after_n int;BEGIN
   SELECT attempts INTO before_n FROM sms_send_budget WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date;
   BEGIN
    UPDATE sms_send_budget SET attempts=10 WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date;
    UPDATE sms_challenges SET sent_at=now()-interval '2 minutes',captcha_required=false WHERE phone='${phone}';
    r:=api_sms_flow('reserve',jsonb_build_object('phone','${phone}','kind','cloudbase','attemptHash',repeat('a',64),'dailyLimit',10),'${hash()}','sms-budget-rollback');
    IF r->>'error'<>'429' THEN RAISE EXCEPTION 'daily budget allowed';END IF;
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback budget probe';
   EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;END;
   SELECT attempts INTO after_n FROM sms_send_budget WHERE day=(now() AT TIME ZONE 'Asia/Shanghai')::date;
   IF before_n IS DISTINCT FROM after_n THEN RAISE EXCEPTION 'budget restore failed';END IF;
  END $probe$;`);
  check(
    "真实PG回滚事务验证本系统每日发送预算耗尽拒绝，原预算计数恢复；不能约束平台公开发送API",
  );
  const grants = query(
    `SELECT jsonb_agg(q) rows FROM(SELECT proname,prosecdef,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='api_sms_flow')q`,
  )[0].rows;
  results.functions = typeof grants === "string" ? JSON.parse(grants) : grants;
  for (const g of results.functions) {
    assert.ok([false, "false"].includes(g.prosecdef));
    assert.ok([false, "false"].includes(g.anon));
    assert.ok([false, "false"].includes(g.authenticated));
    assert.ok([true, "true"].includes(g.service));
  }
  check("真实RPC INVOKER且仅service_role可执行");
  results.passed = true;
  fs.writeFileSync(
    local + "/sms-guard-results.json",
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
const hashRateActor = hash();
