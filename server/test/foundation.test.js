const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { config } = require("../src/config");
const { createPool, one } = require("../src/db");
const { buildApp } = require("../src/app");
const { id } = require("../src/core");
const root = path.resolve(__dirname, "..");
const prefix = "verify_" + Date.now();
let cfg,
  pool,
  admin,
  app,
  origin,
  phone,
  code,
  bossToken,
  guestToken,
  templateId;
async function api(method, url, data, token) {
  const result = await fetch(origin + "/api/v1" + url, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return { status: result.status, body: await result.json() };
}
async function upload(scope, token, bytes) {
  const form = new FormData();
  form.set("scope", scope);
  form.set("bizType", "unit");
  form.set("file", new Blob([bytes], { type: "image/png" }), "fixture.png");
  const result = await fetch(origin + "/api/v1/files", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form,
  });
  return { status: result.status, body: await result.json() };
}
// Only external WeChat/SMS are test doubles. HTTP, MySQL, transactions, sessions and files are real.
const providers = {
  wechat: async (value) => {
    if (value === "bad")
      throw Object.assign(new Error("微信登录凭证无效"), { statusCode: 401 });
    return prefix + "_" + value;
  },
  sms: async (phone, value) => {
    code = value;
  },
};
test.before(async () => {
  const password = (
    await fs.readFile(path.join(root, ".env.test"), "utf8")
  ).match(/^TEST_DB_PASSWORD=(.+)$/m)[1];
  cfg = config({
    ...process.env,
    DB_NAME: "xiamu_verification",
    DB_USER: "erp_test_runtime",
    DB_PASSWORD: password,
    FILE_ROOT: path.join(root, "../.local/verification-files"),
  });
  assert.equal(cfg.database.database, "xiamu_verification");
  pool = createPool(cfg.database);
  const secrets = JSON.parse(
    await fs.readFile(path.join(root, "../.local/mysql-accounts.json"), "utf8"),
  );
  admin = await mysql.createConnection({
    user: "root",
    password: secrets.root,
    socketPath: path.join(root, "../.local/mysql.sock"),
    database: "xiamu_verification",
  });
  phone = "130" + String(Date.now()).slice(-8);
  await admin.execute(
    "INSERT INTO staff (id,phone,name,role_key) VALUES (?,?,?,?)",
    [id(), phone, "验证老板", "boss"],
  );
  app = await buildApp(cfg, { pool, providers });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cfg.publicOrigin = origin;
});
test.after(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
});
test("真实 HTTP/MySQL 身份、短信防重放和权限", async () => {
  let r = await api("GET", "/catalog/categories");
  assert.equal(r.status, 401);
  r = await api("POST", "/auth/wx-login", { code: "guest", role: "boss" });
  assert.equal(r.status, 200);
  guestToken = r.body.data.token;
  assert.equal(r.body.data.user.role, "customer");
  r = await api("POST", "/catalog/categories", { label: "越权" }, guestToken);
  assert.equal(r.status, 403);
  r = await api("POST", "/auth/sms-code", { phone });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.code, undefined);
  assert.match(code, /^\d{6}$/);
  let row = await one(pool, "SELECT * FROM sms_challenges WHERE phone=?", [
    phone,
  ]);
  assert.notEqual(row.code_hash, code);
  assert.equal((await api("POST", "/auth/sms-code", { phone })).status, 429);
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
  r = await api("POST", "/auth/staff-login", {
    account: phone,
    smsCode: wrong,
    code: "boss",
  });
  assert.equal(r.status, 401);
  row = await one(pool, "SELECT attempts FROM sms_challenges WHERE phone=?", [
    phone,
  ]);
  assert.equal(row.attempts, 1);
  r = await api("POST", "/auth/staff-login", {
    account: phone,
    smsCode: code,
    code: "boss",
    mockRole: "sales",
  });
  assert.equal(r.status, 200);
  bossToken = r.body.data.token;
  assert.equal(r.body.data.user.role, "boss");
  assert.equal(
    (
      await api("POST", "/auth/staff-login", {
        account: phone,
        smsCode: code,
        code: "boss",
      })
    ).status,
    401,
  );
  assert.equal(
    (await api("GET", "/auth/me", undefined, bossToken)).body.data.role,
    "boss",
  );
  const silent = await api("POST", "/auth/wx-login", { code: "boss" });
  assert.equal(
    silent.body.data.user.role,
    "customer",
    "绑定微信不代表员工二次验证已通过",
  );
  assert.equal(
    (await api("GET", "/templates", undefined, silent.body.data.token)).status,
    403,
  );
  assert.equal(
    (await api("POST", "/auth/wx-login", { code: "bad" })).status,
    401,
  );
});
test("持久化、并发发布和审计/版本只追加权限", async () => {
  let r = await api(
    "POST",
    "/catalog/categories",
    { label: prefix, copyTemplateId: "t_phone" },
    bossToken,
  );
  assert.equal(r.status, 200);
  const category = r.body.data.value;
  r = await api(
    "POST",
    "/models",
    {
      category,
      name: prefix,
      brandLabel: "验证品牌",
      series: "验证系列",
      copyTemplateId: "t_phone",
      tacs: ["99" + String(Date.now()).slice(-6)],
      tacSource: "合成夹具，非真实映射",
    },
    bossToken,
  );
  assert.equal(r.status, 200);
  templateId = r.body.data.templateId;
  const template = (
    await api("GET", `/templates/${templateId}`, undefined, bossToken)
  ).body.data;
  const results = await Promise.all(
    [1, 2].map(() =>
      api(
        "POST",
        `/templates/${templateId}/versions`,
        { baseVersion: template.version, fields: template.fields },
        bossToken,
      ),
    ),
  );
  assert.deepEqual(results.map((p) => p.status).sort(), [200, 409]);
  const user = (await api("GET", "/auth/me", undefined, bossToken)).body.data;
  await assert.rejects(
    pool.execute("UPDATE audit_logs SET reason=? WHERE actor_id=?", [
      "篡改",
      user.id,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await assert.rejects(
    pool.execute("UPDATE template_versions SET version=9 WHERE template_id=?", [
      templateId,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  assert.ok(
    Number(
      (
        await one(pool, "SELECT COUNT(*) n FROM audit_logs WHERE object_id=?", [
          templateId,
        ])
      ).n,
    ) >= 1,
  );
  await app.close();
  app = await buildApp(cfg, { pool, providers });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cfg.publicOrigin = origin;
  r = await api("GET", "/catalog/categories", undefined, bossToken);
  assert.ok(r.body.data.list.some((c) => c.value === category));
  assert.equal(
    (await api("GET", `/templates/${templateId}`, undefined, bossToken)).body
      .data.version,
    2,
  );
});
test("文件落盘、魔数校验、内部凭证签名及撤销", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal((await upload("public", guestToken, png)).status, 403);
  assert.equal(
    (
      await upload(
        "public",
        bossToken,
        Buffer.from("<html>not an image</html>"),
      )
    ).status,
    400,
  );
  let r = await upload("public", bossToken, png);
  assert.equal(r.status, 200);
  let download = await fetch(r.body.data.url);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  r = await upload("internal", bossToken, png);
  assert.equal(r.status, 200);
  const internal = r.body.data;
  assert.equal(
    (await api("GET", `/files/${internal.fileId}`, undefined, guestToken))
      .status,
    403,
  );
  assert.equal(
    (await fetch(origin + `/api/v1/files/${internal.fileId}/content`)).status,
    401,
  );
  download = await fetch(internal.url);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  const altered = new URL(internal.url);
  altered.searchParams.set("signature", "0".repeat(64));
  assert.equal((await fetch(altered)).status, 401);
  altered.searchParams.set("signature", "错".repeat(64));
  assert.equal((await fetch(altered)).status, 401);
  const record = await one(pool, "SELECT * FROM files WHERE id=?", [
    internal.fileId,
  ]);
  assert.equal(record.scope, "internal");
  assert.deepEqual(
    await fs.readFile(path.join(cfg.fileRoot, "internal", record.stored_name)),
    png,
  );
  await app.close();
  app = await buildApp(cfg, { pool, providers });
  origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cfg.publicOrigin = origin;
  const privatePath =
    new URL(internal.url).pathname + new URL(internal.url).search;
  assert.equal(
    (await fetch(origin + privatePath)).status,
    200,
    "重启后文件与权限元数据保留",
  );
  assert.equal((await api("POST", "/auth/logout", {}, bossToken)).status, 200);
  assert.equal((await fetch(origin + privatePath)).status, 401);
  assert.equal(
    (await api("GET", "/auth/me", undefined, bossToken)).status,
    401,
  );
});
