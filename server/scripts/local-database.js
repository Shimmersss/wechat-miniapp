/** 初始化本项目独立 MySQL 的账号；不访问系统已有的 3306 实例。凭据只写本地文件。 */
const mysql = require("mysql2/promise");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { migrate } = require("./migrate");
async function main() {
  const root = path.resolve(__dirname, "../..");
  const envPath = path.join(root, "server/.env");
  try {
    await fs.access(envPath);
    throw new Error("server/.env 已存在，拒绝覆盖");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const connection = await mysql.createConnection({
    user: "root",
    socketPath: path.join(root, ".local/mysql.sock"),
  });
  const password = () => crypto.randomBytes(32).toString("hex");
  const secrets = {
    root: password(),
    runtime: password(),
    migration: password(),
    readonly: password(),
    backup: password(),
    otp: password(),
    file: password(),
  };
  await connection.query(
    "CREATE DATABASE IF NOT EXISTS xiamu CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
  );
  await connection.query("USE xiamu");
  await migrate(connection);
  const modes = ["runtime", "migration", "readonly", "backup"];
  for (const mode of modes)
    await connection.query(`CREATE USER ?@'127.0.0.1' IDENTIFIED BY ?`, [
      "erp_" + mode,
      secrets[mode],
    ]);
  await require("./privileges").grantRuntime(
    connection,
    "xiamu",
    "erp_runtime",
  );
  const [tables] = await connection.query(
    "SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema='xiamu' AND TABLE_TYPE='BASE TABLE'",
  );
  for (const { name } of tables)
    await connection.query(
      `GRANT SELECT ON xiamu.\`${name}\` TO 'erp_backup'@'127.0.0.1'`,
    );
  await connection.query(
    "GRANT ALL PRIVILEGES ON xiamu.* TO 'erp_migration'@'127.0.0.1'",
  );
  await connection.query(
    "GRANT SELECT ON xiamu.report_catalog TO 'erp_readonly'@'127.0.0.1'",
  );
  await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [
    secrets.root,
  ]);
  const settings = {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_ORIGIN: "http://127.0.0.1:3000",
    DB_HOST: "127.0.0.1",
    DB_PORT: "3307",
    DB_NAME: "xiamu",
    DB_USER: "erp_runtime",
    DB_PASSWORD: secrets.runtime,
    OTP_HASH_KEY: secrets.otp,
    FILE_SIGNING_KEY: secrets.file,
    FILE_ROOT: path.join(root, ".local/files"),
    WX_APP_ID: "",
    WX_APP_SECRET: "",
  };
  await fs.writeFile(
    envPath,
    Object.entries(settings)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  await fs.writeFile(
    path.join(root, "server/.env.migration"),
    `MIGRATION_DB_USER=erp_migration\nMIGRATION_DB_PASSWORD=${secrets.migration}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await fs.writeFile(
    path.join(root, ".local/mysql-accounts.json"),
    JSON.stringify(secrets),
    { mode: 0o600, flag: "wx" },
  );
  await connection.end();
  console.log("项目数据库与四类账号已创建；凭据保存在受限本地文件中。");
}
main().catch((e) => {
  console.error("数据库初始化失败:", e.code || e.message);
  process.exitCode = 1;
});
