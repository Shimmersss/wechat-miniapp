/** 一次性离线创建老板手机号；首次通过短信+微信验证后完成绑定，不创建默认密码。 */
const { createPool, transaction, one } = require("../src/db");
const { config } = require("../src/config");
const { id } = require("../src/core");
async function main() {
  const phone = process.env.BOOTSTRAP_BOSS_PHONE;
  if (!/^1\d{10}$/.test(phone || ""))
    throw new Error("请通过 BOOTSTRAP_BOSS_PHONE 设置老板手机号");
  const pool = createPool(config().database);
  try {
    await transaction(pool, async (db) => {
      const existing = await one(
        db,
        "SELECT id FROM staff WHERE role_key='boss' AND status='active' FOR UPDATE",
      );
      if (existing) throw new Error("已有老板账号，拒绝重复引导");
      await db.execute(
        "INSERT INTO staff (id,phone,name,role_key) VALUES (?,?,?,?)",
        [id(), phone, process.env.BOOTSTRAP_BOSS_NAME || "老板", "boss"],
      );
    });
    console.log("老板账号已建立，首次登录需验证短信并绑定微信。");
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e.code || e.message);
  process.exitCode = 1;
});
