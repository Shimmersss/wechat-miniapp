/** 型号资料库与字段模板（框架文档 3.1） */
const { http } = require('../../utils/request');
module.exports = {
  /** 员工分类目录 → { list: [{ value, label, templateId, identifierMode, sortOrder, unitCount }], total, page, pageSize }；按 sortOrder 排序，每个分类一套入库模板 */
  categories: () => http.get('/catalog/categories'),
  /** { category } → [{ brand, brandLabel, count }]；型号多时先选品牌再按品牌加载型号树 */
  modelBrands: (params) => http.get('/models/brands', params),
  /** { category, brand } → string[]；返回该分类与品牌下仍有机型的系列 */
  modelSeries: (params) => http.get('/models/series', params),
  /** { label, copyTemplateId, identifierMode?: 'imei'|'serial'|'serial_imei' } → { value, label, templateId, identifierMode, sortOrder }；复制基础模板作为新分类的模板，未传串码方式时按序列号；模板管理权限 */
  createCategory: (data) => http.post('/catalog/categories', data),
  /** categoryId, { label, identifierMode? } → { value, label, templateId, identifierMode }；标识与模板保持不变，分类下已有设备时不能改串码方式（409） */
  updateCategory: (id, data) => http.put(`/catalog/categories/${id}`, data),
  /** { category, brandId?, brandLabel, series, name, specs?: { storage?: string[], ram?: string[], color?: string[] }, tacs?: string[], tacSource? } → 型号；已有品牌由 brandId 指定；TAC 必须人工核验 */
  createModel: (data) => http.post('/models', data, { loading: true }),
  /** modelId, { category, brandId?, brandLabel, series, name, specs?, tacs, tacSource } → 型号；换分类即改用新分类模板，未传 specs 保留原规格 */
  updateModel: (id, data) => http.put(`/models/${id}`, data, { loading: true }),
  /** modelId → { id, deleted: true }；只允许移除未被业务引用的机型，关联 TAC 同时移除 */
  deleteModel: (id) => http.del(`/models/${id}`, {}, { loading: true }),
  /** { category?, brand?, keyword? } → [{ name, series: [{ name, models: [{ id, name, templateId, specs, category, brand, series }] }] }]；入库/模板权限可读；keyword 按型号名或系列模糊匹配，最多 200 个 */
  modelTree: (params) => http.get('/models/tree', params),
  /** { category?, page?, pageSize? } → { list, total, page, pageSize }；仅模板管理员 */
  list: (params) => http.get('/templates', params),
  /** modelId → { id, name, category, version, fields, descriptionPresets, modelId, specs }；分类模板当前版本叠加型号存储容量、运行内存和颜色选项，入库/采购/验收用 */
  modelForm: (modelId) => http.get(`/models/${modelId}/form`),
  /** templateId → { id, name, category, version, fields }；入库/模板权限可读 */
  detail: (id) => http.get(`/templates/${id}`),
  /** templateId, { page?, pageSize? } → 版本快照分页，最新在前；仅模板管理员 */
  versions: (id, params) => http.get(`/templates/${id}/versions`, params),
  /** templateId, { baseVersion, fields } → 完整新版本；冲突返回 409，已入库快照不变 */
  publishVersion: (id, data) => http.post(`/templates/${id}/versions`, data, { loading: true })
};
