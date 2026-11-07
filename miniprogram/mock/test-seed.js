/**
 * 角色测试预置数据：配合 docs/role-tests/ 使用，只在 mock 模式下由「我的 → 开发调试 → 加载测试设备」触发。
 * 设备直接写入；销售、借还、维修、咨询、代理收益等单据全部走 mock 路由生成，保证状态与业务规则一致。
 * 数据在内存里，重新编译即清空，再点一次即可恢复。设备用途见 docs/role-tests/00-预置数据.md。
 */
const clone = value => JSON.parse(JSON.stringify(value));
const IMG = '/assets/images';
const COVERS = [`${IMG}/phone_blue_main.jpg`, `${IMG}/phone_white_main.jpg`, `${IMG}/phone_gold_main.jpg`];

/** 生成校验位正确的 IMEI：35999900 + 六位序号 + 校验位 */
function imeiOf(no) {
  const prefix = '35999900' + String(no).padStart(6, '0');
  let sum = 0;
  [...prefix].forEach((v, i) => { const n = Number(v) * (i % 2 ? 2 : 1); sum += n > 9 ? n - 9 : n; });
  return prefix + ((10 - (sum % 10)) % 10);
}

const MODELS = [
  { id: 'm_mate70', category: 'phone', brand: 'huawei', brandLabel: '华为', series: 'Mate 系列', name: 'Mate 70 Pro', templateId: 't_phone', specs: { storage: ['256G', '512G', '1T'], color: ['黑色', '白色', '绿色'] } },
  { id: 'm_mi15', category: 'phone', brand: 'xiaomi', brandLabel: '小米', series: '数字系列', name: '小米 15 Ultra', templateId: 't_phone', specs: { storage: ['256G', '512G', '1T'], color: ['黑色', '白色'] } },
  { id: 'm_magic7', category: 'phone', brand: 'honor', brandLabel: '荣耀', series: 'Magic 系列', name: '荣耀 Magic7 Pro', templateId: 't_phone', specs: { storage: ['256G', '512G'], color: ['黑色', '蓝色'] } },
  { id: 'm_ipadp', category: 'tablet', brand: 'apple', brandLabel: '苹果', series: 'iPad Pro', name: 'iPad Pro 13 英寸', templateId: 't_tablet', specs: { storage: ['256G', '512G', '1T'], color: ['银色', '黑色'] } },
  { id: 'm_matepad', category: 'tablet', brand: 'huawei', brandLabel: '华为', series: 'MatePad', name: 'MatePad Pro 12.2', templateId: 't_tablet', specs: { storage: ['256G', '512G'], color: ['白色', '黑色'] } },
  { id: 'm_mbp14', category: 'laptop', brand: 'apple', brandLabel: '苹果', series: 'MacBook Pro', name: 'MacBook Pro 14 英寸', templateId: 't_laptop', specs: { storage: ['512G', '1T', '2T'], color: ['银色', '黑色'] } },
  { id: 'm_watch10', category: 'wearable', brand: 'apple', brandLabel: '苹果', series: 'Apple Watch', name: 'Apple Watch Series 10', templateId: 't_wearable', specs: { storage: ['64G'], color: ['黑色', '银色'] } }
];

