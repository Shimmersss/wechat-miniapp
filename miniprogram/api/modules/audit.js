/** 审计日志：只读，追加写入，普通管理员无删除权限 */
const { http } = require('../../utils/request');

module.exports = {
  /** { operatorId, action, objectType, from, to, page } */
  list: (params) => http.get('/audit-logs', params)
};
