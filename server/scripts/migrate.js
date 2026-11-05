const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createPool, one } = require("../src/db");
const { config } = require("../src/config");
const { ROLE_PERMISSIONS, ROLE_LABELS } = require("../src/core");
const { defaultVisibleFields } = require("../../miniprogram/constants/roles");
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
    // 字段可见性首次按默认表初始化，之后以后台配置为准
    await pool.execute(
      "UPDATE roles SET visible_fields=? WHERE role_key=? AND visible_fields IS NULL",
      [JSON.stringify(defaultVisibleFields(role)), role],
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
  await categoryTemplates(pool);
  await upgradePhoneTemplate(pool);
}
/**
 * 每个分类一套入库模板（2026-11-05 起）。旧数据每个型号各有一份复制模板：
 * 手机分类沿用 t_phone；其他分类取被型号使用最多、其次最近发布的模板；没有模板的分类复制手机模板。
 * 之后所有型号统一指向所属分类的模板，旧模板及其版本保留供已入库快照追溯。
 */
async function categoryTemplates(pool) {
  const [categories] = await pool.query(
    "SELECT id,label FROM categories WHERE template_id IS NULL ORDER BY created_at,id",
  );
  for (const category of categories) {
    let chosen = await one(
      pool,
      "SELECT t.id FROM templates t JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version LEFT JOIN models m ON m.template_id=t.id WHERE t.category_id=? GROUP BY t.id,v.published_at ORDER BY t.id='t_phone' DESC,COUNT(m.id) DESC,v.published_at DESC,t.id LIMIT 1",
      [category.id],
    );
    if (!chosen) {
      const base = await one(
        pool,
        "SELECT v.fields,v.description_presets FROM categories c JOIN templates t ON t.id=c.template_id JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE c.id='phone'",
      );
      if (!base) continue;
      chosen = { id: "t_" + crypto.randomUUID() };
      await pool.execute(
        "INSERT INTO templates (id,name,category_id,current_version) VALUES (?,?,?,1)",
        [chosen.id, category.label + "通用模板", category.id],
      );
      await pool.execute(
        "INSERT INTO template_versions (template_id,version,fields,description_presets) VALUES (?,1,?,?)",
        [chosen.id, base.fields, base.description_presets],
      );
    }
    await pool.execute("UPDATE categories SET template_id=? WHERE id=?", [
      chosen.id,
      category.id,
    ]);
  }
  await pool.query(
    "UPDATE models m JOIN categories c ON c.id=m.category_id SET m.template_id=c.template_id WHERE c.template_id IS NOT NULL AND m.template_id<>c.template_id",
  );
}
/** 已有库的手机分类模板发布一个补充字段的新版本；新库的种子已是新内容，不会重复发布 */
async function upgradePhoneTemplate(pool) {
  const current = await one(
    pool,
    "SELECT t.id,t.current_version,v.fields,v.description_presets FROM categories c JOIN templates t ON t.id=c.template_id JOIN template_versions v ON v.template_id=t.id AND v.version=t.current_version WHERE c.id='phone'",
  );
  if (!current) return;
  const fields = require("../../miniprogram/mock/fields").upgradePhoneFields(
    typeof current.fields === "string"
      ? JSON.parse(current.fields)
      : current.fields,
  );
  if (!fields) return;
  const version = current.current_version + 1;
  await pool.execute(
    "INSERT INTO template_versions (template_id,version,fields,description_presets) VALUES (?,?,?,?)",
    [
      current.id,
      version,
      JSON.stringify(fields),
      typeof current.description_presets === "string"
        ? current.description_presets
        : JSON.stringify(current.description_presets),
    ],
  );
  await pool.execute("UPDATE templates SET current_version=? WHERE id=?", [
    version,
    current.id,
  ]);
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
module.exports = { migrate, categoryTemplates, upgradePhoneTemplate };