// [编号, 型号, 容量, 颜色, 成色, 电池, 新旧, 成本, 批发, 代理底价, 零售, 库龄, 开关(S店铺 P同行 A代理), 额外字段]
const UNITS = [
  // A 常规在售：顾客浏览、搜索、筛选，覆盖全部品牌分类与筛选边界
  ['t01', 'm_17pm', '256G', '黑色', '99新', 96, 'used', 7900, 8200, 8250, 8599, 3, 'SPA'],
  ['t02', 'm_17pm', '512G', '银色', '准新', 100, 'used', 9100, 9400, 9450, 9899, 1, 'SPA'],
  ['t03', 'm_17p', '256G', '蓝色', '98新', 93, 'used', 6450, 6900, 6950, 7299, 12, 'SPA'],
  ['t04', 'm_17p', '512G', '橙色', '97新', 90, 'used', 7200, 7600, 7650, 7999, 20, 'SPA'],
  ['t05', 'm_16p', '256G', '金色', '95新', 85, 'used', 5000, 5400, 5450, 5799, 28, 'SPA'],
  ['t06', 'm_16p', '128G', '黑色', '9成新', 80, 'used', 4200, 4500, 4550, 4899, 30, 'SPA'],
  ['t07', 'm_16p', '1T', '白色', '99新', 79, 'used', 6400, 6800, 6850, 7199, 31, 'SPA'],
  ['t08', 'm_mate70', '512G', '黑色', '99新', 97, 'used', 5200, 5600, 5650, 5999, 5, 'SPA'],
  ['t09', 'm_mate70', '256G', '绿色', '准新', 100, 'new', 4700, 5000, 5050, 5399, 2, 'SPA'],
  ['t10', 'm_mi15', '512G', '白色', '98新', 95, 'used', 3900, 4200, 4250, 4499, 9, 'SPA'],
  ['t11', 'm_mi15', '1T', '黑色', '准新', 100, 'new', 5100, 5400, 5450, 5799, 1, 'SPA'],
  ['t12', 'm_magic7', '512G', '蓝色', '97新', 91, 'used', 3300, 3600, 3650, 3899, 15, 'SPA'],
  ['t13', 'm_ipadp', '256G', '银色', '99新', 98, 'used', 6100, 6500, 6550, 6899, 6, 'SPA'],
  ['t14', 'm_matepad', '512G', '白色', '准新', 100, 'new', 3800, 4100, 4150, 4399, 4, 'SPA'],
  ['t15', 'm_mbp14', '512G', '银色', '98新', 94, 'used', 9800, 10500, 10550, 11299, 11, 'SPA'],
  ['t16', 'm_mbp14', '1T', '黑色', '准新', 100, 'new', 12800, 13500, 13550, 14299, 2, 'SPA'],
  ['t17', 'm_watch10', '64G', '黑色', '99新', 97, 'used', 1500, 1750, 1780, 1999, 7, 'SPA'],
  // B 渠道开关组合：验证谁能看到哪台
  ['t18', 'm_17p', '256G', '白色', '97新', 92, 'used', 6200, 6600, 6650, 6999, 10, 'S'],
  ['t19', 'm_17p', '256G', '黑色', '97新', 92, 'used', 6200, 6600, 6650, 6999, 10, 'P'],
  ['t20', 'm_17p', '256G', '银色', '97新', 92, 'used', 6200, 6600, 6650, 6999, 10, 'A'],
  ['t21', 'm_17p', '256G', '金色', '97新', 92, 'used', 6200, 6600, 6650, 6999, 10, ''],
  ['t22', 'm_17p', '512G', '黑色', '97新', 92, 'used', 6900, 7300, 7350, 7699, 10, 'SP'],
  // C 价格边界
  ['t23', 'm_mi15', '256G', '黑色', '98新', 94, 'used', 4800, 5200, 5300, 5399, 8, 'SA'],
  ['t24', 'm_magic7', '256G', '黑色', '95新', 88, 'used', 1234.56, 1500.5, 1550.25, 1699.99, 8, 'SPA'],
  ['t25', 'm_mbp14', '2T', '银色', '准新', 100, 'new', 88000, 92000, 93000, 99999.99, 8, 'SPA'],
  ['t26', 'm_watch10', '64G', '银色', '9成新', 80, 'used', 0.5, 0.8, 0.9, 1, 8, 'SPA'],
  // D 界面边界：长文本、缺图、缺描述、超长库龄
  ['t27', 'm_17pm', '1T', '其他', '99新', 95, 'used', 10200, 10600, 10650, 11199, 6, 'SPA', {
    name: 'iPhone 17 Pro Max 官方认证翻新特别版（超长型号名称显示测试）',
    customerDesc: '外观接近全新，边框、屏幕、后盖均无可见划痕；电池健康 95%，循环次数 86 次；面容、原深感、扬声器、麦克风、闪光灯、NFC、无线充电全部检测正常；配件包含原装盒子、充电线和卡针；支持到店当面验机，七天内非人为问题可退换，九十天店铺质保，长描述换行与截断显示测试。',
    peerDesc: 'L1 靓机，全原无拆修，爱思全绿，配件齐全，长描述换行与截断显示测试，长描述换行与截断显示测试，长描述换行与截断显示测试。',
    internalNote: '长内部备注测试：供应商承诺七天内可退，收货时包装有轻微压痕，已拍照留存，需要在月底对账时核对运费是否由供应商承担。'
  }],
  ['t28', 'm_16p', '512G', '其他', '98新', 91, 'used', 5600, 6000, 6050, 6399, 9, 'SPA', { images: [] }],
  ['t29', 'm_mi15', '256G', '白色', '97新', 89, 'used', 3500, 3800, 3850, 4099, 9, 'SPA', { customerDesc: '', peerDesc: '', internalNote: '' }],
  ['t30', 'm_16p', '256G', '白色', '9成新', 82, 'used', 4300, 4600, 4650, 4999, 120, 'SPA'],
  // E 流程专用：每条用例独占，互不影响
  ['t31', 'm_17p', '256G', '黑色', '98新', 94, 'used', 6400, 6850, 6900, 7249, 6, 'SPA'],
  ['t32', 'm_17p', '256G', '白色', '98新', 94, 'used', 6400, 6850, 6900, 7249, 6, 'SPA'],
  ['t33', 'm_16p', '256G', '黑色', '97新', 90, 'used', 5000, 5400, 5450, 5799, 6, 'SPA'],
  ['t34', 'm_16p', '256G', '白色', '97新', 90, 'used', 5000, 5400, 5450, 5799, 6, 'SPA'],
  ['t35', 'm_mate70', '256G', '黑色', '98新', 95, 'used', 4700, 5000, 5050, 5399, 6, 'SPA'],
  ['t36', 'm_mate70', '256G', '白色', '98新', 95, 'used', 4700, 5000, 5050, 5399, 6, 'SPA'],
  ['t37', 'm_mi15', '256G', '黑色', '98新', 95, 'used', 3500, 3800, 3850, 4099, 6, 'SPA'],
  ['t38', 'm_mi15', '256G', '白色', '98新', 95, 'used', 3500, 3800, 3850, 4099, 6, 'SPA'],
  ['t39', 'm_magic7', '256G', '蓝色', '97新', 92, 'used', 2900, 3200, 3250, 3499, 6, 'SPA'],
  ['t40', 'm_magic7', '256G', '黑色', '97新', 92, 'used', 2900, 3200, 3250, 3499, 6, 'SPA'],
  ['t41', 'm_17pm', '256G', '白色', '98新', 94, 'used', 7800, 8100, 8150, 8499, 6, 'SPA'],
  ['t42', 'm_17pm', '256G', '金色', '98新', 94, 'used', 7800, 8100, 8150, 8499, 6, 'SPA'],
  ['t43', 'm_ipadp', '512G', '银色', '98新', 96, 'used', 6800, 7200, 7250, 7599, 6, 'SPA'],
  ['t44', 'm_ipadp', '512G', '黑色', '98新', 96, 'used', 6800, 7200, 7250, 7599, 6, 'SPA'],
  ['t45', 'm_watch10', '64G', '银色', '98新', 96, 'used', 1400, 1650, 1680, 1899, 6, 'SPA'],
  ['t46', 'm_mbp14', '512G', '黑色', '98新', 96, 'used', 9700, 10400, 10450, 11199, 6, 'SPA'],
  ['t47', 'm_16p', '512G', '白色', '98新', 92, 'used', 5500, 5900, 5950, 6299, 6, 'SPA'],
  ['t48', 'm_16p', '512G', '金色', '98新', 92, 'used', 5500, 5900, 5950, 6299, 6, 'SPA'],
  ['t49', 'm_mate70', '1T', '黑色', '98新', 93, 'used', 6200, 6600, 6650, 6999, 6, 'SPA'],
  ['t50', 'm_mate70', '1T', '白色', '98新', 93, 'used', 6200, 6600, 6650, 6999, 6, 'SPA'],
  // F 由下方单据推进到各业务状态
  ['t51', 'm_17p', '256G', '蓝色', '98新', 93, 'used', 6450, 6900, 6950, 7299, 15, 'SPA'],
  ['t52', 'm_16p', '256G', '金色', '97新', 91, 'used', 5000, 5400, 5450, 5799, 15, 'SPA'],
  ['t53', 'm_mi15', '512G', '黑色', '98新', 94, 'used', 3900, 4200, 4250, 4499, 15, 'SPA'],
  ['t54', 'm_mi15', '512G', '白色', '98新', 94, 'used', 3900, 4200, 4250, 4499, 15, 'SPA'],
  ['t55', 'm_mate70', '512G', '绿色', '98新', 95, 'used', 5200, 5600, 5650, 5999, 15, 'SPA'],
  ['t56', 'm_magic7', '512G', '黑色', '98新', 93, 'used', 3300, 3600, 3650, 3899, 15, 'SPA'],
  ['t57', 'm_17p', '512G', '银色', '98新', 93, 'used', 7100, 7500, 7550, 7899, 15, 'SPA'],
  ['t58', 'm_16p', '512G', '黑色', '98新', 93, 'used', 5500, 5900, 5950, 6299, 15, 'SPA'],
  ['t59', 'm_16p', '1T', '金色', '98新', 93, 'used', 6400, 6800, 6850, 7199, 15, 'SPA'],
  ['t60', 'm_mi15', '1T', '白色', '98新', 92, 'used', 4500, 4800, 4850, 5099, 15, 'SPA'],
  ['t61', 'm_17pm', '512G', '黑色', '98新', 95, 'used', 8800, 9100, 9150, 9599, 15, 'SPA'],
  ['t62', 'm_17pm', '512G', '白色', '98新', 95, 'used', 8800, 9100, 9150, 9599, 15, 'SPA'],
  ['t63', 'm_17pm', '512G', '金色', '98新', 95, 'used', 8800, 9100, 9150, 9599, 15, 'SPA'],
  // G 只用来展示状态，没有对应单据，不要拿去走流程
  ['t64', 'm_16p', '256G', '白色', '95新', 86, 'used', 4900, 5300, 5350, 5699, 9, '', { status: 'recheck' }],
  ['t65', 'm_17p', '256G', '蓝色', '99新', 95, 'used', 6500, 6900, 6950, 7299, 0, '', { status: 'in_transit' }],
  ['t66', 'm_17p', '256G', '黑色', '99新', 95, 'used', 6500, 6900, 6950, 7299, 0, '', { status: 'pending_acceptance' }],
  ['t67', 'm_17p', '512G', '黑色', '99新', 95, 'used', 7100, 7500, 7550, 7899, 0, '', { status: 'accepting' }],
  ['t68', 'm_16p', '128G', '黑色', '9成新', 70, 'used', 3800, 4100, 4150, 4399, 0, '', { status: 'abnormal' }],
  ['t69', 'm_16p', '128G', '白色', '9成新', 75, 'used', 3800, 4100, 4150, 4399, 40, '', { status: 'returned' }],
  ['t70', 'm_mi15', '256G', '白色', '97新', 90, 'used', 3500, 3800, 3850, 4099, 3, '', { status: 'locked' }]
];

