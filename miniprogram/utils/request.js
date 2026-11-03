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

const http = {
  get: (url, data, opts) => request({ url, method: 'GET', data, ...opts }),
  post: (url, data, opts) => request({ url, method: 'POST', data, ...opts }),
  put: (url, data, opts) => request({ url, method: 'PUT', data, ...opts }),
  patch: (url, data, opts) => request({ url, method: 'PATCH', data, ...opts }),
  del: (url, data, opts) => request({ url, method: 'DELETE', data, ...opts })
};

module.exports = { request, upload, http, ApiError };
