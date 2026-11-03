/** 经营统计与对账（框架文档 8.2 统一口径） */
const { http } = require('../../utils/request');

module.exports = {
  /** { range: 'day'|'week'|'month', from, to } */
  overview: (params) => http.get('/stats/overview', params),
  /** 按型号 / 员工 / 门店维度 { dimension, range } */
  breakdown: (params) => http.get('/stats/breakdown', params),
  /** {range?,from?,to?} → 北京时间按日补零的销售净额/退款/利润趋势 */
  trend: params => http.get('/stats/trend', params),
  /** {range?,from?,to?} → 按日UV/PV补零趋势，服务器接收时间为准 */
  visitTrend: params => http.get('/stats/visit-trend', params),
  visits: (params) => http.get('/stats/visits', params),
  ageing: (params) => http.get('/stats/ageing', params),
  /** {requestKey,range?/from?/to?,reason} → {id,filename,expiresAt,rows}；生成15分钟内可取的固定快照，需导出权限和原因 */
  exportReport: (data) => http.post('/stats/export', data, { loading: true }),
  /** id → {id,filename,expiresAt,rows,csv}；仅创建人且当前仍有权限可取，权限变化会裁剪成本/毛利列 */
  exportContent: id => http.get('/stats/exports/'+id)
};
