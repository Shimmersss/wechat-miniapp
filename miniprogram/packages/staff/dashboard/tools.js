/**
 * 工作台工具：工具清单、常用工具布局、待办角标。
 * 这里只放纯逻辑，页面负责读写本机存储和渲染；入口是否显示仍以权限点为准。
 */
const { PERM } = require('../../../constants/roles');
const ROUTES = require('../../../constants/routes');

/** 顺序即默认优先级；图标文件为 tools/<key>.svg */
const TOOLS = [
  { key: 'scan', text: '扫码收银', url: ROUTES.POS, perm: PERM.SALES_CREATE },
  { key: 'inventory', text: '库存查询', url: ROUTES.INVENTORY, perm: PERM.INVENTORY_VIEW },
  { key: 'inbound', text: '入库登记', url: ROUTES.INBOUND, perm: PERM.INBOUND },
  { key: 'consult', text: '顾客跟进', url: ROUTES.CUSTOMER_REQUESTS, perm: PERM.CONSULT_MANAGE },
  { key: 'purchase', text: '快递验收', url: ROUTES.PURCHASE_LIST, perm: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE] },
  { key: 'repair', text: '维修开单', url: ROUTES.REPAIR_BOARD, perm: [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH] },
  { key: 'loans', text: '出借借入', url: ROUTES.LOANS, perm: PERM.LOAN_MANAGE },
  { key: 'share', text: '分渠道分享', url: ROUTES.SHARE, perm: PERM.SHARE },
  { key: 'parts', text: '维修配件', url: ROUTES.REPAIR_PARTS, perm: [PERM.PARTS_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH] },
  { key: 'template', text: '型号模板', url: ROUTES.TEMPLATES, perm: PERM.TEMPLATE_MANAGE },
  { key: 'agentReview', text: '代理审核', url: ROUTES.AGENT_REVIEW, perm: PERM.AGENT_REVIEW },
  { key: 'agentOrders', text: '代理订单', url: ROUTES.AGENT_ORDERS_ADMIN, perm: [PERM.AGENT_REVIEW, PERM.SALES_CREATE] },
  { key: 'agentSettle', text: '代理收益', url: ROUTES.AGENT_SETTLEMENT, perm: PERM.AGENT_SETTLE },
  { key: 'staff', text: '员工权限', url: ROUTES.STAFF, perm: PERM.STAFF_MANAGE },
  { key: 'audit', text: '操作日志', url: ROUTES.AUDIT, perm: PERM.AUDIT_VIEW }
];

/** 待办归属的工具：角标显示对应待办之和；库龄预警是提醒不是待办，不计入 */
const TODO_TOOL = {
  customerRequests: 'consult',
  acceptance: 'purchase',
  recheck: 'inventory',
  agentApplications: 'agentReview',
  agentOrders: 'agentOrders',
  agentEarnings: 'agentSettle',
  loanOverdue: 'loans',
  loanRecheck: 'loans',
  repairOverdue: 'repair',
  repairConfirm: 'repair',
  repairParts: 'repair'
};

/** 默认常用区两行：工具不超过 8 个全部放下，否则放 7 个，留一格给“更多” */
const ROW_SIZE = 4;
const DEFAULT_ROWS = 2;

/** @param {(perm: string|string[]) => boolean} allow 当前账号是否有该权限 */
function allowedTools(allow) {
  return TOOLS.filter((t) => allow(t.perm));
}

/**
 * 还原布局。saved 是用户保存的工具 key 顺序；没保存过时用默认布局。
 * 已失去权限或已下线的工具自动剔除，新开通的工具进“更多”，不打乱用户的排序。
 */
function resolveLayout(tools, saved) {
  const byKey = new Map(tools.map((t) => [t.key, t]));
  let keys;
  if (Array.isArray(saved)) {
    keys = [...new Set(saved)].filter((k) => byKey.has(k));
  } else {
    const capacity = ROW_SIZE * DEFAULT_ROWS;
    keys = tools.slice(0, tools.length > capacity ? capacity - 1 : capacity).map((t) => t.key);
  }
  return { pinned: keys.map((k) => byKey.get(k)), more: tools.filter((t) => !keys.includes(t.key)) };
}

/** 把 key 移到 to 位置，返回新数组 */
function moveKey(keys, key, to) {
  const rest = keys.filter((k) => k !== key);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** 拖动中的格子坐标换算成列表位置，超出已有工具时落在最后一格 */
function indexAt(col, row, total) {
  const c = Math.max(0, Math.min(ROW_SIZE - 1, col));
  const r = Math.max(0, row);
  return Math.max(0, Math.min(total - 1, r * ROW_SIZE + c));
}

/** 待办角标：{ 工具 key: 显示文字 } */
function toolBadges(todos) {
  const sums = {};
  (todos || []).forEach((t) => {
    const key = TODO_TOOL[t.key];
    if (key && t.count) sums[key] = (sums[key] || 0) + Number(t.count);
  });
  return Object.fromEntries(Object.entries(sums).map(([k, n]) => [k, n > 99 ? '99+' : String(n)]));
}

/** 只留下有数量的待办，带上所属工具的图标 */
function pendingTodos(todos) {
  return (todos || []).filter((t) => t.count).map((t) => ({ ...t, tool: TODO_TOOL[t.key] || 'inventory' }));
}

function greeting(hour) {
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function dateText(now) {
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  return `${now.getMonth() + 1}月${now.getDate()}日 星期${week}`;
}

module.exports = { TOOLS, ROW_SIZE, allowedTools, resolveLayout, moveKey, indexAt, toolBadges, pendingTodos, greeting, dateText };