const AGENTS = [
  { userId: 'seed_agent_1', status: 'pending', name: '林晓', phone: '13900000101', region: '广东省 深圳市 南山区', inviterId: 'mock_agent', reviewRemark: '', appliedAt: '2026-11-05T02:00:00.000Z', version: 1 },
  { userId: 'seed_agent_2', status: 'pending', name: '周凯', phone: '13900000102', region: '广东省 广州市 天河区', inviterId: null, reviewRemark: '', appliedAt: '2026-11-05T06:00:00.000Z', version: 1 },
  { userId: 'seed_agent_3', status: 'rejected', name: '吴敏', phone: '13900000103', region: '湖南省 长沙市 岳麓区', inviterId: null, reviewRemark: '资料不全，请补充地区信息', appliedAt: '2026-11-03T02:00:00.000Z', version: 2 },
  { userId: 'seed_agent_4', status: 'active', name: '陈晨', phone: '13900000104', region: '浙江省 杭州市 西湖区', inviterId: 'mock_agent', inviteCode: 'SEEDCODE', markupMax: 300, reviewRemark: '审核通过', appliedAt: '2026-11-02T02:00:00.000Z', version: 2 },
  { userId: 'seed_agent_5', status: 'disabled', name: '郑浩', phone: '13900000105', region: '江苏省 南京市 鼓楼区', inviterId: null, inviteCode: 'SEEDSTOP', markupMax: 200, reviewRemark: '已停用', appliedAt: '2026-10-20T02:00:00.000Z', version: 3 }
];

