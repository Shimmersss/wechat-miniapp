/**
 * 代理端（框架文档 七、十三.1/.7）：加价归代理、固定金额上限、按单记账线下转账，只做一级邀请。
 * 代理只拿到分享价、自己的加价与上限；代理底价、成本不返回。
 */
const { http } = require('../../utils/request');

module.exports = {
  /** 申请成为代理 { name, phone, region, inviteCode?, agreed:true } → 本人代理资料；员工账号不能申请 */
  apply: (data) => http.post('/agent/applications', data, { loading: true }),
  /** → { status: none|pending|active|rejected|disabled, name, phone, region, markupMax?, inviteCode?, inviterName?, reviewRemark? } */
  me: () => http.get('/agent/me'),
  /** → { todayVisitors, todayViews, todayShares, lockedOrders, soldOrders, pendingAmount, settledAmount, markupMax } */
  overview: () => http.get('/agent/overview'),
  /** 可转发库存（门店勾选“允许代理转发”的在库设备）{ keyword?, page } → 分页 [{ id, name, storage, color, grade, cover, retail, markup, markupMax, sharePrice, aboveRetail }] */
  units: (params) => http.get('/agent/units', params),
  /** 设置加价 { markup }（固定金额 0～上限，服务端校验并返回分享价） */
  setMarkup: (unitId, data) => http.put(`/agent/units/${unitId}/markup`, data),
  /** 代理链接下的订单 { status?: locked|sold|released } → 分页；顾客姓名电话已脱敏 */
  orders: (params) => http.get('/agent/orders', params),
  /** 收益记录 { status?: pending|settled|reversed } → 分页 + summary{ pendingAmount, settledAmount }；冲回记录金额为负 */
  commissions: (params) => http.get('/agent/commissions', params),
  /** 邀请码与直属代理（首期一级） → { inviteCode, members:[{ name, status, appliedAt }] } */
  invite: () => http.get('/agent/invite')
};
