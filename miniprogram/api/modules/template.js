/** 型号资料库与字段模板（框架文档 3.1） */
const { http } = require('../../utils/request');
module.exports = {
  /** 员工分类目录 → { list: [{ value, label, templateId }], total, page, pageSize }；每个分类一套入库模板 */
  categories: () => http.get('/catalog/categories'),
  /** { label, copyTemplateId } → { value, label, templateId }；复制基础模板作为新分类的模板；模板管理权限 */
  createCategory: (data) => http.post('/catalog/categories', data),
  /** categoryId, { label } → { value, label, templateId }；标识与模板保持不变 */
  updateCategory: (id, data) => http.put(`/catalog/categories/${id}`, data),
  /** { category, brandLabel, series, name, specs?: { storage?: string[], color?: string[] }, tacs?: string[], tacSource? } → 型号；templateId 为所属分类模板；TAC 必须人工核验 */
  createModel: (data) => http.post('/models', data, { loading: true }),
  /** modelId, { category, brandLabel, series, name, specs?, tacs, tacSource } → 型号；换分类即改用新分类模板，未传 specs 保留原规格 */
  updateModel: (id, data) => http.put(`/models/${id}`, data, { loading: true }),
  /** { category? } → [{ name, series: [{ name, models: [{ id, name, templateId, specs, category, brand, series }] }] }]；入库/模板权限可读 */
  modelTree: (params) => http.get('/models/tree', params),
  /** { category?, page?, pageSize? } → { list, total, page, pageSize }；仅模板管理员 */
  list: (params) => http.get('/templates', params),
  /** modelId → { id, name, category, version, fields, descriptionPresets, modelId, specs }；分类模板当前版本叠加型号容量/颜色选项，入库/采购/验收用 */
  modelForm: (modelId) => http.get(`/models/${modelId}/form`),
  /** templateId → { id, name, category, version, fields }；入库/模板权限可读 */
  detail: (id) => http.get(`/templates/${id}`),
  /** templateId, { page?, pageSize? } → 版本快照分页，最新在前；仅模板管理员 */
  versions: (id, params) => http.get(`/templates/${id}/versions`, params),
  /** templateId, { baseVersion, fields } → 完整新版本；冲突返回 409，已入库快照不变 */
  publishVersion: (id, data) => http.post(`/templates/${id}/versions`, data, { loading: true })
};
