/** Mock 数据：取自高保真原型 V0.3 的示例数据，仅用于开发联调前的页面渲染 */
const { fields: inboundFields } = require('./fields');
const IMG = '/assets/images';

const units = [
  {
    id: 'u1', name: 'iPhone 17 Pro', brand: 'apple', category: 'phone', condition: 'used',
    storage: '256G', color: '冰川蓝', grade: '99新', battery: '96%', version: '国行',
    retail: 7299, wholesale: 6999, agentBase: 7000, cost: 6450,
    imei1: '356789124501231', status: 'in_stock', ageDays: 3,
    images: [`${IMG}/phone_blue_main.jpg`, `${IMG}/phone_blue_detail.jpg`],
    customerDesc: '99 新，功能正常，店铺质保 90 天。', peerDesc: 'L1 靓机，电池 96%，全原无拆修。',
    internalNote: '供应商 A，已核验收货凭证。', supplier: '深圳严选供应链',
    flags: { showInShop: true, sharePeer: true, shareAgent: true }
  },
  {
    id: 'u2', name: 'iPhone Air', brand: 'apple', category: 'phone', condition: 'used',
    storage: '128G', color: '云白色', grade: '准新', battery: '100%', version: '国行',
    retail: 5399, wholesale: 5150, agentBase: 5150, cost: 4800,
    imei1: '356789124502231', status: 'in_stock', ageDays: 8,
    images: [`${IMG}/phone_white_main.jpg`],
    customerDesc: '准新机，电池 100%，店铺质保 90 天。', peerDesc: '准新，无拆无修。',
    internalNote: '', supplier: '华强北 B 档',
    flags: { showInShop: true, sharePeer: true, shareAgent: false }
  },
  {
    id: 'u3', name: 'iPhone 16 Pro', brand: 'apple', category: 'phone', condition: 'used',
    storage: '512G', color: '原色', grade: '95新', battery: '92%', version: '国行',
    retail: 6199, wholesale: 5900, agentBase: 5900, cost: 5400,
    imei1: '356789124503231', status: 'in_stock', ageDays: 32,
    images: [`${IMG}/phone_gold_main.jpg`],
    customerDesc: '95 新，轻微使用痕迹，功能正常。', peerDesc: 'L2 小靓，边框轻微划痕。',
    internalNote: '库龄超 30 天，可考虑调价。', supplier: '深圳严选供应链',
    flags: { showInShop: true, sharePeer: true, shareAgent: true }
  }
];

const brands = [
  { value: 'all', label: '全部' },
  { value: 'apple', label: '苹果' },
  { value: 'huawei', label: '华为' },
  { value: 'xiaomi', label: '小米' },
  { value: 'honor', label: '荣耀' }
];

const categories = [
  {
    value: 'phone', label: '手机',
    brands: [
      { value: 'apple', label: '苹果', series: [{ label: 'iPhone 17 系列', models: ['iPhone 17 Pro Max', 'iPhone 17 Pro', 'iPhone Air', 'iPhone 17'] }, { label: 'iPhone 16 系列', models: ['iPhone 16 Pro Max', 'iPhone 16 Pro', 'iPhone 16'] }] },
      { value: 'huawei', label: '华为', series: [{ label: 'Mate 系列', models: ['Mate 70 Pro', 'Mate 70', 'Mate 60 Pro'] }] }
    ]
  },
  { value: 'tablet', label: '平板', brands: [] },
  { value: 'laptop', label: '笔记本', brands: [] },
  { value: 'wearable', label: '穿戴设备', brands: [] }
];

const dashboard = {
  sales: { count: 8, amount: 36580, profit: 4210, margin: 0.115, sellThrough: 0.182 },
  inventory: { inStock: 12, inTransit: 3, pendingAcceptance: 3, repairing: 2, loanedOut: 1, stockCost: 68900 },
  visits: { uv: 286, pv: 1248, productViews: 532, shareVisits: 144, consults: 18, bySource: { natural: 142, customer: 68, peer: 39, agent: 37 } },
  todos: [
    { key: 'acceptance', text: '到货待验收', count: 3, url: '/packages/staff/purchase/list?status=arrived' },
    { key: 'loanDue', text: '出借明日到期', count: 1, url: '/packages/staff/loans/index' },
    { key: 'ageing', text: '库龄超 30 天', count: 2, url: '/packages/staff/inventory/list?ageingOver=30' },
    { key: 'settlement', text: '代理收益待转账', count: 2, url: '/packages/staff/agents/settlement' }
  ]
};

