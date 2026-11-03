/** 型号资料库与字段模板（框架文档 3.1） */
const { http } = require('../../utils/request');
module.exports = {
  /** 员工分类目录 → { list: [{ value, label }], total, page, pageSize } */
  categories: () => http.get('/catalog/categories'),
  /** { label } → { value, label }；模板管理权限 */
  createCategory: (data) => http.post('/catalog/categories', data),
  /** categoryId, { label } → { value, label }；标识保持不变 */
  updateCategory: (id, data) => http.put(`/catalog/categories/${id}`, data),
  /** { category, brandLabel, series, name, copyTemplateId, tacs?: string[], tacSource? } → 型号及独立 templateId；TAC 必须人工核验 */
  createModel: (data) => http.post('/models', data, { loading: true }),
  /** modelId, { category, brandLabel, series, name, tacs, tacSource } → 型号；模板关联不变 */
  updateModel: (id, data) => http.put(`/models/${id}`, data, { loading: true }),
  /** { category? } → [{ name, series: [{ name, models: [{ id, name, templateId, category, brand, series }] }] }]；入库/模板权限可读 */
  modelTree: (params) => http.get('/models/tree', params),
  /** { category?, page?, pageSize? } → { list, total, page, pageSize }；仅模板管理员 */
  list: (params) => http.get('/templates', params),
  /** templateId → { id, name, category, version, fields }；入库/模板权限可读 */
  detail: (id) => http.get(`/templates/${id}`),
  /** templateId, { page?, pageSize? } → 版本快照分页，最新在前；仅模板管理员 */
  versions: (id, params) => http.get(`/templates/${id}/versions`, params),
  /** templateId, { baseVersion, fields } → 完整新版本；冲突返回 409，已入库快照不变 */
  publishVersion: (id, data) => http.post(`/templates/${id}/versions`, data, { loading: true })
};
