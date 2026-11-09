/**
 * 云函数通用骨架：路由、响应信封、身份与 PG 网关调用。
 * 源文件在 cloudfunctions/common/，部署前由 scripts/sync-cloudfunctions.js 复制到各函数的 shared/。
 *
 * 小程序 → wx.cloud.callFunction({ name, data: { path, method, data, headers } })
 * 返回与旧 HTTP 后端相同的信封 { code: 0, data, message }，code 为 HTTP 状态码语义。
 */
const crypto = require("node:crypto");
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) =>
  crypto.createHmac("sha256", key).update(value).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

function text(value, label, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `${label}格式无效`);
  return value.trim();
}

function secret(name) {
  const value = process.env[name];
  if (!value) fail(503, `云函数缺少配置 ${name}`);
  return value;
}

// 数据库函数里 RAISE 的自定义错误码 P0xxx → HTTP 状态
const PG_STATUS = { P0400: 400, P0401: 401, P0403: 403, P0404: 404, P0409: 409, P0410: 410, P0503: 503, P0429: 429 };

/** 调用 PG 存储过程（PostgREST RPC）。API Key 映射 service_role，只在云函数环境变量里。 */
async function rpc(name, params) {
  const envId = process.env.TCB_ENV || process.env.SCF_NAMESPACE;
  if (!envId) fail(503, "无法识别云开发环境");
  const started = Date.now();
  const res = await fetch(
    `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/${name}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret("CLOUDBASE_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    },
  );
  const body = await res.text();
  console.log(`[rpc] ${name} ${res.status} ${Date.now() - started}ms`);
  const parsed = body ? JSON.parse(body) : null;
  if (!res.ok) {
    // 网关把数据库错误码包成 DATABASE_<SQLSTATE>
    const status = PG_STATUS[String(parsed?.code || "").replace(/^DATABASE_/, "")];
    if (status) fail(status, parsed.message);
    console.error(`[rpc] ${name} failed`, parsed?.code, parsed?.message);
    fail(500, "数据服务异常");
  }
  return parsed;
}

/** 解析 Authorization 头里的会话令牌，返回令牌哈希或空串 */
function tokenHash(headers) {
  const auth = headers?.Authorization || headers?.authorization || "";
  const match = /^Bearer (.{20,200})$/.exec(auth);
  return match ? hash(match[1]) : "";
}

/**
 * @param {Array<[method, path, handler]>} routes handler(ctx) 返回 data
 * ctx: { openid, data, headers, requestId }
 */
function createHandler(routes) {
  return async (event, context) => {
    const started = Date.now();
    const { OPENID } = cloud.getWXContext();
    const method = String(event?.method || "GET").toUpperCase();
    const path = String(event?.path || "");
    let params = {};
    const route = routes.find(([m, pattern]) => {
      if (m !== method) return false;
      const parts = pattern.split('/');
      const values = path.split('/');
      if (parts.length !== values.length) return false;
      const matched = {};
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith(':')) {
          if (!values[i]) return false;
          matched[parts[i].slice(1)] = values[i];
        } else if (parts[i] !== values[i]) return false;
      }
      params = matched;
      return true;
    });
    try {
      if (!route) fail(404, `接口尚未迁移到云开发：${method} ${path}`);
      const data = await route[2]({
        openid: OPENID || "",
        params,
        data: event.data || {},
        headers: event.headers || {},
        requestId: context?.request_id || "",
      });
      return { code: 0, data: data === undefined ? null : data, message: "ok" };
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      if (status >= 500) console.error(`[api] ${method} ${path}`, e);
      return {
        code: status,
        data: null,
        message: status >= 500 && !(e instanceof HttpError) ? "服务异常" : e.message,
      };
    } finally {
      console.log(`[api] ${method} ${path} ${Date.now() - started}ms`);
    }
  };
}

module.exports = {
  HttpError,
  fail,
  hash,
  hmac,
  newToken,
  text,
  secret,
  rpc,
  tokenHash,
  createHandler,
};
