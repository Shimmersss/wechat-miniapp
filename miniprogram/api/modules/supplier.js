/** 供应商档案：仅授权角色可见 */
const { http } = require('../../utils/request');

module.exports = {
  /** { keyword?, active?, page?, pageSize? } → { list, total, page, pageSize } */
  list: (params) => http.get('/suppliers', params),
  /** { name, contact?, phone?, settle?, note?, active? } → 供应商档案 */
  create: (data) => http.post('/suppliers', data, { loading: true }),
  update: (id, data) => http.put(`/suppliers/${id}`, data, { loading: true })
};
