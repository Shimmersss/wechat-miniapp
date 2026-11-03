/** 入库（框架文档 4.3 / 3.3） */
const { http } = require('../../utils/request');

module.exports = {
  /** { imei } → { matched, model?, source?, message }；仅查已核验 TAC 映射，未命中不猜型号，不能推断容量颜色 */
  identifyModel: (data) => http.post('/inbound/identify-model', data),
  /** IMEI 唯一校验 { imei } → { unique, conflictUnitId?, model? } */
  checkImei: (data) => http.post('/inbound/check-imei', data),
  /** 定价建议 { cost, targetProfit? , targetMargin? } → { retail, wholesale, agentBase } */
  suggestPrice: (data) => http.post('/pricing/suggest', data, { showError: false }),
  /** 成本快捷档位（按型号/规格） */
  costPresets: (params) => http.get('/pricing/cost-presets', params),
  /** { modelId, templateVersion, inspectionConfirmed:true, attributes, imei1, imei2?, supplierId?, cost, retail, wholesale, agentBase, flags, publicImages?, receiptImages?, customerDesc?, peerDesc?, internalNote? } → { id }；服务端校验权限、模板版本、必填、IMEI 与价格后保存模板快照 */
  createUnit: (data) => http.post('/inbound/units', data, { loading: true }),
  /** { common: 单台入库公共参数, units: [{ imei1, imei2?, attributes?, cost?, ... }] } → { created, ids }；1～100 台，整批校验成功才写入，失败不产生部分库存 */
  createBatch: (data) => http.post('/inbound/batch', data, { loading: true })
};
