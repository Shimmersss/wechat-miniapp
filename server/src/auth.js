const crypto = require("node:crypto");
const { transaction, one } = require("./db");
const {
  fail,
  id,
  hash,
  hmac,
  equal,
  text,
  loadUser,
  audit,
} = require("./core");
const phonePattern = /^1\d{10}$/;
module.exports = async function auth(app, { pool, config, providers, route }) {
  async function session(db, userId, assurance = "wechat") {
    const token = crypto.randomBytes(32).toString("base64url");
    await db.execute(
      "INSERT INTO sessions (token_hash,user_id,expires_at,assurance) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? HOUR),?)",
      [hash(token), userId, config.sessionHours, assurance],
    );
    return { token, user: await loadUser(db, userId, assurance === "staff") };
  }
  async function upsertUser(db, openid) {
    const userId = id();
    await db.execute(
      "INSERT INTO users (id,openid) VALUES (?,?) ON DUPLICATE KEY UPDATE openid=VALUES(openid)",
      [userId, openid],
    );
    const user = await one(
      db,
      "SELECT * FROM users WHERE openid=? FOR UPDATE",
      [openid],
    );
    if (user.status !== "active") fail(403, "账号已停用");
    return user;
  }
  route(
    "POST",
    "/auth/wx-login",
    async (request) => {
      const openid = await providers.wechat(
        text(request.body?.code, "微信登录凭证", 256),
      );
      return transaction(pool, async (db) => {
        const user = await upsertUser(db, openid);
        return session(db, user.id);
      });
    },
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
  );
  route(
    "POST",
    "/auth/sms-code",
    async (request) => {
      const phone = text(request.body?.phone, "手机号", 11);
      if (!phonePattern.test(phone)) fail(400, "手机号格式无效");
      // 开发模式用固定验证码，方便在没配短信时登录
      const code = config.devOtp
        ? config.devOtp
        : String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const challengeHash = hmac(config.otpKey, phone + ":" + code);
      const reserved = await transaction(pool, async (db) => {
        const staff = await one(
          db,
          "SELECT id FROM staff WHERE phone=? AND status='active' FOR UPDATE",
          [phone],
        );
        if (!staff) return false; // Same outward response: do not enumerate employee accounts.
        const challenge = await one(
          db,
          "SELECT *, sent_at > DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 60 SECOND) AS cooling FROM sms_challenges WHERE phone=? FOR UPDATE",
          [phone],
        );
        // 开发模式下跳过 60 秒冷却，方便反复调试
        if (challenge?.cooling && !config.devOtp)
          fail(429, "请稍后再获取验证码");
        await db.execute(
          `INSERT INTO sms_challenges (phone,code_hash,expires_at,sent_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE),UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE code_hash=VALUES(code_hash),expires_at=VALUES(expires_at),sent_at=VALUES(sent_at),attempts=0,consumed=FALSE,delivered=FALSE`,
          [phone, challengeHash],
        );
        return true;
      });
      if (reserved) {
        // 开发模式：不真的发短信，直接把挑战标记为已送达
        if (config.devOtp) {
          await pool.execute(
            "UPDATE sms_challenges SET delivered=TRUE WHERE phone=? AND code_hash=?",
            [phone, challengeHash],
          );
          return {
            sent: true,
            message: "开发模式：验证码为 " + config.devOtp,
          };
        }
        try {
          await providers.sms(phone, code);
          await pool.execute(
            "UPDATE sms_challenges SET delivered=TRUE WHERE phone=? AND code_hash=?",
            [phone, challengeHash],
          );
        } catch (e) {
          await pool.execute(
            "UPDATE sms_challenges SET consumed=TRUE WHERE phone=? AND code_hash=?",
            [phone, challengeHash],
          );
          throw e;
        }
      }
      return { sent: true, message: "如该手机号已开通员工账号，将收到验证码" };
    },
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
  );
  route(
    "POST",
    "/auth/staff-login",
    async (request) => {
      const phone = text(request.body?.account, "手机号", 11),
        smsCode = text(request.body?.smsCode, "验证码", 6);
      if (!phonePattern.test(phone) || !/^\d{6}$/.test(smsCode))
        fail(400, "手机号或验证码格式无效");
      // Never use mockRole, client openid, or client permissions to identify a person.
      // 开发模式（配了 OTP_DEV_CODE 且非 production）允许跳过微信换取 openid，
      // 用一个按手机号派生的稳定 openid，保证同一手机号每次登录是同一个用户。
      const devOpenid = config.devOtp
        ? "dev_" + hmac(config.otpKey, "openid:" + phone).slice(0, 24)
        : "";
      const openid = devOpenid
        ? devOpenid
        : await providers.wechat(
            text(request.body?.code, "微信登录凭证", 256),
          );
      const outcome = await transaction(pool, async (db) => {
        const staff = await one(
          db,
          "SELECT * FROM staff WHERE phone=? AND status='active' FOR UPDATE",
          [phone],
        );
        const challenge = await one(
          db,
          "SELECT *, expires_at > UTC_TIMESTAMP(3) AS valid FROM sms_challenges WHERE phone=? FOR UPDATE",
          [phone],
        );
        if (
          !staff ||
          !challenge ||
          !challenge.valid ||
          challenge.consumed ||
          !challenge.delivered ||
          challenge.attempts >= 5
        )
          return { error: "验证码无效或已过期" };
        // 开发固定码：命中则完全跳过短信校验（生产环境 config.devOtp 恒为空）
        const devPass = !!config.devOtp && smsCode === config.devOtp;
        // 正常路径：挑战存在且验证码哈希一致
        const codeMatches =
          !!challenge &&
          equal(challenge.code_hash, hmac(config.otpKey, phone + ":" + smsCode));
        if (!devPass && !codeMatches) {
          await db.execute(
            "UPDATE sms_challenges SET attempts=attempts+1 WHERE phone=?",
            [phone],
          );
          return { error: "验证码无效或已过期" }; // Commit attempt counter, do not roll it back by throwing here.
        }
        const user = await upsertUser(db, openid);
        if (staff.user_id && staff.user_id !== user.id)
          fail(409, "员工账号已绑定其他微信，请联系管理员");
        const bound = await one(
          db,
          "SELECT id FROM staff WHERE user_id=? FOR UPDATE",
          [user.id],
        );
        if (bound && bound.id !== staff.id)
          fail(409, "当前微信已绑定其他员工账号");
        await db.execute("UPDATE staff SET user_id=? WHERE id=?", [
          user.id,
          staff.id,
        ]);
        await db.execute(
          "UPDATE sms_challenges SET consumed=TRUE WHERE phone=?",
          [phone],
        );
        // Revoke guest/older sessions on this identity when elevating to employee.
        await db.execute("DELETE FROM sessions WHERE user_id=?", [user.id]);
        const result = await session(db, user.id, "staff");
        await audit(
          db,
          { id: request.id, ip: request.ip, user: result.user },
          "员工登录并绑定微信",
          staff.id,
        );
        return result;
      });
      if (outcome.error) fail(401, outcome.error);
      return outcome;
    },
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
  );
  route("GET", "/auth/me", async (request) => {
    if (!request.user) fail(401, "请先登录");
    return request.user;
  });
  route("POST", "/auth/logout", async (request) => {
    if (request.sessionHash)
      await pool.execute("DELETE FROM sessions WHERE token_hash=?", [
        request.sessionHash,
      ]);
    return true;
  });
};
