const { http } = require('../../utils/request');

module.exports = {
  /** { visitorId, events:[{eventId,type:'pv'|'event',route?,name?,unitId?,ts?}] } → {accepted,ignored}；eventId重试保持，服务端按接收时间统计并忽略额外字段 */
  report: (data, shareId) => http.post('/visits/batch', data, { showError: false, ...(shareId !== undefined ? {header: {'X-Channel': shareId}} : {}) })
};
