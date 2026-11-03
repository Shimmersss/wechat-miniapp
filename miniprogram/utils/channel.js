/**
 * 渠道身份（框架文档 7.1 / 十一）。
 * 分享链接/小程序码进入时携带：
 *   s  = shareId（服务端生成的分享记录 ID，绑定渠道、分享人、价格版本、有效期）
 *   ch = customer | peer | agent（仅用于前端展示提示，价格以服务端根据 shareId 计算为准）
 * 小程序码 scene 只有 32 字符，统一编码为 "s=<shareId>"。
 */
const config = require('../config/index');

const KEY = config.storageKeys.channel;

function parseScene(scene) {
  const out = {};
  let decoded;
  try { decoded = decodeURIComponent(scene || ''); } catch (_) { return out; }
  decoded
    .split('&')
    .forEach((pair) => {
      const [k, v] = pair.split('=');
      if (k) out[k] = v;
    });
  return out;
}

function captureFromLaunch(options) {
  if (!options) return;
  const query = { ...(options.query || {}) };
  if (query.scene) Object.assign(query, parseScene(query.scene));
  if (!/^[A-Za-z0-9_-]{16}$/.test(query.s || '')) return;
  wx.setStorageSync(KEY, {
    shareId: query.s,
    channel: query.ch || '',
    scene: options.scene, // 微信场景值，用于来源统计
    capturedAt: Date.now()
  });
}

function get() {
  return wx.getStorageSync(KEY) || null;
}

function getHeaderValue() {
  const c = get();
  return c && c.shareId ? c.shareId : '';
}

function clear() {
  wx.removeStorageSync(KEY);
}

module.exports = { captureFromLaunch, get, getHeaderValue, clear, parseScene };
