const { fail } = require("./core");
function providers(config) {
  return {
    miniCode: require("./wechat-code").wechatCode(config),
    async wechat(code) {
      if (!config.wx.appId || !config.wx.secret)
        fail(503, "微信登录服务尚未配置");
      let response;
      try {
        const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
        url.search = new URLSearchParams({
          appid: config.wx.appId,
          secret: config.wx.secret,
          js_code: code,
          grant_type: "authorization_code",
        });
        const result = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!result.ok) fail(503, "微信登录服务暂不可用");
        response = await result.json();
      } catch (e) {
        if (e.statusCode) throw e;
        fail(503, "微信登录服务暂不可用");
      }
      if (
        response.errcode ||
        typeof response.openid !== "string" ||
        !response.openid
      )
        fail(401, "微信登录凭证无效，请重试");
      // session_key never leaves this server and is not needed for application bearer sessions.
      return response.openid;
    },
    async sms(phone, code) {
      const sms = config.sms;
      if (
        ![
          sms.secretId,
          sms.secretKey,
          sms.appId,
          sms.sign,
          sms.templateId,
        ].every(Boolean)
      )
        fail(503, "短信服务尚未配置");
      const Client = require("tencentcloud-sdk-nodejs-sms").sms.v20210111
        .Client;
      const client = new Client({
        credential: { secretId: sms.secretId, secretKey: sms.secretKey },
        region: sms.region,
        profile: { httpProfile: { reqTimeout: 10 } },
      });
      let result;
      try {
        result = await client.SendSms({
          SmsSdkAppId: sms.appId,
          SignName: sms.sign,
          TemplateId: sms.templateId,
          PhoneNumberSet: ["+86" + phone],
          TemplateParamSet: [code, "5"],
        });
      } catch {
        fail(503, "短信暂未发送成功，请稍后重试");
      }
      if (result.SendStatusSet?.[0]?.Code !== "Ok")
        fail(503, "短信暂未发送成功，请稍后重试");
    },
  };
}
module.exports = { providers };
