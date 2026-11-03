/** 经营工作台（框架文档 8.1）：服务端按角色裁剪利润类指标 */
const { http } = require('../../utils/request');

module.exports = {
  /** → { sales, inventory, visits, repair?, todos }；维修按当前授权范围返回，超期/待确认/待配件待办不重复计销售 */
  overview: () => http.get('/staff/dashboard')
};
