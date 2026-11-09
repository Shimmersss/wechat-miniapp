/**
 * 统一请求层。
 * 约定后端响应信封：{ code: 0, data: any, message: string }，code !== 0 视为业务错误。
 * 每个请求自动带上：登录令牌、渠道身份（分享来源）、匿名访客 ID。
 * 价格、成本、库存一律以服务端返回为准，前端提交的金额只作为“意图”，服务端必须重新计算。
 */
const config = require('../config/index');
const channel = require('./channel');
const events = require('./events');

const { storageKeys } = config;

class ApiError extends Error {
  constructor(code, message, data) {
    super(message || '请求失败');
    this.code = code;
    this.data = data;
  }
}

function buildHeaders(extra) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const token = wx.getStorageSync(storageKeys.token);
  if (token) headers.Authorization = `Bearer ${token}`;
  const ch = channel.getHeaderValue();
  if (ch && !Object.prototype.hasOwnProperty.call(extra || {}, 'X-Channel')) headers['X-Channel'] = ch;
  const vid = wx.getStorageSync(storageKeys.visitorId);
  if (vid) headers['X-Visitor-Id'] = vid;
  return headers;
}

function handleError(err, showError) {
  if (err.code === 401) {
    wx.removeStorageSync(storageKeys.token);
    events.emit('auth:expired');
  }
  if (showError) {
    wx.showToast({ title: err.message || '网络异常，请稍后重试', icon: 'none' });
  }
}

/**
 * @param {object} options
 * @param {string} options.url      以 / 开头的相对路径，如 /shop/units
 * @param {string} [options.method] GET | POST | PUT | PATCH | DELETE
 * @param {object} [options.data]
 * @param {boolean} [options.loading]   是否显示 loading
 * @param {boolean} [options.showError] 失败时是否自动 toast，默认 true
 */
function request(options) {
  const { url, method = 'GET', data: rawData = {}, loading = false, showError = true, header } = options;
  const data = method === 'GET' ? clean(rawData) : rawData;
  if (loading) wx.showLoading({ title: '加载中', mask: true });

  const done = (promise) =>
    promise
      .catch((err) => {
        const apiErr = err instanceof ApiError ? err : new ApiError(-1, err && err.errMsg ? '网络异常，请稍后重试' : err.message);
        handleError(apiErr, showError);
        throw apiErr;
      })
      .finally(() => loading && wx.hideLoading());

  if (config.useMock) {
    const mock = require('../mock/index');
    return done(mock.handle({ url, method, data, header: buildHeaders(header) }).then(unwrap));
  }

  if (config.useCloud) {
    return done(callCloud({ url, method, data, headers: buildHeaders(header) }));
  }

  return done(
    new Promise((resolve, reject) => {
      wx.request({
        url: config.baseUrl + url,
        method,
        data,
        timeout: config.timeout,
        header: buildHeaders(header),
        success: (res) => {
          if (res.statusCode >= 400) {
            const message = res.data && res.data.message;
            return reject(new ApiError(res.statusCode, message || `服务异常(${res.statusCode})`));
          }
          try {
            resolve(unwrap(res.data));
          } catch (e) {
            reject(e);
          }
        },
        fail: reject
      });
    })
  );
}

// 已迁移到云开发的接口：路径第一段 → 云函数名。未登记的路径直接报错，不回退旧服务器
const CLOUD_FUNCTIONS = {
  auth: 'auth', shop: 'shop',
  catalog: 'staff-stock', models: 'staff-stock', templates: 'staff-stock',
  suppliers: 'staff-stock', 'purchase-orders': 'staff-stock', shipments: 'staff-stock',
  acceptances: 'staff-stock', inbound: 'staff-stock', pricing: 'staff-stock',
  units: 'staff-stock', stocktakes: 'staff-stock', 'stocktake-sessions': 'staff-stock',
  sales: 'staff-sales', 'sales-orders': 'staff-sales', files: 'files', loans: 'staff-loans', 'repair-orders': 'staff-repair', 'repair-parts': 'staff-repair'
};
let cloudReady = false;

/**
 * 云开发传输层：把 HTTP 式请求转成 wx.cloud.callFunction，返回同样的信封。
 * 身份由平台注入的 OPENID 决定；headers 只携带会话令牌、渠道、访客 ID，云函数不信任其中的角色信息。
 */
