/**
 * 访问埋点（框架文档 8.1 / 8.2）：UV 用匿名访客 ID 去重，PV 记录页面访问。
 * 只上报页面路径、商品 ID、渠道，不采集不必要的个人信息。
 */
const config = require('../config/index');
const channel = require('./channel');

const QUEUE_LIMIT = 10;
let queue = [];
let eventSequence = 0;
function eventId(){ return "evt_" + Date.now() + "_" + ++eventSequence + "_" + Math.random().toString(36).slice(2); }

function visitorId() {
  const key = config.storageKeys.visitorId;
  let vid = wx.getStorageSync(key);
  if (!vid) {
    vid = `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    wx.setStorageSync(key, vid);
  }
  return vid;
}

/** @param {string} route 页面路径  @param {object} [extra] 如 { unitId } */
function pageView(route, extra) {
  queue.push({ ...extra, sourceShareId: channel.getHeaderValue(), type: 'pv', route, ts: Date.now(), eventId: eventId() });
  if (queue.length >= QUEUE_LIMIT) flush();
}

/** 业务事件：share / consult / poster 等 */
function event(name, extra) {
  queue.push({ ...extra, sourceShareId: channel.getHeaderValue(), type: 'event', name, ts: Date.now(), eventId: eventId() });
  if (queue.length >= QUEUE_LIMIT) flush();
}

function flush() {
  if (!queue.length) return;
  const events = queue;
  queue = [];
  // 延迟 require，避免与 api -> request 形成循环依赖
  const api = require('../api/index');
  const groups = {};
  events.forEach(event => { const key = event.sourceShareId || ''; (groups[key] || (groups[key] = [])).push(event); });
  return Promise.all(Object.keys(groups).map(shareId => {
    const batch = groups[shareId];
    return api.visit.report({ visitorId: visitorId(), events: batch.map(({sourceShareId, ...event}) => event) }, shareId).catch(() => {
      queue = batch.concat(queue).slice(-100);
    });
  }));
}

module.exports = { visitorId, pageView, event, flush };
