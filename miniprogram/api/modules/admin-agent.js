/** 代理审核与收益转账（员工端，授权角色） */
const { http } = require('../../utils/request');

module.exports = {
  applications: (params) => http.get('/admin/agent-applications', params),
  /** { approve: boolean, markupMax?（固定金额上限）, remark } */
  review: (id, data) => http.post(`/admin/agent-applications/${id}/review`, data, { loading: true }),
  agents: (params) => http.get('/admin/agents', params),
  settlements: (params) => http.get('/admin/settlements', params),
  /** 标记已线下转账：需二次确认 + 原因，写审计日志 */
  settle: (id, data) => http.post(`/admin/settlements/${id}/settle`, data, { loading: true })
};
