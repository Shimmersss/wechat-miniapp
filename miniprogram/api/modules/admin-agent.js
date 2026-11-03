/** 代理审核、代理订单与收益转账（员工端，授权角色）；服务端逐接口校验 agent:review / agent:settle */
const { http } = require('../../utils/request');

module.exports = {
  /** → { defaultMarkupMax, lockMinutes, version }；默认加价上限由老板配置（框架文档 十三.1） */
  settings: () => http.get('/admin/agent-settings'),
  /** { defaultMarkupMax, version, reason } */
  updateSettings: (data) => http.put('/admin/agent-settings', data, { loading: true }),
  /** 待审核申请 { status?, keyword?, page } */
  applications: (params) => http.get('/admin/agent-applications', params),
  /** { approve: boolean, markupMax?（固定金额，留空用默认上限）, remark, version } */
  review: (id, data) => http.post(`/admin/agent-applications/${id}/review`, data, { loading: true }),
  /** 代理列表 { status?, keyword?, page } */
  agents: (params) => http.get('/admin/agents', params),
  /** 停用/恢复或调整单个代理上限 { status?, markupMax?, reason, version }；权限变更需二次确认 */
  updateAgent: (id, data) => http.patch(`/admin/agents/${id}`, data, { loading: true }),
  /** 代理订单 { status?: locked|sold|released, agentId?, page }；成交走收银 customerRequestId */
  orders: (params) => http.get('/admin/agent-orders', params),
  /** 收益记录 { status?: pending|settled|reversed, agentId?, page } → 分页 + summary */
  settlements: (params) => http.get('/admin/agent-earnings', params),
  /** 标记已线下转账 { ids:[...], reason }：需二次确认，逐条写审计 */
  settle: (data) => http.post('/admin/agent-earnings/settle', data, { loading: true })
};
