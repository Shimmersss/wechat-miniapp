#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的员工/角色维护集成验收（不是数据库 mock）。
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
const fixture = { tag: crypto.randomUUID() },
  results = { checks: [] };
const execute = (sql) =>
  control("managePgDatabase", { action: "execute", confirm: true, sql });
const query = (sql) =>
  control("queryPgDatabase", { action: "sql", sql, limit: 100 }).data.rows;
const quote = (v) => "'" + JSON.stringify(v).replaceAll("'", "''") + "'::jsonb";
function person(role) {
  return {
    uid: crypto.randomUUID(),
    sid: crypto.randomUUID(),
    openid: "staff-verify-" + crypto.randomUUID(),
    token: crypto.randomBytes(32).toString("hex"),
    phone: "199" + String(crypto.randomInt(1e8)).padStart(8, "0"),
    role,
  };
}
const people = {
  boss: person("boss"),
  manager: person("manager"),
  sales: person("sales"),
  warehouse: person("warehouse"),
  otherBoss: person("boss"),
  thirdBoss: person("boss"),
};
execute(
  Object.values(people)
    .map(
      (x) =>
        `INSERT INTO users(id,openid,nickname) VALUES('${x.uid}','${x.openid}','员工块隔离验证');INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${x.sid}','${x.uid}','${x.phone}','员工块隔离验证','${x.role}');INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash("sha256").update(x.token).digest("hex")}','${x.uid}','staff',now()+interval '2 hours');`,
    )
    .join("\n"),
);
let openid = people.boss.openid;
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk")
    return {
      init() {},
      DYNAMIC_CURRENT_ENV: "test",
      getWXContext: () => ({ OPENID: openid }),
    };
  return original.call(this, name, ...args);
};
const admin = require("../cloudfunctions/staff-admin").main,
  auth = require("../cloudfunctions/auth").main,
  stock = require("../cloudfunctions/staff-stock").main;
