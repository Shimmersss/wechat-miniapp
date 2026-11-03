/** 扫码收银与销售（框架文档 第五章）：收款与扣库存同一事务 */
const { http } = require('../../utils/request');

module.exports = {
  /** 通过 IMEI / 标签码查可售设备 */
  lookup: (code) => http.get('/sales/lookup', { code }),
  /** {items:[{unitId,priceVersion,channel?,price?}]} → {total,items}；服务端校验状态、版本及成交改价权限 */
  quote: data => http.post('/sales/quote', data),
  /** 开单 {requestKey,items,payMethod,paymentConfirmed:true,customer?,phone?,remark?,priceReason?,customerRequestId?} → 订单快照；改价需权限和原因 */
  create: (data) => http.post('/sales-orders', data, { loading: true }),
  list: (params) => http.get('/sales-orders', params),
  detail: (id) => http.get(`/sales-orders/${id}`),
  /** 退款 { requestKey, reason, kind: return/adjustment, items:[{itemId,amount?}] }：已售 → 复检待入库 */
  refund: (id, data) => http.post(`/sales-orders/${id}/refund`, data, { loading: true })
};
