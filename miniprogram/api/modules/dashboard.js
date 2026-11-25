/** 经营工作台（框架文档 8.1）：服务端按角色裁剪利润类指标 */
const { http } = require('../../utils/request');
const { getCachedUser } = require('../../utils/auth');
const events = require('../../utils/events');

const CACHE_MS = 15000;
let snapshot;
let sessionRevision = 0;

events.on('auth:changed', () => {
  sessionRevision++;
  snapshot = undefined;
});
events.on('business:changed', () => { snapshot = undefined; });

module.exports = {
  /** → { sales, inventory, visits, repair?, todos }；维修按当前授权范围返回，超期/待确认/待配件待办不重复计销售 */
  overview({ refresh = false } = {}) {
    const userId = getCachedUser()?.id;
    if (!userId) return http.get('/staff/dashboard');
    if (snapshot?.userId === userId) {
      if (snapshot.pending) return snapshot.pending;
      if (!refresh && Date.now() < snapshot.expires) return Promise.resolve(snapshot.data);
    }

    const entry = { userId };
    const revision = sessionRevision;
    snapshot = entry;
    entry.pending = http.get('/staff/dashboard').then((data) => {
      if (sessionRevision !== revision || getCachedUser()?.id !== userId) {
        throw new Error('登录状态已更新，请重试');
      }
      entry.data = data;
      entry.expires = Date.now() + CACHE_MS;
      return data;
    }).catch((error) => {
      if (snapshot === entry) snapshot = undefined;
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }
};