Module._load = original;
const { rules } = require("../cloudfunctions/staff-admin/shared/staff-input");
function raw(who, fn, url, method = "GET", data = {}) {
  openid = who.openid;
  return fn(
    {
      path: url,
      method,
      data,
      headers: { Authorization: "Bearer " + who.token },
    },
    { request_id: "staff-verification-" + fixture.tag },
  );
}
async function call(who, fn, url, method = "GET", data = {}, expected = 0) {
  const r = await raw(who, fn, url, method, data);
  assert.equal(r.code, expected, `${method} ${url}: ${r.code} ${r.message}`);
  return r.data;
}
const body = (more = {}) => ({ reason: "员工块隔离验收", ...more });
const check = (s) => {
  results.checks.push(s);
  console.log("PASS", s);
};
async function login(who, phone) {
  await call(who, auth, "/auth/sms-code", "POST", { phone });
  const r = await call(who, auth, "/auth/staff-login", "POST", {
    account: phone,
    smsCode: variables.OTP_DEV_CODE,
  });
  who.token = r.token;
  who.uid = r.user.id;
  who.sid = r.user.staffNo;
  return r.user;
}
(async () => {
  const { boss, manager, sales, warehouse, otherBoss, thirdBoss } = people;
  await call(sales, admin, "/staff", "GET", {}, 403);
  await call(sales, admin, "/roles", "GET", {}, 403);
  const rows = await call(boss, admin, "/roles");
  assert.equal(rows.canEdit, true);
  assert.equal(rows.list.find((x) => x.key === "boss").editable, false);
  assert.ok(
    rows.list.find((x) => x.key === "boss").visibleFields.includes("cost"),
  );
  assert.equal((await call(manager, admin, "/roles")).canEdit, false);
  const p = person("purchaser");
  const create = body({
    name: "隔离员工_" + fixture.tag,
    phone: p.phone,
    roleKey: p.role,
  });
  const dup = await Promise.all([
    raw(boss, admin, "/staff", "POST", create),
    raw(boss, admin, "/staff", "POST", create),
  ]);
  assert.deepEqual(
    dup.map((x) => x.code).sort((a, b) => a - b),
    [0, 409],
  );
  let target = dup.find((x) => x.code === 0).data;
  p.sid = target.id;
  assert.equal(target.wechatBound, false);
  assert.equal(target.version, 1);
  const list = await call(manager, admin, "/staff", "GET", {
    keyword: fixture.tag,
    pageSize: 1,
  });
  assert.equal(list.total, 1);
  assert.equal(list.list.length, 1);
  assert.equal(list.list[0].user_id, undefined);
  for (const extra of [
    { reason: "" },
    { user_id: boss.uid },
    { roleKey: "agent" },
  ])
    await call(boss, admin, "/staff", "POST", { ...create, ...extra }, 400);
  check("权限/名单筛选/白名单字段/新员工未绑定；并发重复手机号仅一次成功");
  await call(
    manager,
    admin,
    "/staff",
    "POST",
    body({ name: "越权", phone: person("boss").phone, roleKey: "boss" }),
    403,
  );
  await call(
    manager,
    admin,
    "/staff/" + target.id,
    "PATCH",
    body({ roleKey: "boss", version: target.version }),
    403,
  );
  await call(
    manager,
    admin,
    "/staff/" + boss.sid,
    "PATCH",
    body({ name: "越权", version: 1 }),
    403,
  );
  await call(
    manager,
    admin,
    "/staff/" + boss.sid + "/unbind",
    "POST",
    body({ version: 1 }),
    403,
  );
  for (const change of [{ status: "disabled" }, { roleKey: "sales" }])
    await call(
      boss,
      admin,
      "/staff/" + boss.sid,
      "PATCH",
      body({ ...change, version: 1 }),
      400,
    );
  await call(
    boss,
    admin,
    "/staff/" + boss.sid + "/unbind",
    "POST",
    body({ version: 1 }),
    400,
  );
  check("经理不能授予/修改/解绑老板；禁止停用、降级、解绑自己");
  const edit = await Promise.all(
    ["甲", "乙"].map((name) =>
      raw(
        manager,
        admin,
        "/staff/" + target.id,
        "PATCH",
        body({ name: "并发" + name, version: 1 }),
      ),
    ),
  );
  assert.deepEqual(
    edit.map((x) => x.code).sort((a, b) => a - b),
    [0, 409],
  );
  target = edit.find((x) => x.code === 0).data;
  assert.equal(target.version, 2);
  await call(
    boss,
    admin,
    "/staff/" + target.id,
    "PATCH",
    body({ phone: p.phone, version: 2 }),
    400,
  );
  await call(
    boss,
    admin,
    "/staff/" + target.id + "/unbind",
    "POST",
    body({ version: 2 }),
    409,
  );
  check("同版本并发员工修改 [0,409]；失败不改版本，手机号只读，未绑定不可解绑");
  const fresh = await login(p, p.phone);
  assert.equal(fresh.role, "purchaser");
  let wxSession = await call(p, auth, "/auth/wx-login", "POST");
  assert.equal(wxSession.user.role, "customer");
  const customerToken = wxSession.token;
  await call(p, auth, "/auth/me");
  const unit = JSON.parse(
    fs.readFileSync(local + "/customer-fixture.json"),
  ).unitId;
  assert.ok((await call(p, stock, "/units/" + unit)).cost !== undefined);
  target = await call(
    boss,
    admin,
    "/staff/" + p.sid,
    "PATCH",
    body({ roleKey: "sales", version: 2 }),
  );
  assert.equal((await call(p, auth, "/auth/me")).role, "sales");
  assert.equal((await call(p, stock, "/units/" + unit)).cost, undefined);
  target = await call(
    boss,
    admin,
    "/staff/" + p.sid,
    "PATCH",
    body({ status: "disabled", version: target.version }),
  );
  await call(p, auth, "/auth/me", "GET", {}, 401);
  await call({ ...p, token: customerToken }, auth, "/auth/me", "GET", {}, 401);
  assert.equal(
    Number(
      query(`SELECT count(*) n FROM sessions WHERE user_id='${p.uid}'`)[0].n,
    ),
    0,
  );
  await call(
    p,
    auth,
    "/auth/staff-login",
    "POST",
    { account: p.phone, smsCode: variables.OTP_DEV_CODE },
    401,
  );
  check(
    "开发固定码真实绑定；同令牌角色变更立即裁掉成本；停用撤销员工和顾客全部会话",
  );
  target = await call(
    boss,
    admin,
    "/staff/" + p.sid,
    "PATCH",
    body({ status: "active", version: target.version }),
  );
  await login(p, p.phone);
  wxSession = await call(p, auth, "/auth/wx-login", "POST");
  target = await call(
    boss,
    admin,
    "/staff/" + p.sid + "/unbind",
    "POST",
    body({ version: target.version }),
  );
  assert.equal(target.wechatBound, false);
  assert.equal(target.phone, p.phone);
  await call(p, auth, "/auth/me", "GET", {}, 401);
  await call(
    { ...p, token: wxSession.token },
    auth,
    "/auth/me",
    "GET",
    {},
    401,
  );
  const rebound = person("sales");
  await login(rebound, p.phone);
  assert.equal(rebound.sid, p.sid);
  await call(p, auth, "/auth/sms-code", "POST", { phone: p.phone });
  await call(
    p,
    auth,
    "/auth/staff-login",
    "POST",
    { account: p.phone, smsCode: variables.OTP_DEV_CODE },
    409,
  );
  check(
    "恢复后重新登录；解绑不改手机号并撤销全部会话；另一微信重新绑定且旧微信不能抢绑",
  );
  const role = rows.list.find((x) => x.key === "warehouse");
  const roleBody = body({
    permissions: role.permissions,
    visibleFields: role.visibleFields,
    version: role.version,
  });
  await call(manager, admin, "/roles/warehouse", "PUT", roleBody, 403);
  await call(boss, admin, "/roles/boss", "PUT", roleBody, 400);
  await call(
    boss,
    admin,
    "/roles/warehouse",
    "PUT",
    { ...roleBody, permissions: ["forged:perm"] },
    400,
  );
  const rc = await Promise.all([
    raw(boss, admin, "/roles/warehouse", "PUT", roleBody),
    raw(boss, admin, "/roles/warehouse", "PUT", roleBody),
  ]);
  assert.deepEqual(
    rc.map((x) => x.code).sort((a, b) => a - b),
    [0, 409],
  );
  check(
    "角色保存需老板/原因/白名单；并发 [0,409]，实际保存相同授权配置避免影响现有员工",
  );
  const u = { id: boss.uid, staffNo: boss.sid, role: "boss" };
  const tokenhash = crypto
    .createHash("sha256")
    .update(warehouse.token)
    .digest("hex");
  execute(`DO $probe$ DECLARE old roles; current_row jsonb; fresh jsonb; BEGIN SELECT * INTO old FROM roles WHERE role_key='warehouse'; BEGIN
 PERFORM api_staff_admin('roles.update',NULL,'warehouse',jsonb_build_object('permissions','[]'::jsonb,'visibleFields','["cost"]'::jsonb,'reason','回滚内角色动态生效验收','version',old.version),${quote(u)},${quote(rules)},'staff-rollback-probe');
 fresh:=api_session_user('${tokenhash}','${warehouse.openid}');
 IF fresh->'role_permissions'<>'[]'::jsonb OR fresh->'role_visible_fields'<>'["cost"]'::jsonb THEN RAISE EXCEPTION 'role refresh failed'; END IF;
 RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='rollback isolated permission probe';
 EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL; END;
 SELECT to_jsonb(rr) INTO current_row FROM roles rr WHERE role_key='warehouse';IF current_row<>to_jsonb(old) THEN RAISE EXCEPTION 'role not restored';END IF;
 END $probe$;`);
  check(
    "真实 PG 回滚事务验证角色定义变更立即影响现存会话，事务后原权限/字段/版本完整恢复",
  );
  execute(`DO $probe$ BEGIN
 BEGIN PERFORM staff_admin_transition_guard(${quote({ user_id: otherBoss.uid, role_key: "boss", status: "active" })},'sales','active',${quote(u)},1);RAISE EXCEPTION 'last boss unexpectedly allowed';EXCEPTION WHEN SQLSTATE 'P0409' THEN NULL;END;
 PERFORM staff_admin_transition_guard(${quote({ user_id: otherBoss.uid, role_key: "boss", status: "active" })},'sales','active',${quote(u)},2);
 END $probe$;`);
  const cross = await Promise.all([
    raw(
      otherBoss,
      admin,
      "/staff/" + thirdBoss.sid,
      "PATCH",
      body({ status: "disabled", version: 1 }),
    ),
    raw(
      thirdBoss,
      admin,
      "/staff/" + otherBoss.sid,
      "PATCH",
      body({ status: "disabled", version: 1 }),
    ),
  ]);
  assert.equal(cross.filter((x) => x.code === 0).length, 1);
  assert.ok(cross.some((x) => [401, 403, 409].includes(x.code)));
  results.crossBossCodes = cross.map((x) => x.code);
  check(
    "最后一名老板 PG 守卫边界验证；隔离老板互停并发仅一方成功，等待后重新校验操作者",
  );
  fs.writeFileSync(
    local + "/staff-fixture.json",
    JSON.stringify({ fixture, people, target, rebound }, null, 2),
    { mode: 0o600 },
  );
  const audits = query(
    `SELECT action,reason,before_data,after_data FROM audit_logs WHERE object_id='${p.sid}' ORDER BY id`,
  );
  assert.ok(audits.length >= 6);
  assert.ok(
    audits.every(
      (x) => x.reason === "员工块隔离验收" || x.action.includes("登录"),
    ),
  );
  const permissions = query(
    `SELECT jsonb_agg(q) rows FROM(SELECT proname,prosecdef,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('staff_admin_raw','staff_admin_transition_guard','api_staff_admin'))q`,
  )[0].rows;
  results.functions =
    typeof permissions === "string" ? JSON.parse(permissions) : permissions;
  assert.equal(results.functions.length, 3);
  for (const f of results.functions) {
    assert.ok([false, "false"].includes(f.prosecdef));
    assert.ok([false, "false"].includes(f.anon));
    assert.ok([false, "false"].includes(f.authenticated));
    assert.ok([true, "true"].includes(f.service));
  }
  const auditRights = execute(
    `SELECT has_table_privilege('service_role','audit_logs','INSERT') ins,has_table_privilege('service_role','audit_logs','UPDATE') upd,has_table_privilege('service_role','audit_logs','DELETE') del,has_table_privilege('service_role','audit_logs','TRUNCATE') trunc`,
  ).data.previewRows[0];
  assert.ok([true, "true"].includes(auditRights.ins));
  for (const k of ["upd", "del", "trunc"])
    assert.ok([false, "false"].includes(auditRights[k]));
  results.auditRights = auditRights;
  check(
    "真实审计含原因及前后值；三个函数 INVOKER 且仅 service_role；审计只追加实际授权",
  );
  results.passed = true;
  fs.writeFileSync(
    local + "/staff-fixture.json",
    JSON.stringify({ fixture, people, target, rebound }, null, 2),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    local + "/staff-results.json",
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(results));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
