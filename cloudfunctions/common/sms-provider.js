/** 云开发默认短信/图片验证码公共 API。短信验证标识与核验 token 不返回客户端；图片 challenge 返回本人用于作答。 */
const { fail, hmac, secret } = require("./gateway");
function device(openid) {
  return hmac(secret("OTP_HASH_KEY"), "sms-device:" + openid);
}
async function request(path, data, openid, captchaToken) {
  const env = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
  if (!env) fail(503, "短信服务缺少环境配置");
  let response, body;
  try {
    response = await fetch(
      `https://${env}.api.tcloudbasegateway.com/auth/v1/${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-id": device(openid),
          ...(captchaToken ? { "x-captcha-token": captchaToken } : {}),
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(1600),
      },
    );
    body = await response.json();
  } catch {
    fail(503, "短信服务暂时不可用，请稍后重试");
  }
  if (body.error === "captcha_required" || body.error_code === 4028)
    fail(428, "请完成图片验证后重试");
  if (
    response.status === 429 ||
    body.error === "rate_limit_exceeded" ||
    body.error_code === 4029
  )
    fail(429, "短信发送或验证过于频繁，请稍后重试");
  if (!response.ok || body.error) {
    if (path === "verification/verify" && response.status < 500)
      fail(401, "验证码无效或已过期");
    if (path === "captcha/data/verify" && response.status < 500)
      fail(400, "图片验证码错误或已过期，请换一张");
    fail(503, "短信服务暂时不可用，请稍后重试");
  }
  return body;
}
async function requestCaptcha(captcha, openid) {
  const r = await request(
    "captcha/data/verify",
    { token: captcha.token, key: captcha.key },
    openid,
  );
  if (typeof r.captcha_token !== "string" || !r.captcha_token)
    fail(503, "图片验证暂时不可用");
  return r.captcha_token;
}
async function send(phone, openid, token) {
  const r = await request(
    "verification",
    { phone_number: "+86 " + phone, target: "ANY" },
    openid,
    token,
  );
  if (
    typeof r.verification_id !== "string" ||
    !r.verification_id ||
    r.verification_id.length > 4096 ||
    !Number.isFinite(r.expires_in) ||
    r.expires_in <= 0
  )
    fail(503, "短信服务返回无效结果");
  return {
    verificationId: r.verification_id,
    expiresIn: Math.min(r.expires_in, 300),
  };
}
async function verify(id, code, openid) {
  const r = await request(
    "verification/verify",
    { verification_id: id, verification_code: code },
    openid,
  );
  if (typeof r.verification_token !== "string" || !r.verification_token)
    fail(503, "短信验证返回无效结果");
  return true;
}
async function captcha(openid) {
  const r = await request("captcha/data", {}, openid);
  if (
    r.type !== "image" ||
    typeof r.token !== "string" ||
    r.token.length > 4096 ||
    typeof r.data !== "string" ||
    r.data.length > 524288 ||
    !/^data:image\/(gif|png|jpeg);base64,[A-Za-z0-9+/=\s]+$/.test(r.data)
  )
    fail(503, "图片验证暂时不可用");
  return { image: r.data, token: r.token };
}
module.exports = { send, verify, captcha, device, requestCaptcha };
