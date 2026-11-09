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
const devOtp = () => {
  if (
    process.env.SMS_PROVIDER &&
    !["cloudbase", "development"].includes(process.env.SMS_PROVIDER)
  )
    fail(503, "短信模式配置无效");
  return process.env.NODE_ENV !== "production" &&
    process.env.SMS_PROVIDER !== "cloudbase"
    ? process.env.OTP_DEV_CODE || ""
    : "";
};
const provider = require("./shared/sms-provider");
async function flow(ctx, action, data) {
  if (!ctx.openid) fail(401, "无法识别微信身份");
  return unwrap(
    await rpc("api_sms_flow", {
      p_action: action,
      p_data: data,
      p_actor: provider.device(ctx.openid),
      p_request_id: ctx.requestId,
    }),
  );
}

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

async function smsCaptcha(ctx) {
  await flow(ctx, "captcha", {});
  return provider.captcha(ctx.openid);
}
async function smsCode(ctx) {
  const phone = text(ctx.data.phone, "手机号", 11);
  if (!phonePattern.test(phone)) fail(400, "手机号格式无效");
  const dev = devOtp(),
    kind = dev ? "development" : "cloudbase";
  let captcha;
  if (ctx.data.captchaToken !== undefined || ctx.data.captchaCode !== undefined)
    captcha = {
      token: text(ctx.data.captchaToken, "图片验证标识", 4096),
      key: text(ctx.data.captchaCode, "图片验证码", 16),
    };
  // 先核验图片，随后 reserve 才允许解除本次验证码触发的冷却；不能信任客户端布尔标记。
  let challenge;
  if (captcha && !dev) {
    await flow(ctx, "captcha", {});
    const r = await provider.requestCaptcha(captcha, ctx.openid);
    challenge = r;
  }
  const attemptHash = hmac(
    secret("OTP_HASH_KEY"),
    phone + ":" + (dev || crypto.randomUUID()),
  );
  const limit = Number(process.env.SMS_DAILY_LIMIT || 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    fail(503, "短信额度配置无效");
  const reserved = await flow(ctx, "reserve", {
    phone,
    attemptHash,
    kind,
    captchaPassed: !!challenge,
    dailyLimit: limit,
  });
  if (reserved.reserved) {
    try {
      const r = dev ? {} : await provider.send(phone, ctx.openid, challenge);
      await flow(ctx, "mark", { phone, attemptHash, delivered: true, ...r });
    } catch (e) {
      await flow(ctx, "mark", {
        phone,
        attemptHash,
        delivered: false,
        captchaRequired: e.statusCode === 428,
      });
      throw e;
    }
    if (dev) return { sent: true, message: "开发模式：验证码为 " + dev };
  }
  return { sent: true, message: "如该手机号已开通员工账号，将收到验证码" };
}
async function staffLogin(ctx) {
  const phone = text(ctx.data.account, "手机号", 11),
    smsCode = text(ctx.data.smsCode, "验证码", 6);
  if (!phonePattern.test(phone) || !/^\d{6}$/.test(smsCode))
    fail(400, "手机号或验证码格式无效");
  if (!ctx.openid) fail(401, "无法识别微信身份");
  const dev = devOtp(),
    kind = dev ? "development" : "cloudbase",
    challenge = await flow(ctx, "begin", { phone, kind });
  let valid = false;
  try {
    valid = dev
      ? challenge.codeHash ===
        hmac(secret("OTP_HASH_KEY"), phone + ":" + smsCode)
      : await provider.verify(challenge.verificationId, smsCode, ctx.openid);
  } catch (e) {
    await flow(ctx, "complete", {
      phone,
      kind,
      nonce: challenge.nonce,
      verified: false,
    }).catch(() => {});
    throw e;
  }
  const token = newToken();
  const row = await flow(ctx, "complete", {
    phone,
    kind,
    nonce: challenge.nonce,
    verified: valid,
    openid: ctx.openid,
    tokenHash: hash(token),
    hours: sessionHours(),
  });
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
  ["POST", "/auth/sms-captcha", smsCaptcha],
  ["POST", "/auth/staff-login", staffLogin],
  ["GET", "/auth/me", requireUser],
  ["POST", "/auth/logout", logout],
]);
