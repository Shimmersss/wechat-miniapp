const { fail, secret, text } = require("./gateway");

async function exchangeWechatCode(value) {
  const code = text(value, "微信登录凭证", 128);
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.search = new URLSearchParams({
    appid: secret("WX_APP_ID"),
    secret: secret("WX_APP_SECRET"),
    js_code: code,
    grant_type: "authorization_code",
  });
  let data;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (response.ok) data = await response.json();
  } catch {
    fail(503, "微信登录服务暂不可用");
  }
  if (!data || [40125, 45011, -1].includes(data.errcode))
    fail(503, "微信登录服务暂不可用");
  if (data.errcode || typeof data.openid !== "string" || !data.openid)
    fail(401, "微信登录凭证无效，请重试");
  return data.openid;
}

module.exports = { exchangeWechatCode };
