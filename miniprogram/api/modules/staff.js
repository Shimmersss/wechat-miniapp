/** 员工、角色权限与字段可见性（框架文档 需求 1/2）；所有改动须填写原因并写审计，服务端校验 staff:manage */
const { http } = require('../../utils/request');

module.exports = {
  /** { status?, roleKey?, keyword?, page } → 分页 [{ id, name, phone, roleKey, roleLabel, status, wechatBound, lastLoginAt, version }] */
  list: (params) => http.get('/staff', params),
  /** { name, phone, roleKey, reason }；员工用该手机号短信登录后绑定微信；非老板不能添加老板 */
  create: (data) => http.post('/staff', data, { loading: true }),
  /** { name?, roleKey?, status?: active|disabled, reason, version }；不能停用/降级自己，至少保留一名在职老板 */
  update: (id, data) => http.patch(`/staff/${id}`, data, { loading: true }),
  /** { reason, version }：解绑微信，原微信会话立即失效 */
  unbind: (id, data) => http.post(`/staff/${id}/unbind`, data, { loading: true }),
  /** → { list:[{ key, label, permissions, visibleFields, editable, staffCount, version }], canEdit } */
  roles: () => http.get('/roles'),
  /** 仅老板：{ permissions, visibleFields, reason, version }；老板角色不可编辑 */
  updateRole: (key, data) => http.put(`/roles/${key}`, data, { loading: true })
};
