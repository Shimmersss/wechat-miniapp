/**
 * 登录与会话（对应 server/src/auth.js）。
 * 身份以平台注入的 OPENID 为准，不信任客户端传来的 openid、角色或 mockRole。
 */
const crypto = require("node:crypto");
const {
  createHandler,
  rpc,
  fail,
  hash,
  hmac,
  newToken,
  text,
  secret,
  tokenHash,
} = require("./shared/gateway");
const { userView, requireUser } = require("./shared/identity");

const phonePattern = /^1\d{10}$/;
const sessionHours = () => Number(process.env.SESSION_HOURS || 12);
// 开发固定验证码：只在非 production 生效，上线前必须删除该环境变量
const devOtp = () =>
  process.env.NODE_ENV !== "production" ? process.env.OTP_DEV_CODE || "" : "";

/** 数据库函数以 { error, message } 返回业务失败（需要提交部分写入时不能用异常回滚） */
function unwrap(result) {
  if (result && result.error) fail(result.error, result.message);
  return result;
}

async function wxLogin(ctx) {
  if (!ctx.openid) fail(401, "无法识别微信身份");
  const token = newToken();
  const row = unwrap(
    await rpc("api_wx_login", {
      p_openid: ctx.openid,
      p_token_hash: hash(token),
      p_hours: sessionHours(),
    }),
  );
  return { token, user: userView(row) };
}

async function smsCode(ctx) {
  const phone = text(ctx.data.phone, "手机号", 11);
  if (!phonePattern.test(phone)) fail(400, "手机号格式无效");
  const dev = devOtp();
  const code = dev || String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const challengeHash = hmac(secret("OTP_HASH_KEY"), phone + ":" + code);
  const { reserved } = unwrap(
    await rpc("api_sms_reserve", {
      p_phone: phone,
      p_code_hash: challengeHash,
      p_skip_cooling: !!dev,
    }),
  );
  if (reserved) {
    if (dev) {
      await rpc("api_sms_mark", {
        p_phone: phone,
        p_code_hash: challengeHash,
        p_delivered: true,
      });
      return { sent: true, message: "开发模式：验证码为 " + dev };
    }
    // TODO(confirm): 短信通道（腾讯云短信或云开发短信）未接入；失败时作废本次挑战，不伪造发送成功
    await rpc("api_sms_mark", {
      p_phone: phone,
      p_code_hash: challengeHash,
      p_delivered: false,
    });
    fail(503, "短信服务未配置");
  }
  return { sent: true, message: "如该手机号已开通员工账号，将收到验证码" };
}

async function staffLogin(ctx) {
  const phone = text(ctx.data.account, "手机号", 11);
  const smsCode = text(ctx.data.smsCode, "验证码", 6);
  if (!phonePattern.test(phone) || !/^\d{6}$/.test(smsCode))
    fail(400, "手机号或验证码格式无效");
  if (!ctx.openid) fail(401, "无法识别微信身份");
  const dev = devOtp();
  const token = newToken();
  const row = unwrap(
    await rpc("api_staff_login", {
      p_phone: phone,
      p_code_matches_hash: hmac(secret("OTP_HASH_KEY"), phone + ":" + smsCode),
      p_dev_pass: !!dev && smsCode === dev,
      p_openid: ctx.openid,
      p_token_hash: hash(token),
      p_hours: sessionHours(),
      p_request_id: ctx.requestId,
    }),
  );
  return { token, user: userView(row) };
}

async function logout(ctx) {
  const h = tokenHash(ctx.headers);
  if (h) await rpc("api_logout", { p_token_hash: h });
  return true;
}

exports.main = createHandler([
  ["POST", "/auth/wx-login", wxLogin],
  ["POST", "/auth/sms-code", smsCode],
  ["POST", "/auth/staff-login", staffLogin],
  ["GET", "/auth/me", requireUser],
  ["POST", "/auth/logout", logout],
]);
