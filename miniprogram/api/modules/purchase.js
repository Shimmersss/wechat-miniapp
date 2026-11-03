/** 采购、快递与验收（框架文档 第四章） */
const { http } = require('../../utils/request');

module.exports = {
  /** { status?, keyword?（单号/运单）, supplierId?, page?, pageSize? } → { list, total, page, pageSize, summary } */
  list: (params) => http.get('/purchase-orders', params),
  detail: (id) => http.get(`/purchase-orders/${id}`),
  /** { supplierId, expectedAt, freight?, remark?, lines:[{modelId,quantity,unitCost,attributes?:{storage,color,version}}] } → 采购单；总额由服务端计算 */
  create: (data) => http.post('/purchase-orders', data, { loading: true }),
  update: (id, data) => http.put(`/purchase-orders/${id}`, data, { loading: true }),
  /** 绑定运单 { carrier:'SF'|'JD'|'OTHER', trackingNo } → { id } */
  addShipment: (id, data) => http.post(`/purchase-orders/${id}/shipments`, data, { loading: true }),
  /** 实际收货后人工登记签收 { reason, receiptFileId? } → { received, purchaseStatus? }，写审计 */
  receiveShipment: (shipmentId, data) => http.post(`/shipments/${shipmentId}/receive`, data, { loading: true }),
  /** 验收单：带出采购明细与待验收项 */
  acceptanceForm: (id) => http.get(`/purchase-orders/${id}/acceptance`),
  /**
   * 提交验收 { requestKey, declaredCount, partialConfirmed?, partialReason?, items: [{ lineId, modelId, templateVersion, attributes, imei1, imei2?, retail, wholesale, agentBase, condition?, receiptImages, result:'pass'|'fail', remark? }] }
   * 成本/供应商由采购单确定；requestKey 原样重试可返回同一结果。
   * 数量不符、IMEI 重复、型号不符由服务端阻止并返回错误明细
   */
  submitAcceptance: (id, data) => http.post(`/purchase-orders/${id}/acceptance`, data, { loading: true }),
  /** { action:'return'|'dispute'|'reinspect', reason, unit?（复验通过时的单台模板参数与三价） } → { resolved, unitId?, purchaseStatus } */
  resolveAcceptance: (id, data) => http.post(`/acceptances/${id}/resolve`, data, { loading: true })
};
