/**
 * API 聚合入口：页面统一 `const api = require('/api/index')` 后按域调用，如 api.shop.units()
 * 新增接口时在 modules/ 下对应文件添加，并在 mock/index.js 补充 mock 实现。
 */
module.exports = {
  file: require('./modules/file'),
  auth: require('./modules/auth'),
  shop: require('./modules/shop'),
  customerRequest: require('./modules/customer-request'),
  share: require('./modules/share'),
  agent: require('./modules/agent'),
  visit: require('./modules/visit'),
  dashboard: require('./modules/dashboard'),
  purchase: require('./modules/purchase'),
  supplier: require('./modules/supplier'),
  inbound: require('./modules/inbound'),
  template: require('./modules/template'),
  inventory: require('./modules/inventory'),
  sales: require('./modules/sales'),
  repair: require('./modules/repair'),
  loan: require('./modules/loan'),
  adminAgent: require('./modules/admin-agent'),
  stats: require('./modules/stats'),
  staff: require('./modules/staff'),
  audit: require('./modules/audit')
};
