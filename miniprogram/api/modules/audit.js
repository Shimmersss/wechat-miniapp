/** 操作日志：只读、追加写入；内容按查看人的字段权限脱敏（服务端校验 audit:view） */
const { http } = require('../../utils/request');

module.exports = {
  /** { actorId?, action?, objectId?, from?, to?(YYYY-MM-DD 北京时间), page } → 分页 [{ id, action, objectId, actorName, actorRole, before, after, reason, ip, requestId, createdAt }] */
  list: (params) => http.get('/audit-logs', params),
  /** → { actions: string[], actors: [{ id, name }] } 供筛选 */
  filters: () => http.get('/audit-logs/filters')
};
