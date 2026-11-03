const fs = require("node:fs/promises");
const path = require("node:path");
const { createPool, one } = require("../src/db");
const { config } = require("../src/config");
const { ROLE_PERMISSIONS, ROLE_LABELS } = require("../src/core");
async function migrate(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(100) PRIMARY KEY, applied_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3))`,
  );
  const directory = path.join(__dirname, "../migrations");
  for (const name of (await fs.readdir(directory))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      await one(pool, "SELECT name FROM schema_migrations WHERE name=?", [name])
    )
      continue;
    const sql = await fs.readFile(path.join(directory, name), "utf8");
    // Migration files are trusted repository sources; runtime connections never enable multipleStatements.
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await pool.query(statement);
    await pool.execute("INSERT INTO schema_migrations (name) VALUES (?)", [
      name,
    ]);
  }
  for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await pool.execute(
      "INSERT IGNORE INTO roles (role_key,label,permissions) VALUES (?,?,?)",
      [role, ROLE_LABELS[role], JSON.stringify(permissions)],
    );
  }
  await pool.execute("INSERT IGNORE INTO categories (id,label) VALUES (?,?)", [
    "phone",
    "手机",
  ]);
  await pool.execute(
    "INSERT IGNORE INTO templates (id,name,category_id,current_version) VALUES (?,?,?,?)",
    ["t_phone", "手机通用模板", "phone", 1],
  );
  const fields = require("../../miniprogram/mock/fields").fields();
  await pool.execute(
    "INSERT IGNORE INTO template_versions (template_id,version,fields,description_presets) VALUES (?,?,?,?)",
    [
      "t_phone",
      1,
      JSON.stringify(fields),
      JSON.stringify({ peer: [], customer: [] }),
    ],
  );
}
if (require.main === module) {
  const cfg = config();
  const pool = createPool({
    ...cfg.database,
    user: process.env.MIGRATION_DB_USER || cfg.database.user,
    password: process.env.MIGRATION_DB_PASSWORD || cfg.database.password,
  });
  migrate(pool)
    .then(() => console.log("数据库迁移完成"))
    .finally(() => pool.end())
    .catch((e) => {
      console.error("迁移失败:", e.code || e.message);
      process.exitCode = 1;
    });
}
module.exports = { migrate };
