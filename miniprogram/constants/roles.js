/**
 * 角色、权限点与字段可见性（框架文档 第二章）。
 * 前端只用来决定“显示什么入口/按钮”；真正的授权必须由服务端逐接口校验，
 * 服务端也会按角色裁剪返回字段，前端拿不到就不显示，不能只靠前端隐藏。
 */
const ROLES = {
  BOSS: 'boss',
  MANAGER: 'manager',
  PURCHASER: 'purchaser',
  WAREHOUSE: 'warehouse',
  SALES: 'sales',
  ENGINEER: 'engineer',
  FINANCE: 'finance',
  PEER: 'peer',
  AGENT: 'agent',
  CUSTOMER: 'customer'
};

const ROLE_LABELS = {
  boss: '老板',
  manager: '店长',
  purchaser: '采购',
  warehouse: '库管',
  sales: '销售',
  engineer: '维修工程师',
  finance: '财务',
  peer: '同行',
  agent: '代理',
  customer: '顾客'
};

const STAFF_ROLES = ['boss', 'manager', 'purchaser', 'warehouse', 'sales', 'engineer', 'finance'];

/** 权限点：页面入口与按钮统一用这些 key 判断 */
const PERM = {
  DASHBOARD_VIEW: 'dashboard:view',
  PROFIT_VIEW: 'profit:view', // 毛利、毛利率、动销率
  PURCHASE_MANAGE: 'purchase:manage',
  SUPPLIER_VIEW: 'supplier:view',
  ACCEPTANCE: 'acceptance:do',
  INBOUND: 'inbound:do',
  TEMPLATE_MANAGE: 'template:manage',
  INVENTORY_VIEW: 'inventory:view',
  PRICE_EDIT: 'price:edit',
  LABEL_PRINT: 'label:print',
  STOCKTAKE: 'stocktake:do',
  SALES_CREATE: 'sales:create',
  REFUND: 'sales:refund',
  REPAIR_HANDLE: 'repair:handle',
  REPAIR_QUOTE: 'repair:quote',
  REPAIR_ASSIGN: 'repair:assign',
  REPAIR_CASH: 'repair:cash',
  PARTS_MANAGE: 'parts:manage',
  LOAN_MANAGE: 'loan:manage',
  SHARE: 'share:do',
  CONSULT_MANAGE: 'consult:manage',
  AGENT_REVIEW: 'agent:review',
  AGENT_SETTLE: 'agent:settle',
  STATS_VIEW: 'stats:view',
  EXPORT: 'data:export',
  STAFF_MANAGE: 'staff:manage',
  AUDIT_VIEW: 'audit:view'
};

const ALL = Object.values(PERM);

/** 默认角色权限，后台可在“员工与角色”里调整；以服务端下发的 user.permissions 为准 */
const ROLE_PERMISSIONS = {
  boss: ALL,
  manager: ALL.filter((p) => ![PERM.AGENT_SETTLE].includes(p)),
  purchaser: [PERM.DASHBOARD_VIEW, PERM.PURCHASE_MANAGE, PERM.SUPPLIER_VIEW, PERM.ACCEPTANCE, PERM.INBOUND, PERM.INVENTORY_VIEW, PERM.PARTS_MANAGE],
  warehouse: [PERM.DASHBOARD_VIEW, PERM.ACCEPTANCE, PERM.INBOUND, PERM.INVENTORY_VIEW, PERM.LABEL_PRINT, PERM.STOCKTAKE, PERM.LOAN_MANAGE],
  sales: [PERM.DASHBOARD_VIEW, PERM.INVENTORY_VIEW, PERM.SALES_CREATE, PERM.SHARE, PERM.CONSULT_MANAGE],
  engineer: [PERM.DASHBOARD_VIEW, PERM.REPAIR_HANDLE, PERM.INVENTORY_VIEW],
  finance: [PERM.DASHBOARD_VIEW, PERM.PROFIT_VIEW, PERM.INVENTORY_VIEW, PERM.STATS_VIEW, PERM.AGENT_SETTLE, PERM.EXPORT, PERM.REFUND, PERM.REPAIR_CASH],
  peer: [PERM.SHARE],
  agent: [PERM.SHARE],
  customer: []
};

/** 敏感字段：服务端按此裁剪，前端据此显示“无权限查看” */
const SENSITIVE_FIELDS = {
  cost: ['boss', 'purchaser', 'finance'],
  supplier: ['boss', 'manager', 'purchaser'],
  internalNote: ['boss', 'manager', 'purchaser', 'warehouse'],
  fullImei: ['boss', 'manager', 'warehouse', 'purchaser'],
  profit: ['boss', 'finance'],
  wholesalePrice: ['boss', 'manager', 'sales', 'peer']
};

module.exports = { ROLES, ROLE_LABELS, STAFF_ROLES, PERM, ROLE_PERMISSIONS, SENSITIVE_FIELDS };