const purchaseOrders = [
  {
    id: 'po1', no: 'PO20261102-003', supplier: '深圳严选供应链', status: 'in_transit', qty: 3, amount: 18650, owner: '老王', expectedAt: '2026-11-02',
    shipment: { id: 'sh1', carrier: 'SF', trackingNo: 'SF144209883721' }
  },
  { id: 'po2', no: 'PO20261101-002', supplier: '华强北 B 档', status: 'arrived', qty: 2, amount: 10300, owner: '老王', expectedAt: '2026-11-01', shipment: { id: 'sh2', carrier: 'JD', trackingNo: 'JD0098812231' } }
];

const repairOrders = [
  { id: 'r1', no: 'RO20261102-001', model: 'iPhone 15 Pro', fault: '更换原装电池', customer: '陈先生', engineer: '小周', quote: 399, status: 'pending_confirm', overdue: false },
  { id: 'r2', no: 'RO20261102-002', model: '华为 Mate 60', fault: '屏幕检测', customer: '李女士', engineer: '小周', quote: null, status: 'checking', overdue: false },
  { id: 'r3', no: 'RO20261031-004', model: 'iPhone 14', fault: '无法充电', customer: '同行张店', engineer: '小吴', quote: 260, status: 'repairing', overdue: true }
];

const loans = [
  { id: 'l1', type: 'loan_out', unitName: 'iPhone 17 Pro', counterparty: '同行王店长', dueAt: '2026-11-03 18:00', status: 'active', operator: '小李' },
  { id: 'l2', type: 'borrow_in', unitName: 'iPhone 16 Pro Max', counterparty: '合作门店', dueAt: '2026-11-06 18:00', status: 'active', operator: '小李' }
];

const salesOrders = [
  { id: 's1', no: 'SO20261102-008', unitName: 'iPhone 17 Pro', amount: 7299, profit: 849, payMethod: '微信', seller: '小李', status: 'paid', createdAt: '2026-11-02 14:32' }
];

const auditLogs = [
  { id: 'a1', time: '14:32', operator: '小李', action: '销售出库', detail: 'SO20261102-008 · iPhone 17 Pro' },
  { id: 'a2', time: '13:18', operator: '老王', action: '修改零售价', detail: '¥7,199 → ¥7,299 · 已记录原因' },
  { id: 'a3', time: '11:06', operator: '小周', action: '推进维修单', detail: '检测中 → 待顾客确认' },
  { id: 'a4', time: '10:24', operator: '老王', action: '验收入库', detail: 'PO20261102-003 · IMEI 校验通过' },
  { id: 'a5', time: '09:02', operator: '老板', action: '导出经营报表', detail: '财务视图 · 已记录设备与 IP' }
];

const templates = [
  {
    id: 't_phone', category: 'phone', name: '手机通用模板', version: 3,
    descriptionPresets: { peer: ['全原无拆修，功能正常', '轻微使用痕迹，详情见实拍'], customer: ['一机一检，功能正常', '实物实拍，欢迎到店体验'] },
    fields: inboundFields()
  }
];

templates.forEach(t => t.fields.forEach(f => { f.filterable = f.type === 'select'; }));
const models = [
  { id: 'm_17pm', category: 'phone', brand: 'apple', brandLabel: '苹果', series: 'iPhone 17 系列', name: 'iPhone 17 Pro Max', templateId: 't_phone' },
  { id: 'm_17p', category: 'phone', brand: 'apple', brandLabel: '苹果', series: 'iPhone 17 系列', name: 'iPhone 17 Pro', templateId: 't_phone' },
  { id: 'm_16p', category: 'phone', brand: 'apple', brandLabel: '苹果', series: 'iPhone 16 系列', name: 'iPhone 16 Pro', templateId: 't_phone' }
];

const staff = [
  { id: 'st1', name: '老板', role: 'boss', wechatBound: true, status: 'active' },
  { id: 'st2', name: '老王', role: 'manager', wechatBound: true, status: 'active' },
  { id: 'st3', name: '小李', role: 'sales', wechatBound: true, status: 'active' },
  { id: 'st4', name: '小周', role: 'engineer', wechatBound: true, status: 'active' }
];

const agentOverview = { todayVisits: 36, shareCount: 12, intentOrders: 3, dealOrders: 2, pendingCommission: 420, settledCommission: 1860 };

const agentApplications = [
  { id: 'ap1', name: '张三', phone: '138****1234', region: '深圳', status: 'pending', appliedAt: '2026-11-02 10:12' }
];

const settlements = [
  { id: 'se1', agentName: '张三', orderNo: 'SO20261101-003', amount: 200, status: 'pending' },
  { id: 'se2', agentName: '张三', orderNo: 'SO20261031-011', amount: 220, status: 'pending' }
];

module.exports = {
  units, brands, categories, dashboard, purchaseOrders, repairOrders, loans, salesOrders,
  auditLogs, templates, models, staff, agentOverview, agentApplications, settlements
};
