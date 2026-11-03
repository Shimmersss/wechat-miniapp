/** 单机库存（框架文档 第五章）：成本等字段由服务端按角色裁剪 */
const { http } = require('../../utils/request');

module.exports = {
  /** { status?, keyword?, imei?, modelId?, ageingOver?, minPrice?, maxPrice?, page?, pageSize? } → { list, total, counts, summary:{ inStock, retailTotal, costTotal? } }；summary 为全库在库（in_stock）汇总，不随筛选变化，costTotal 仅成本可见角色返回；串码仅完整精确匹配 */
  list: (params) => http.get('/units', params),
  detail: (id) => http.get(`/units/${id}`),
  /** 改价 { retail?, wholesale?, agentBase?, reason, priceVersion } → 最新员工单机视图；需改价与库存权限，写审计 */
  updatePrice: (id, data) => http.patch(`/units/${id}/price`, data, { loading: true }),
  /** 分享开关 { showInShop, sharePeer, shareAgent } */
  updateShareFlags: (id, data) => http.patch(`/units/${id}/share-flags`, data),
  /** 批量开关代理转发 { unitIds: string[1..100], shareAgent: boolean } → { updated, shareAgent }；整批事务，开启时须全部为在库可售，逐台写审计 */
  batchShareAgent: (data) => http.patch('/units/share-flags', data, { loading: true }),
  /** 库存流水 */
  ledger: (id, params) => http.get(`/units/${id}/ledger`, params),
  /** 标签数据（打印用） */
  label: (id) => http.get(`/units/${id}/label`),
  /** 复检用入库时模板快照 → { fields, values, hiddenKeys, templateVersion, inspectionVersion }；不返回原始模板/供应商 */
  recheckForm: (id) => http.get(`/units/${id}/recheck-form`),
  /** { result:'pass'|'fail', reason, inspectionVersion, attributes:仅改动字段 } → 最新员工单机视图；型号/串码/货源不可修改 */
  recheck: (id, data) => http.post(`/units/${id}/recheck`, data, { loading: true }),
  /** { requestKey?, scannedImeis:string[], statuses?:string[], modelId? } → { id, expectedCount, scannedCount, matched, missing, extra }；保存审计结果，不改库存 */
  stocktake: (data) => http.post('/stocktakes', data, { loading: true }),
  /** { page?, pageSize? } → 盘点历史分页（范围、时间、操作人、差异数量） */
  stocktakes: (params) => http.get('/stocktakes', params),
  /** id → 原盘点结果与差异设备的当前授权视图，原计数不随库存变化 */
  stocktakeDetail: (id) => http.get(`/stocktakes/${id}`)
};
