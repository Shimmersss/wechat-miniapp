const { fail } = require("./gateway");
// Provider boundary: no AppSecret/access_token is returned in API data or logs.
// Contract: https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/qrcode-link/qr-code/getUnlimitedQRCode.html
function wechatCode(config, { fetchImpl = fetch } = {}) {
  let cached = null,
    pending = null;
  const configured = () => !!config.wx.appId && !!config.wx.secret;
  async function bytes(response, max) {
    if (!response.ok) fail(503, "微信小程序码服务暂不可用");
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) fail(503, "微信小程序码响应无效");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
  async function token(force = false) {
    if (!force && cached && cached.until > Date.now()) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(
        "https://api.weixin.qq.com/cgi-bin/stable_token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "client_credential",
            appid: config.wx.appId,
            secret: config.wx.secret,
            force_refresh: force,
          }),
          signal: AbortSignal.timeout(8000),
        },
      );
      const data = JSON.parse((await bytes(response, 65536)).toString());
      if (
        data.errcode ||
        typeof data.access_token !== "string" ||
        !data.access_token ||
        !Number.isFinite(Number(data.expires_in)) ||
        Number(data.expires_in) <= 120
      )
        fail(503, "微信小程序码凭据暂不可用");
      cached = {
        value: data.access_token,
        until: Date.now() + (Number(data.expires_in) - 120) * 1000,
      };
      return cached.value;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }
  return {
    configured,
    async generate({ shareId, page }) {
      if (!configured()) fail(503, "小程序码服务尚未配置");
      if (
        !/^[A-Za-z0-9_-]{16}$/.test(shareId) ||
        ![
          "packages/shop/product/index",
          "packages/shop/collection/index",
        ].includes(page)
      )
        fail(400, "小程序码参数无效");
      if (!["release", "trial", "develop"].includes(config.wx.envVersion))
        fail(503, "小程序码版本配置无效");
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const access = await token(attempt === 1);
          const response = await fetchImpl(
            "https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=" +
              encodeURIComponent(access),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                scene: "s=" + shareId,
                page,
                env_version: config.wx.envVersion,
                check_path: config.wx.checkPath,
                width: 430,
              }),
              signal: AbortSignal.timeout(10000),
            },
          );
          const data = await bytes(response, 2 * 1024 * 1024);
          const png = data
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
            jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
          if (png || jpeg)
            return {
              mime: png ? "image/png" : "image/jpeg",
              base64: data.toString("base64"),
            };
          let error;
          try {
            error = JSON.parse(data.toString());
          } catch {
            fail(503, "微信小程序码响应无效");
          }
          if (attempt === 0 && [40001, 40014, 42001].includes(error.errcode)) {
            cached = null;
            continue;
          }
          fail(503, "小程序码生成失败，请核对微信平台配置");
        }
      } catch (error) {
        if (error.statusCode) throw error;
        fail(503, "微信小程序码服务暂不可用");
      }
    },
  };
}
module.exports = { wechatCode };
