/** 专用验证库；绝不清空生产库。保留数据用于复查，不自动 DROP。 */
const mysql = require("mysql2/promise");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const { migrate } = require("./migrate");
async function main() {
  const root = path.resolve(__dirname, "../..");
  const secrets = JSON.parse(
    await fs.readFile(path.join(root, ".local/mysql-accounts.json"), "utf8"),
  );
  const db = await mysql.createConnection({
    user: "root",
    password: secrets.root,
    socketPath: path.join(root, ".local/mysql.sock"),
  });
  await db.query(
    "CREATE DATABASE IF NOT EXISTS xiamu_verification CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
  );
  await db.query("USE xiamu_verification");
  await migrate(db);
  const filename = path.join(root, "server/.env.test");
  let password;
  try {
    password = (await fs.readFile(filename, "utf8")).match(
      /^TEST_DB_PASSWORD=(.+)$/m,
    )[1];
  } catch {
    password = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(filename, `TEST_DB_PASSWORD=${password}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  await db.query(
    "CREATE USER IF NOT EXISTS 'erp_test_runtime'@'127.0.0.1' IDENTIFIED BY ?",
    [password],
  );
  await require("./privileges").grantRuntime(
    db,
    "xiamu_verification",
    "erp_test_runtime",
  );
  await db.end();
  console.log("专用验证库已就绪，审计/版本表保留只追加权限。");
}
main().catch((e) => {
  console.error(e.code || e.message);
  process.exitCode = 1;
});
