const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const mysql = require("mysql2/promise");
const { config } = require("../src/config");
const { createPool } = require("../src/db");
const { buildApp } = require("../src/app");
const { id, hash, STAFF_ROLES } = require("../src/core");
const root = path.resolve(__dirname, "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
function imei() {
  const prefix =
    "98" + String(crypto.randomInt(0, 1000000000000)).padStart(12, "0");
  let sum = 0;
  [...prefix].forEach((v, i) => {
    let n = Number(v) * (i % 2 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return prefix + ((10 - (sum % 10)) % 10);
}
async function fixture(roles = ["boss", "warehouse", "sales", "customer"]) {
  const password = (
    await fs.readFile(path.join(root, ".env.test"), "utf8")
  ).match(/^TEST_DB_PASSWORD=(.+)$/m)[1];
  const cfg = config({
    ...process.env,
    DB_NAME: "xiamu_verification",
    DB_USER: "erp_test_runtime",
    DB_PASSWORD: password,
    FILE_ROOT: path.join(root, "../.local/verification-files"),
  });
  const secrets = JSON.parse(
    await fs.readFile(path.join(root, "../.local/mysql-accounts.json"), "utf8"),
  );
  const admin = await mysql.createConnection({
    user: "root",
    password: secrets.root,
    socketPath: path.join(root, "../.local/mysql.sock"),
    database: "xiamu_verification",
  });
  const pool = createPool(cfg.database),
    tokens = {},
    users = {};
  // Test setup inserts fixture sessions in a dedicated DB. There is no test-login endpoint in production.
  // "customer:b" creates a second user with role customer, addressed as "customer:b".
  for (const entry of roles) {
    const role = entry.split(":")[0],
      userId = id();
    await admin.execute(
      "INSERT INTO users (id,openid,nickname) VALUES (?,?,?)",
      [userId, "fixture_" + userId, "验证" + role],
    );
    if (["peer", "agent"].includes(role))
      await admin.execute("UPDATE users SET role=? WHERE id=?", [role, userId]);
    if (STAFF_ROLES.includes(role)) {
      let inserted = false;
      while (!inserted) {
        try {
          await admin.execute(
            "INSERT INTO staff (id,user_id,phone,name,role_key) VALUES (?,?,?,?,?)",
            [
              id(),
              userId,
              "139" + String(crypto.randomInt(0, 100000000)).padStart(8, "0"),
              "验证" + role,
              role,
            ],
          );
          inserted = true;
        } catch (e) {
          if (e.code !== "ER_DUP_ENTRY") throw e;
        }
      }
    }
    const token = crypto.randomBytes(32).toString("base64url");
    tokens[entry] = token;
    users[entry] = userId;
    await admin.execute(
      "INSERT INTO sessions (token_hash,user_id,expires_at,assurance) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR),?)",
      [hash(token), userId, STAFF_ROLES.includes(role) ? "staff" : "wechat"],
    );
  }
  let app = await buildApp(cfg, { pool }),
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  cfg.publicOrigin = origin;
  async function api(method, url, body, role = "boss", extraHeaders = {}) {
    const result = await fetch(origin + "/api/v1" + url, {
      method,
      headers: {
        ...(role ? { Authorization: "Bearer " + tokens[role] } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const response = await result.json();
    return { status: result.status, ...response };
  }
  async function upload(scope = "internal", role = "boss") {
    const data = new FormData();
    data.set("scope", scope);
    data.set("file", new Blob([png], { type: "image/png" }), "fixture.png");
    const result = await fetch(origin + "/api/v1/files", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokens[role] },
      body: data,
    });
    if (result.status !== 200) throw new Error("验证凭证上传失败");
    return (await result.json()).data;
  }
  async function restart() {
    await app.close();
    app = await buildApp(cfg, { pool });
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
    cfg.publicOrigin = origin;
  }
  async function close() {
    await app.close();
    await pool.end();
    await admin.end();
  }
  return { cfg, pool, admin, tokens, users, api, upload, restart, close };
}
function attributes(template, receipt) {
  return Object.fromEntries(
    template.fields.map((f) => [
      f.key,
      f.type === "select"
        ? f.options[0]
        : f.type === "number"
          ? f.key === "battery"
            ? 96
            : 0
          : f.type === "image"
            ? [{ fileId: receipt.fileId }]
            : f.key === "supplier"
              ? "由服务端核验"
              : "验证参数",
    ]),
  );
}
module.exports = { fixture, imei, attributes };
