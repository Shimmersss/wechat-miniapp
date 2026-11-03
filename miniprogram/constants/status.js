/**
 * 业务状态枚举（框架文档 第四、五、六、七章）。
 * 每个枚举都带 label 与 tone（status-pill 颜色：green/orange/red/blue/gray/gold）。
 */

/** 单机（PhoneUnit）库存状态 */
const UNIT_STATUS = {
  in_transit: { label: '快递在途', tone: 'blue', sellable: false },
  pending_acceptance: { label: '到货待验收', tone: 'orange', sellable: false },
  accepting: { label: '验收中', tone: 'orange', sellable: false },
  abnormal: { label: '验收异常', tone: 'red', sellable: false },
  in_stock: { label: '在库可售', tone: 'green', sellable: true },
  locked: { label: '订单锁定', tone: 'orange', sellable: false },
  sold: { label: '已售', tone: 'gray', sellable: false },
  recheck: { label: '复检待入库', tone: 'orange', sellable: false },
  repairing: { label: '维修中', tone: 'blue', sellable: false },
  loaned_out: { label: '出借中', tone: 'orange', sellable: false },
  borrowed_in: { label: '借入在库', tone: 'gold', sellable: false }, // 可售需单独授权
  returned: { label: '已归还', tone: 'gray', sellable: false }
};

/**
 * 允许的状态流转（UI 用来决定显示哪些操作按钮；服务端必须以同一张表做最终校验）
 * key: 当前状态 -> { 目标状态: 触发单据 }
 */
const UNIT_TRANSITIONS = {
  in_transit: { pending_acceptance: 'shipment_signed' },
  pending_acceptance: { accepting: 'acceptance_start' },
  accepting: { in_stock: 'acceptance_pass', abnormal: 'acceptance_fail' },
  abnormal: { returned: 'return_to_supplier', accepting: 'reinspect' },
  in_stock: { sold: 'sales_order', locked: 'agent_order', repairing: 'repair_order', loaned_out: 'loan_out' },
  locked: { sold: 'order_confirm', in_stock: 'lock_release' },
  sold: { recheck: 'refund' },
  recheck: { in_stock: 'recheck_pass' },
  repairing: { recheck: 'repair_done' },
  loaned_out: { recheck: 'loan_return' },
  borrowed_in: { returned: 'borrow_return', sold: 'sales_order' }
};

const PURCHASE_STATUS = {
  pending_ship: { label: '采购待发货', tone: 'gray' },
  in_transit: { label: '快递在途', tone: 'blue' },
  arrived: { label: '到货待验收', tone: 'orange' },
  accepting: { label: '验收中', tone: 'orange' },
  completed: { label: '验收完成', tone: 'green' },
  exception: { label: '验收异常', tone: 'red' }
};

const CARRIERS = [
  { value: 'SF', label: '顺丰速运' },
  { value: 'JD', label: '京东物流' },
  { value: 'OTHER', label: '其他' }
];

/** 维修看板列（框架文档 6.2） */
const REPAIR_STATUS = {
  pending_check: { label: '待检测', tone: 'gray' },
  checking: { label: '检测中', tone: 'blue' },
  pending_confirm: { label: '待顾客确认', tone: 'orange' },
  repairing: { label: '维修中', tone: 'blue' },
  pending_pickup: { label: '待取机', tone: 'gold' },
  completed: { label: '已完成', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' }
};
const REPAIR_FLOW = Object.keys(REPAIR_STATUS).filter(k=>k!=='cancelled');

const LOAN_TYPE = {
  loan_out: { label: '出借', tone: 'orange' },
  borrow_in: { label: '借入', tone: 'blue' }
};
const LOAN_STATUS = {
  active: { label: '进行中', tone: 'orange' },
  overdue: { label: '已逾期', tone: 'red' },
  returned_recheck: { label: '归还待复检', tone: 'blue' },
  closed: { label: '已完结', tone: 'green' }
};

const SALES_STATUS = {
  paid: { label: '已收款', tone: 'green' },
  refunding: { label: '退款中', tone: 'orange' },
  partially_refunded: { label: '部分退款', tone: 'orange' },
  refunded: { label: '已退款', tone: 'gray' }
};

/** 代理订单（框架文档 7.3）：锁定中 → 门店确认成交 / 取消或到期释放；退货体现在收益冲回 */
const AGENT_ORDER_STATUS = {
  locked: { label: '锁定中', tone: 'orange' },
  sold: { label: '已成交', tone: 'green' },
  released: { label: '已释放', tone: 'gray' }
};

const AGENT_STATUS = {
  pending: { label: '待审核', tone: 'orange' },
  active: { label: '已通过', tone: 'green' },
  rejected: { label: '未通过', tone: 'red' },
  disabled: { label: '已停用', tone: 'gray' }
};

/** 代理收益记账（框架文档 十三.1：按单记账，公司线下转账后由财务标记） */
const SETTLEMENT_STATUS = {
  pending: { label: '待转账', tone: 'orange' },
  settled: { label: '已转账', tone: 'green' },
  reversed: { label: '已冲回', tone: 'red' }
};

/** 访问渠道（分享链接 ch 参数） */
const CHANNEL = {
  natural: { label: '自然访问' },
  customer: { label: '顾客分享' },
  peer: { label: '同行' },
  agent: { label: '代理' }
};

/** 四套价格（框架文档 3.2） */
const PRICE_TYPE = {
  cost: { label: '单台成本价' },
  wholesale: { label: '单台批发价' },
  retail: { label: '单台零售价' },
  agent: { label: '代理分享价' }
};

const DEVICE_CATEGORY = [
  { value: 'phone', label: '手机' },
  { value: 'tablet', label: '平板' },
  { value: 'laptop', label: '笔记本' },
  { value: 'wearable', label: '穿戴设备' }
];

const CONDITION_TYPE = [
  { value: 'used', label: '二手机' },
  { value: 'new', label: '新机' }
];

module.exports = {
  UNIT_STATUS,
  UNIT_TRANSITIONS,
  PURCHASE_STATUS,
  CARRIERS,
  REPAIR_STATUS,
  REPAIR_FLOW,
  LOAN_TYPE,
  LOAN_STATUS,
  SALES_STATUS,
  AGENT_ORDER_STATUS,
  AGENT_STATUS,
  SETTLEMENT_STATUS,
  CHANNEL,
  PRICE_TYPE,
  DEVICE_CATEGORY,
  CONDITION_TYPE
};
