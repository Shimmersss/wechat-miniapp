/** 员工、角色、字段权限（框架文档 需求 1/2） */
const { http } = require('../../utils/request');

module.exports = {
  list: (params) => http.get('/staff', params),
  create: (data) => http.post('/staff', data, { loading: true }),
  update: (id, data) => http.put(`/staff/${id}`, data, { loading: true }),
  roles: () => http.get('/roles'),
  /** 权限变更：二次确认 + 审计 */
  updateRole: (id, data) => http.put(`/roles/${id}`, data, { loading: true })
};
