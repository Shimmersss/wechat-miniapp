/** 扫码收银与销售（框架文档 第五章）：收款与扣库存同一事务 */
const { http } = require('../../utils/request');

module.exports = {
  /** 通过 IMEI / 标签码查可售设备 */
  /** 代理订单锁定的设备须带 customerRequestId 才能查到 */
  lookup: (code, customerRequestId) => http.get('/sales/lookup', { code, ...(customerRequestId ? { customerRequestId } : {}) }),
  /** {items:[{unitId,priceVersion,channel?,price?}]} → {total,items}；服务端校验状态、版本及成交改价权限 */
  quote: data => http.post('/sales/quote', data),
  /** 开单 {requestKey,items,payMethod,paymentConfirmed:true,customer?,phone?,remark?,priceReason?,customerRequestId?} → 订单快照；改价需权限和原因 */
  create: (data) => http.post('/sales-orders', data, { loading: true }),
  /** {page,pageSize,status?,sellerId?,keyword?,from?,to?} → 分页销售单 */
  list: (params) => http.get('/sales-orders', params),
  /** 销售单里出现过的销售员 → [{id,name}]，用于列表筛选 */
  sellers: () => http.get('/sales-orders/sellers'),
  /** 销售单详情；agentSources:[{orderId,unitId,agentName,sharePrice,markup?,earnings?:[{kind,amount,status,settledAt}]}]，加价与收益仅代理审核/收益转账权限返回 */
  detail: (id) => http.get(`/sales-orders/${id}`),
  /** 补传收款凭证 {receipts:[{fileId}],reason} → 最新详情；凭证须为本人上传的内部图片，已关联本单的文件重试不重复记录 */
  addReceipts: (id, data) => http.post(`/sales-orders/${id}/receipts`, data, { loading: true }),
  /** 退款 { requestKey, reason, kind: return/adjustment, items:[{itemId,amount?}] }：已售 → 复检待入库 */
  refund: (id, data) => http.post(`/sales-orders/${id}/refund`, data, { loading: true })
};
