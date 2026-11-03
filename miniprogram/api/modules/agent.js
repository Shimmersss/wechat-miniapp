/**
 * 代理端（框架文档 7.2 / 7.3）
 * 代理只拿到最终分享价与可加价范围；底价仅在加价编辑场景按授权返回。
 */
const { http } = require('../../utils/request');

module.exports = {
  /** 申请成为代理 { phone, name, region, inviteCode? } */
  apply: (data) => http.post('/agent/applications', data, { loading: true }),
  /** 代理本人信息与审核状态 */
  me: () => http.get('/agent/me'),
  /** 代理中心概览：今日访问、分享次数、意向订单、成交、待转账/已转账收益 */
  overview: () => http.get('/agent/overview'),
  /** 可分享库存 { keyword, page } → { list: [{ unitId, name, spec, sharePrice, markup, markupMin, markupMax }] } */
  units: (params) => http.get('/agent/units', params),
  /** 设置加价（只能 >= 0 且 <= 上限，服务端校验）{ markup } */
  setMarkup: (unitId, data) => http.put(`/agent/units/${unitId}/markup`, data),
  orders: (params) => http.get('/agent/orders', params),
  commissions: (params) => http.get('/agent/commissions', params),
  /** 邀请码与邀请海报、直属代理列表（首期一级代理） */
  invite: () => http.get('/agent/invite')
};