const STAFF = [
  { id: 'st5', userId: 'mock_purchaser', name: '老刘', phone: '13800000005', role: 'purchaser', wechatBound: true, status: 'active', version: 1, createdAt: '2026-10-05T02:00:00.000Z' },
  { id: 'st6', userId: 'mock_warehouse', name: '小赵', phone: '13800000006', role: 'warehouse', wechatBound: true, status: 'active', version: 1, createdAt: '2026-10-06T02:00:00.000Z' },
  { id: 'st7', userId: 'mock_finance', name: '阿梅', phone: '13800000007', role: 'finance', wechatBound: true, status: 'active', version: 1, createdAt: '2026-10-07T02:00:00.000Z' },
  { id: 'st8', userId: null, name: '已离职员工', phone: '13800000008', role: 'sales', wechatBound: false, status: 'disabled', version: 1, createdAt: '2026-09-07T02:00:00.000Z' }
];

function buildUnit(db, row, receipt) {
  const [id, modelId, storage, color, grade, battery, condition, cost, wholesale, agentBase, retail, ageDays, flags, extra = {}] = row;
  const model = db.models.find(m => m.id === modelId);
  const template = clone(db.templates.find(t => t.id === model.templateId));
  const no = Number(id.slice(1)), supplier = no % 2 ? '深圳严选供应链' : '华强北 B 档';
  const attributes = {
    version: '国行', networkLock: '无锁', storage, color, grade, activation: '已激活', idLock: '已退出（无锁）', repairStatus: '无拆修',
    refurbishment: '无需整备', store: '夏目数码总店', system: 'iOS 26.1', allGreen: '爱思全绿', battery, shopWarranty: 90, warrantyLength: '90天', supplier, receipt: [receipt]
  };
  return {
    id, modelId, name: model.name, brand: model.brand, category: model.category, condition, storage, color, grade, battery, version: '国行',
    cost, wholesale, agentBase, retail, imei1: imeiOf(no), imei2: '', status: 'in_stock', ageDays,
    images: [COVERS[no % COVERS.length]], videos: [],
    customerDesc: `${grade}，功能正常，店铺质保 90 天。`, peerDesc: `${grade}，全原无拆修。`, internalNote: `预置设备 ${id}。`,
    supplier, receiptImages: [receipt],
    flags: { showInShop: flags.includes('S'), sharePeer: flags.includes('P'), shareAgent: flags.includes('A') },
    templateSnapshot: template, attributes, ...extra
  };
}