function callCloud({ url, method, data, headers }) {
  const [path, query] = url.split('?');
  const name = CLOUD_FUNCTIONS[path.split('/')[1]];
  if (!name) return Promise.reject(new ApiError(501, '该功能尚未迁移到云开发'));
  if (!cloudReady) {
    // 不传 env：使用小程序关联的默认云环境，环境 ID 不写进代码
    wx.cloud.init({ traceUser: false });
    cloudReady = true;
  }
  const params = { ...(query ? parseQuery(query) : {}), ...(data || {}) };
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data: { path, method, data: params, headers },
      success: (res) => {
        try {
          resolve(unwrap(res.result));
        } catch (e) {
          reject(e);
        }
      },
      fail: reject
    });
  });
}

function parseQuery(query) {
  const out = {};
  query.split('&').forEach((pair) => {
    if (!pair) return;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  });
  return out;
}

/** 去掉 undefined / null / 空字符串参数，避免 GET 拼出 status=undefined */
function clean(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const out = {};
  Object.keys(data).forEach((k) => {
    if (data[k] !== undefined && data[k] !== null && data[k] !== '') out[k] = data[k];
  });
  return out;
}

function unwrap(body) {
  if (!body || typeof body !== 'object') throw new ApiError(-1, '响应格式错误');
  if (body.code !== 0) throw new ApiError(body.code, body.message, body.data);
  return body.data;
}

/**
 * 文件上传。scope 区分公开设备照片(public)与内部收货凭证(internal)，服务端按 scope 分桶并控制访问权限。
 * @returns {Promise<{ fileId: string, url: string }>}
 */
function upload({ filePath, scope = 'public', bizType = '' }) {
  if (config.useMock) {
    return Promise.resolve().then(() => require('../mock/index').registerFile({ filePath, scope }));
  }
  if (config.useCloud) {
    return uploadCloud({ filePath, scope, bizType });
  }
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${config.baseUrl}/files`,
      filePath,
      name: 'file',
      formData: { scope, bizType },
      header: buildHeaders(),
      success: (res) => {
        try {
          resolve(unwrap(JSON.parse(res.data)));
        } catch (e) {
          reject(e);
        }
      },
      fail: reject
    });
  });
}

/** 暂存签名只允许写本次对象；正式登记成功后才向页面返回文件。 */
async function uploadCloud({ filePath, scope, bizType }) {
  const fs = wx.getFileSystemManager();
  let bytes = await new Promise((resolve, reject) => fs.readFile({ filePath, success: r => resolve(r.data), fail: reject }));
  if (!bytes || Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]' || !bytes.byteLength || bytes.byteLength > 32 * 1024 * 1024)
    throw new ApiError(413, '文件须为1～32MB');
  const requestKey = 'upload-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const intent = await request({ url: '/files/upload-intent', method: 'POST', data: { scope, size: bytes.byteLength, bizType, requestKey } });
  if (intent.file) return intent.file;
  // signed PUT 不携带员工令牌，更不携带存储密钥。上传失败不会继续登记。
  await new Promise((resolve, reject) => wx.request({
    url: intent.uploadUrl, method: 'PUT', data: bytes,
    header: { 'Content-Type': 'application/octet-stream' }, timeout: 120000,
    success: r => r.statusCode >= 200 && r.statusCode < 300 ? resolve() : reject(new ApiError(r.statusCode, '文件传输失败，请重新上传')),
    fail: reject
  }));
  bytes = null;
  // 分段核验中的响应不是文件成功；只在最终登记完成后返回页面。
  for (let step = 0; step < 130; step++) {
    const result = await request({ url: '/files/' + encodeURIComponent(intent.uploadId) + '/complete', method: 'POST', data: {}, loading: false });
    if (result.fileId) return result;
    if (!result.processing) throw new ApiError(500, '文件核验响应无效');
  }
  throw new ApiError(409, '文件核验未完成，请重试');
}

const http = {
  get: (url, data, opts) => request({ url, method: 'GET', data, ...opts }),
  post: (url, data, opts) => request({ url, method: 'POST', data, ...opts }),
  put: (url, data, opts) => request({ url, method: 'PUT', data, ...opts }),
  patch: (url, data, opts) => request({ url, method: 'PATCH', data, ...opts }),
  del: (url, data, opts) => request({ url, method: 'DELETE', data, ...opts })
};

module.exports = { request, upload, http, ApiError };
