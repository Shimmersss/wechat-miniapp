/**
 * 方案 G 演示页的功能入口。每项都指向现有真实页面，并按权限点过滤；
 * 过滤只决定"显示哪些入口"，目标页面仍由 createPage 自己做权限守卫。
 */
const { PERM } = require('../../constants/roles');
const { ROUTES } = require('../../utils/router');
const { can } = require('../../utils/permission');

const REPAIR = [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH];

const STOCK_QUICK = [
  { text: '入库登记', icon: 'inbound', url: ROUTES.INBOUND, perm: PERM.INBOUND },
  { text: '库存盘点', icon: 'box', url: ROUTES.STOCKTAKE, perm: PERM.STOCKTAKE },
  { text: '分渠道分享', icon: 'share', url: ROUTES.SHARE, perm: PERM.SHARE },
  { text: '快递验收', icon: 'transfer', url: ROUTES.PURCHASE_LIST, perm: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE] },
  { text: '出借借入', icon: 'swap', url: ROUTES.LOANS, perm: PERM.LOAN_MANAGE },
  { text: '经营统计', icon: 'chart', url: ROUTES.STATS, perm: PERM.STATS_VIEW }
];

const BIZ_GROUPS = [
  { key: 'repair', title: '维修业务', items: [
    { text: '维修看板', icon: 'wrench', url: ROUTES.REPAIR_BOARD, perm: REPAIR },
    { text: '维修配件', icon: 'parts', url: ROUTES.REPAIR_PARTS, perm: [PERM.PARTS_MANAGE, ...REPAIR] },
    { text: '维修统计', icon: 'trend', url: ROUTES.STATS, perm: PERM.STATS_VIEW }
  ] },
  { key: 'purchase', title: '采购与入库', items: [
    { text: '采购单', icon: 'cart', url: ROUTES.PURCHASE_LIST, perm: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE] },
    { text: '入库登记', icon: 'inbound', url: ROUTES.INBOUND, perm: PERM.INBOUND },
    { text: '批量入库', icon: 'scan', url: ROUTES.INBOUND_BATCH, perm: PERM.INBOUND },
    { text: '型号模板', icon: 'template', url: ROUTES.TEMPLATES, perm: PERM.TEMPLATE_MANAGE }
  ] },
  { key: 'customer', title: '顾客与代理', items: [
    { text: '顾客跟进', icon: 'headset', url: ROUTES.CUSTOMER_REQUESTS, perm: PERM.CONSULT_MANAGE },
    { text: '代理审核', icon: 'diamond', url: ROUTES.AGENT_REVIEW, perm: PERM.AGENT_REVIEW },
    { text: '代理订单', icon: 'order', url: ROUTES.AGENT_ORDERS_ADMIN, perm: [PERM.AGENT_REVIEW, PERM.SALES_CREATE] },
    { text: '代理收益', icon: 'settle', url: ROUTES.AGENT_SETTLEMENT, perm: PERM.AGENT_SETTLE }
  ] }
];

const MINE_GROUPS = [
  { key: 'shop', title: '店铺管理', items: [
    { text: '员工管理', icon: 'users', url: ROUTES.STAFF, perm: PERM.STAFF_MANAGE },
    { text: '角色权限', icon: 'shield', url: ROUTES.STAFF_ROLES, perm: PERM.STAFF_MANAGE },
    { text: '供应商', icon: 'store', url: ROUTES.SUPPLIERS, perm: PERM.SUPPLIER_VIEW },
    { text: '分享管理', icon: 'share', url: ROUTES.SHARE, perm: PERM.SHARE }
  ] },
  { key: 'finance', title: '财务与数据', items: [
    { text: '经营统计', icon: 'chart', url: ROUTES.STATS, perm: PERM.STATS_VIEW },
    { text: '销售记录', icon: 'ledger', url: ROUTES.SALES_LIST, perm: [PERM.SALES_CREATE, PERM.REFUND] },
    { text: '代理结算', icon: 'settle', url: ROUTES.AGENT_SETTLEMENT, perm: PERM.AGENT_SETTLE },
    { text: '操作日志', icon: 'list', url: ROUTES.AUDIT, perm: PERM.AUDIT_VIEW }
  ] },
  { key: 'stock', title: '库存与设备', items: [
    { text: '库存查询', icon: 'stock', url: ROUTES.INVENTORY, perm: PERM.INVENTORY_VIEW },
    { text: '库存盘点', icon: 'box', url: ROUTES.STOCKTAKE, perm: PERM.STOCKTAKE },
    { text: '出借借入', icon: 'swap', url: ROUTES.LOANS, perm: PERM.LOAN_MANAGE },
    { text: '扫码收银', icon: 'cash', url: ROUTES.POS, perm: PERM.SALES_CREATE }
  ] },
  { key: 'other', title: '其他', items: [
    { text: '原版工作台', icon: 'grid', url: ROUTES.DASHBOARD, perm: PERM.DASHBOARD_VIEW },
    { text: '顾客首页', icon: 'home', url: ROUTES.DEMO_HOME },
    { text: '个人设置', icon: 'settings', url: ROUTES.STAFF_PROFILE }
  ] }
];

const allowed = (user, items) => items.filter(i => !i.perm || can(user, i.perm));
const allowedGroups = (user, groups) => groups
  .map(g => ({ ...g, items: allowed(user, g.items) }))
  .filter(g => g.items.length);

module.exports = { STOCK_QUICK, BIZ_GROUPS, MINE_GROUPS, allowed, allowedGroups };