module.exports = function loadTestSeed(db, { callAs, fileAs }) {
  if (db.testSeedLoaded) return { loaded: false, units: db.units.length };
  db.testSeedLoaded = true;
  let sequence = 0;
  const key = () => 'seed_' + ++sequence;
  const photo = role => fileAs(role, `${IMG}/phone_blue_detail.jpg`, 'internal');

  MODELS.forEach(m => { if (!db.models.some(x => x.id === m.id)) db.models.push(clone(m)); });
  db.staff.push(...clone(STAFF));
  db.agentProfiles.push(...clone(AGENTS));
  const receipt = photo('boss');
  UNITS.forEach(row => db.units.push(buildUnit(db, row, receipt)));

  // 销售：零售、批发、一单两台、已退货、差价退款
  const sell = (role, ids, extra = {}) => callAs(role, 'POST', '/sales-orders', { requestKey: key(), payMethod: '微信', paymentConfirmed: true, customer: '王小明', phone: '13811110001', ...extra, items: ids.map(unitId => ({ unitId, priceVersion: 1, channel: extra.channel || 'retail' })) });
  sell('sales', ['t51']);
  sell('boss', ['t52'], { channel: 'wholesale', customer: '同行张店', phone: '13811110002', payMethod: '银行卡' });
  sell('sales', ['t53', 't54'], { customer: '李女士', phone: '13811110003', payMethod: '支付宝' });
  const returned = sell('sales', ['t55'], { customer: '赵先生', phone: '13811110004', payMethod: '现金' });
  callAs('finance', 'POST', `/sales-orders/${returned.id}/refund`, { requestKey: key(), kind: 'return', reason: '顾客七天内退货', items: [{ itemId: returned.items[0].id }] });
  const adjusted = sell('sales', ['t56'], { customer: '孙女士', phone: '13811110005' });
  callAs('finance', 'POST', `/sales-orders/${adjusted.id}/refund`, { requestKey: key(), kind: 'adjustment', reason: '活动差价补偿', items: [{ itemId: adjusted.items[0].id, amount: '100' }] });

  // 借还：已逾期出借、进行中出借（两台）、借入
  const loan = (unitIds, dueAt, counterparty) => callAs('warehouse', 'POST', '/loans', { requestKey: key(), type: 'loan_out', unitIds, counterparty, phone: '13822220001', dueAt, reason: '同行调货，已核对外观', photos: [photo('warehouse')] });
  const today = new Date(Date.now() + 28800000), later = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10), tomorrow = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  loan(['t57'], '2026-10-20', '同行王店长');
  loan(['t58', 't59'], later, '合作门店·城南店');
  callAs('warehouse', 'POST', '/loans', { requestKey: key(), type: 'borrow_in', counterparty: '同行李店长', phone: '13822220002', dueAt: later, reason: '借入展示，已核对外观', photos: [photo('warehouse')], devices: [{ modelId: 'm_16p', imei1: imeiOf(901), condition: '98新', description: '外观良好' }] });

  // 维修配件
  const part = (sku, name, quantity, unitCost) => {
    const created = callAs('boss', 'POST', '/repair-parts', { sku, name });
    if (quantity) callAs('boss', 'POST', `/repair-parts/${created.id}/receive`, { requestKey: key(), version: created.version, reason: '配件采购到货', quantity, unitCost });
    return created;
  };
  part('P-SCREEN-17P', 'iPhone 17 Pro 屏幕总成', 5, '800');
  part('P-BAT-16', 'iPhone 16 系列电池', 10, '120');
  part('P-CAM-17P', 'iPhone 17 Pro 后摄模组', 0);

  // 维修单：看板每一列至少一张；店外机为主，t60 是本店机送修
  const external = (model, identifier, customer, fault, engineerId, expectedAt) => callAs('boss', 'POST', '/repair-orders', { requestKey: key(), kind: 'external', model, identifier, customer, phone: '13833330001', fault, engineerId, expectedAt, photos: [photo('boss')] });
  const act = (order, path, role, data) => callAs(role, 'POST', `/repair-orders/${order.id}/${path}`, { requestKey: key(), version: order.version, reason: '预置维修操作', ...data });
  const inspect = order => {
    let o = act(order, 'transition', 'engineer', { to: 'checking' });
    o = callAs('engineer', 'PUT', `/repair-orders/${o.id}`, { requestKey: key(), version: o.version, reason: '保存检测结果', diagnosis: '检测确认需更换部件' });
    return o;
  };
  const quote = (order, amount) => act(inspect(order), 'quote', 'boss', { amount });
  const confirmed = (order, amount) => {
    let o = act(quote(order, amount), 'transition', 'engineer', { to: 'pending_confirm' });
    o = act(o, 'confirm', 'engineer', { confirmed: true, quoteVersion: o.quoteVersion });
    return act(o, 'transition', 'engineer', { to: 'repairing' });
  };
  external('iPhone 15 Pro', 'SN-SEED-001', '陈先生', '无法开机，进水痕迹待确认', null);
  inspect(external('华为 Mate 60', 'SN-SEED-002', '李女士', '屏幕闪烁', 'mock_engineer'));
  act(quote(external('iPhone 14', 'SN-SEED-003', '同行张店', '无法充电', 'mock_engineer'), '260'), 'transition', 'engineer', { to: 'pending_confirm' });
  confirmed(external('iPhone 13', 'SN-SEED-004', '周先生', '更换电池', 'mock_engineer', '2026-10-30'), '199');
  let pickup = confirmed(external('小米 14', 'SN-SEED-005', '吴女士', '听筒无声', 'mock_engineer'), '150');
  pickup = act(pickup, 'payment', 'finance', { kind: 'receipt', amount: '150', method: '微信', confirmed: true });
  pickup = act(pickup, 'transition', 'engineer', { to: 'pending_pickup', result: '更换听筒后通话正常' });
  let done = confirmed(external('iPad Air', 'SN-SEED-006', '郑先生', '更换外屏', 'mock_engineer'), '300');
  done = act(done, 'payment', 'finance', { kind: 'receipt', amount: '300', method: '现金', confirmed: true });
  done = act(done, 'transition', 'engineer', { to: 'pending_pickup', result: '触控正常' });
  act(done, 'transition', 'engineer', { to: 'completed', pickupName: '郑先生', pickupProof: [photo('engineer')], warrantyDays: 90 });
  act(external('荣耀 Magic6', 'SN-SEED-007', '钱女士', '顾客决定不修', 'mock_engineer'), 'transition', 'boss', { to: 'cancelled' });
  callAs('boss', 'POST', '/repair-orders', { requestKey: key(), kind: 'inventory', unitId: 't60', fault: '扬声器有杂音', engineerId: 'mock_engineer', photos: [photo('boss')] });

  // 咨询、预约、同行意向
  const contact = (role, path, data, header) => callAs(role, 'POST', path, { requestKey: key(), ...data }, header);
  contact('customer', '/shop/consults', { unitId: 't01', content: '这台还能便宜吗？', phone: '13844440001', name: '刘先生' });
  contact('customer', '/shop/consults', { content: '有没有 256G 的 iPhone 16？', phone: '13844440002', name: '何女士' });
  contact('customer', '/shop/appointments', { unitId: 't03', phone: '13844440003', name: '马先生', date: tomorrow, timeSlot: '下午（门店确认）' });
  contact('peer', '/shop/consults', { unitId: 't10', content: '同行拿货，能否再让 50？', phone: '13844440004', name: '同行老黄' });

  // 代理收益：张代理的待转账、已转账、已冲回各一笔
  const agentSale = (unitId, markup) => {
    callAs('agent', 'PUT', `/agent/units/${unitId}/markup`, { markup });
    const share = callAs('agent', 'POST', '/share/links', { unitId, channel: 'agent' });
    const order = contact('customer', '/shop/orders', { unitId, phone: '13844440005', name: '代理顾客', content: '' }, { 'X-Channel': share.shareId });
    return callAs('sales', 'POST', '/sales-orders', { requestKey: key(), payMethod: '微信', paymentConfirmed: true, customer: '代理顾客', phone: '13844440005', customerRequestId: order.id, items: [{ unitId, priceVersion: 1, channel: 'agent' }] });
  };
  agentSale('t61', '300');
  agentSale('t62', '200');
  const reversed = agentSale('t63', '150');
  const settled = db.agentEarnings.find(e => db.salesTransactions.some(o => o.id === e.saleOrderId && o.items[0].unitId === 't62'));
  callAs('finance', 'POST', '/admin/agent-earnings/settle', { ids: [settled.id], reason: '线下转账 1 笔' });
  callAs('finance', 'POST', `/sales-orders/${reversed.id}/refund`, { requestKey: key(), kind: 'return', reason: '顾客退货', items: [{ itemId: reversed.items[0].id }] });

  // 待发货采购单，用于“改采购单”
  callAs('purchaser', 'POST', '/purchase-orders', { supplierId: 'sp1', expectedAt: later, freight: '30', remark: '预置待发货采购单', lines: [{ modelId: 'm_17p', quantity: 2, unitCost: '6400', attributes: {} }] });

  return { loaded: true, units: db.units.length };
};
module.exports.imeiOf = imeiOf;
