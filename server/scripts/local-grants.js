const mysql = require("mysql2/promise");
const fs = require("node:fs/promises");
const path = require("node:path");
const { grantRuntime } = require("./privileges");
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
  try {
    await grantRuntime(db, "xiamu", "erp_runtime");
    const [tables] = await db.query(
      "SELECT TABLE_NAME name FROM information_schema.tables WHERE table_schema='xiamu' AND TABLE_TYPE='BASE TABLE'",
    );
    for (const { name } of tables)
      await db.query(
        `GRANT SELECT ON xiamu.\`${name}\` TO 'erp_backup'@'127.0.0.1'`,
      );
    await db.query(
      "GRANT SELECT ON xiamu.report_inventory TO 'erp_readonly'@'127.0.0.1'",
    );
    console.log("本机应用/报表/备份权限已按表更新，审计和流水仅可追加。");
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.code || e.message);
  process.exitCode = 1;
});
