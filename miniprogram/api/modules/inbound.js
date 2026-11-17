/** 入库（框架文档 4.3 / 3.3） */
const { http } = require('../../utils/request');

module.exports = {
  /** { imei } → { matched, model?, source?, candidate?, reference?, message }；优先查店内已核验 TAC，开放库结果作为候选 */
  identifyModel: (data) => http.post('/inbound/identify-model', data),
  /** IMEI 唯一校验 { imei } → { unique, conflictUnitId?, model? } */
  checkImei: (data) => http.post('/inbound/check-imei', data),
  /** 序列号同型号查重 { modelId, serialNo } → { unique, serialNo, conflictUnitId? }；跨型号相同序列号不算重复 */
  checkSerial: (data) => http.post('/inbound/check-serial', data),
  /** 定价建议 { cost, targetProfit? , targetMargin? } → { retail, wholesale, agentBase } */
  suggestPrice: (data) => http.post('/pricing/suggest', data, { showError: false }),
  /** 成本快捷档位（按型号/规格） */
  costPresets: (params) => http.get('/pricing/cost-presets', params),
  /** { modelId, templateVersion, inspectionConfirmed:true, attributes, imei1?, imei2?, serialNo?, noSerialReason?, quantity?, supplierId?, cost, retail, wholesale, agentBase, flags, publicImages?, receiptImages?, customerDesc?, peerDesc?, internalNote? } → { id, created, ids, lotId? }；串码按型号所属分类：手机 IMEI1 必填；非手机填 serialNo 或 noSerialReason，平板可另填 imei1；无串码时可传 quantity（1～100）按数量入库，生成同批 N 件 */
  createUnit: (data) => http.post('/inbound/units', data, { loading: true }),
  /** { common: 单台入库公共参数, units: [{ imei1?, imei2?, serialNo?, noSerialReason?, attributes?, cost?, ... }] } → { created, ids }；1～100 台，整批校验成功才写入，失败不产生部分库存 */
  createBatch: (data) => http.post('/inbound/batch', data, { loading: true })
};
