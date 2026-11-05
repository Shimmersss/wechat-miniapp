/** 单机库存（框架文档 第五章）：成本等字段由服务端按角色裁剪 */
const { http } = require('../../utils/request');

module.exports = {
  /** { status?, keyword?, imei?, modelId?, ageingOver?, minPrice?, maxPrice?, page?, pageSize? } → { list, total, counts, summary:{ inStock, retailTotal, costTotal? } }；summary 为全库在库（in_stock）汇总，不随筛选变化，costTotal 仅成本可见角色返回；串码仅完整精确匹配 */
  list: (params) => http.get('/units', params),
  /** 单台档案；有借还权限且设备在未完结借还单中时带 loan{id,no,type} */
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
  /** { status?: 'open'|'closed'|'cancelled', page?, pageSize? } → 盘点单分页（范围、开单人、应盘/已盘/异常数），默认进行中 */
  stocktakeSessions: (params) => http.get('/stocktake-sessions', params),
  /** { requestKey, statuses?, modelId? | category?, note? } → 盘点单；开单时按范围快照应盘清单，只能选店内状态 */
  startStocktake: (data) => http.post('/stocktake-sessions', data, { loading: true }),
  /** sessionId → { id, status, scope, note, operator, createdAt, expectedCount, scannedCount, extraCount, stocktakeId } */
  stocktakeSession: (id) => http.get(`/stocktake-sessions/${id}`),
  /** sessionId, { state: 'pending'|'scanned'|'extra', page?, pageSize? } → 待盘/已盘设备（员工单机视图 + scannedAt/scanner）或异常编号 */
  stocktakeUnits: (id, params) => http.get(`/stocktake-sessions/${id}/units`, params),
  /** sessionId, { code } → { result:'matched'|'duplicate'|'out_of_scope'|'unknown', message, code, unit, expectedCount, scannedCount, extraCount }；重复扫码不重复计数 */
  scanStocktake: (id, data) => http.post(`/stocktake-sessions/${id}/scans`, data),
  /** sessionId → 盘点结果详情（同 stocktakeDetail）；重复提交返回同一结果，不改库存 */
  closeStocktake: (id) => http.post(`/stocktake-sessions/${id}/close`, {}, { loading: true }),
  /** sessionId, { reason } → 已作废的盘点单 */
  cancelStocktake: (id, data) => http.post(`/stocktake-sessions/${id}/cancel`, data, { loading: true }),
  /** { page?, pageSize? } → 已结束盘点分页（范围、时间、操作人、缺失/异常/期间变动数、openCount 未处理差异数） */
  stocktakes: (params) => http.get('/stocktakes', params),
  /** id → 盘点结果：missing（带 resolution）、changed（盘点期间离店）、extra（带 key 与 resolution）；原计数不随库存变化 */
  stocktakeDetail: (id) => http.get(`/stocktakes/${id}`),
  /** id, { type:'unit'|'extra', target: unitId|extra.key, resolution: unit→pending/found/lost，extra→pending/handled, note } → 最新盘点结果；只追加处理记录，不改库存 */
  resolveStocktake: (id, data) => http.post(`/stocktakes/${id}/resolutions`, data, { loading: true })
};
