const path = require("node:path");
function config(env = process.env) {
  const required = (key) => {
    if (!env[key]) throw new Error(`缺少服务端配置 ${key}`);
    return env[key];
  };
  const secret = (key) => {
    const value = required(key);
    if (value.length < 32) throw new Error(`${key} 至少 32 位`);
    return value;
  };
  return {
    environment: env.NODE_ENV || "development",
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3000),
    database: {
      host: env.DB_HOST || "127.0.0.1",
      port: Number(env.DB_PORT || 3307),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      database: env.DB_NAME || "xiamu",
      timezone: "Z",
      charset: "utf8mb4",
      connectionLimit: 8,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    },
    publicOrigin: env.PUBLIC_ORIGIN || "http://127.0.0.1:3000",
    fileRoot: path.resolve(env.FILE_ROOT || "../.local/files"),
    otpKey: secret("OTP_HASH_KEY"),
    fileKey: secret("FILE_SIGNING_KEY"),
    sessionHours: 12,
    wx: {
      appId: env.WX_APP_ID || "",
      secret: env.WX_APP_SECRET || "",
      envVersion:
        env.WX_CODE_ENV ||
        (env.NODE_ENV === "production" ? "release" : "develop"),
      checkPath:
        env.WX_CODE_CHECK_PATH === undefined
          ? env.NODE_ENV === "production"
          : env.WX_CODE_CHECK_PATH === "true",
    },
    share: { hours: Number(env.SHARE_HOURS || 72) },
    // TODO(confirm): 代理链接下单后的锁库时长（分钟），框架文档 7.3 只要求“锁定有时效”。
    agent: { lockMinutes: Number(env.AGENT_LOCK_MINUTES || 30) },
    // TODO(confirm): appointment availability/hours are configurable; every submission requires store confirmation.
    contact: {
      days: Number(env.APPOINTMENT_DAYS || 30),
      slots: env.APPOINTMENT_SLOTS
        ? JSON.parse(env.APPOINTMENT_SLOTS)
        : require("../../miniprogram/constants/customer-requests")
            .DEFAULT_SLOTS,
    },
    // 框架文档 十三.3 已定：首期出借/借入不收押金、逾期费与损坏赔偿。
    loan: { financialPolicy: "none" },
    repair: {
      // TODO(confirm): internal repair cost allocation is configurable.
      internalCostPolicy: env.REPAIR_INTERNAL_COST_POLICY || "capitalize",
      // 框架文档 十三.6 已定：不保存开机密码。
      passwordStorage: false,
    },
    pricing: { wholesaleDiscount: env.WHOLESALE_DISCOUNT || "0" },
    sms: {
      secretId: env.TENCENT_SECRET_ID,
      secretKey: env.TENCENT_SECRET_KEY,
      appId: env.SMS_APP_ID,
      sign: env.SMS_SIGN,
      templateId: env.SMS_TEMPLATE_ID,
      region: env.SMS_REGION || "ap-guangzhou",
    },
  };
}
module.exports = { config };
