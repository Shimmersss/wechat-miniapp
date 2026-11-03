/**
 * 本地 Mock 服务：模拟后端路由与“服务端按身份裁剪字段”的行为。
 * config.useMock = true 时 utils/request.js 会走这里。
 * 新增接口：在 routes 里加 ['METHOD', '/path/:param', handler]，handler 返回 data 或抛 { code, message }。
 * 开发调试角色：wx.setStorageSync('xm_mock_role', 'boss' | 'sales' | 'agent' | ...)，在“我的”页有开发切换入口。
 */
const db = require('./data');
const createCatalogRoutes = require('./catalog');
const createInboundRoutes = require('./inbound');
const createPurchaseRoutes = require('./purchase');
const createInventoryRoutes = require('./inventory');
const createSalesRoutes = require('./sales');
const createAnalyticsRoutes = require('./analytics');
const createReportRoutes = require('./reports');
const createShopShare = require('./shop-share');
const createCustomerRequests=require('./customer-requests');
const createRepair=require('./repair');
const createLoans=require('./loans');
const { ROLE_PERMISSIONS, ROLE_LABELS, SENSITIVE_FIELDS, PERM } = require('../constants/roles');
const { REPAIR_FLOW } = require('../constants/status');

const { isImei } = require('../utils/validate');
const { validateFields, validateValues } = require('../utils/template');
const clone = value => JSON.parse(JSON.stringify(value));
const templateHistory = {};
db.templates.forEach(t => { templateHistory[t.id] = [clone(t)]; });
const DELAY = 200;
const ROLE_KEY = 'xm_mock_role';
const uploadedFiles = new Map();
let fileSequence = 0;
function registerFile({ filePath, scope }) {
  requirePermission(PERM.INBOUND, PERM.ACCEPTANCE, PERM.PURCHASE_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.LOAN_MANAGE);
  if (!['public', 'internal'].includes(scope)) fail(400, '文件范围无效');
  if (scope === 'internal') requirePermission(PERM.INBOUND, PERM.ACCEPTANCE, PERM.PURCHASE_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.LOAN_MANAGE);
  if (scope === 'public') requirePermission(PERM.INBOUND, PERM.ACCEPTANCE, PERM.PURCHASE_MANAGE);
  const file = { fileId: `mock_file_${Date.now()}_${++fileSequence}`, url: filePath, scope, ownerRole: currentRole() };
  uploadedFiles.set(file.fileId, file);
  const { ownerRole, ...view } = file;
  return view;
}

function currentRole() {
  return wx.getStorageSync(ROLE_KEY) || 'customer';
}

function makeUser(role) {
  return {
    id: `mock_${role}`,
    nickname: ROLE_LABELS[role] || '访客',
    role,
    permissions: ROLE_PERMISSIONS[role] || [],
    agentStatus: role === 'agent' ? 'active' : undefined
  };
}

function canSee(field) {
  const roles = SENSITIVE_FIELDS[field];
  return !roles || roles.includes(currentRole());
}

/** 公开商品视图：只保留顾客可见字段，价格按渠道决定 */
function publicUnit(u, {channel = currentRole() === 'peer' ? 'peer' : 'customer', price} = {}) {
  const audience = channel === 'peer' ? 'peer' : 'customer';
  const fields = ((u.templateSnapshot || {}).fields || []);
  const forbidden = new Set([...Object.keys(SENSITIVE_FIELDS),'receipt','imei1','imei2','retail','wholesale','agentBase']);
  const publicFields = fields.filter(f => !forbidden.has(f.key) && f.visibility.includes(audience) && !f.visibility.includes('internal')).map(f => ({key:f.key,label:f.label,type:f.type,value:(u.attributes || {})[f.key]})).filter(f=>f.value!==undefined&&f.value!=='');
  const shown = key => !fields.length || fields.some(f=>f.key===key&&f.visibility.includes(audience)&&!f.visibility.includes('internal'));
  const attribute = key => shown(key) ? ((u.attributes || {})[key] !== undefined ? u.attributes[key] : u[key]) : undefined;
  const battery=attribute('battery');
  const warranty = shown('shopWarranty') && u.attributes ? u.attributes.shopWarranty : undefined;
  return {publicFields,id:u.id,modelId:u.modelId,name:u.name,brand:u.brand,storage:attribute('storage')||'',color:attribute('color')||'',grade:attribute('grade')||'',battery:battery===undefined?undefined:Number(String(battery).replace('%','')),version:attribute('version'),images:u.images||[],videos:u.videos||[],cover:(u.images||[])[0]||'',desc:channel==='peer'?u.peerDesc:u.customerDesc,price:price===undefined?(channel==='peer'?u.wholesale:u.retail):price,priceType:channel==='peer'?'wholesale':'retail',imeiMasked:u.imei1.slice(0,2)+'****'+u.imei1.slice(-4),warrantyDays:warranty!==undefined&&warranty!==''?Number(warranty):null};
}

/** 员工视图：按角色裁剪敏感字段 */
function staffUnit(u) {
  const out = { ...u };
  delete out.templateSnapshot;
  delete out.attributes;
  if (!canSee('supplier')) delete out.receiptImages;
  if (!canSee('cost')) delete out.cost;
  if (!canSee('supplier')) delete out.supplier;
  if (!canSee('internalNote')) delete out.internalNote;
  if (!canSee('wholesalePrice')) delete out.wholesale;
  if (!['boss', 'manager', 'purchaser'].includes(currentRole())) delete out.agentBase;
  out.imeiMasked = `${u.imei1.slice(0, 2)}****${u.imei1.slice(-4)}`;
  if (!canSee('fullImei')) { out.imei1 = out.imeiMasked; delete out.imei2; }
  out.priceVersion = u.priceVersion || 1;
  out.availableActions = u.status === 'recheck' && (ROLE_PERMISSIONS[currentRole()] || []).includes(PERM.ACCEPTANCE) ? ['recheck'] : [];
  out.publicImages = clone(u.publicImages || (u.images || []).map((url, i) => ({fileId: '', url, mediaType: 'image'})));
  out.parameters = ((u.templateSnapshot || {}).fields || []).filter(f => canSee(f.key) && (!f.visibility.includes('internal') || canSee('internalNote')) && f.key !== 'receipt').map(f => ({key:f.key,label:f.label,type:f.type,value:(u.attributes || {})[f.key]})).filter(f => f.value !== undefined);
  return out;
}

function paginate(list, { page = 1, pageSize = 20 } = {}) {
  const start = (page - 1) * pageSize;
  return { list: list.slice(start, start + Number(pageSize)), total: list.length, page: Number(page), pageSize: Number(pageSize) };
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function requirePermission(...permissions) {
  if (!permissions.some(p => (ROLE_PERMISSIONS[currentRole()] || []).includes(p))) fail(403, '无权限执行该操作');
}
function getTemplate(id) {
  return db.templates.find(t => t.id === id) || fail(404, '模板不存在');
}

const inboundRoutes = createInboundRoutes(db, { fail, requirePermission, clone, getTemplate, getOperator: () => ROLE_LABELS[currentRole()] });
function validatePurchaseFiles(input, scope, trustedIds = new Set()) {
  if (!Array.isArray(input) || input.length > 9) fail(400, '图片列表无效');
  return input.map(f => {
    const file = uploadedFiles.get(f.fileId) || fail(400, '文件不存在，请重新上传');
    if (file.scope !== scope) fail(400, '文件范围不符');
    if(scope==='internal' && loanMock.canReadFile(file.fileId)!==undefined)fail(400,'借还附件不能用作入库凭证');
    if (scope === 'internal' && repairMock.canReadFile(file.fileId) !== undefined) fail(400, '维修附件不能用作入库凭证');
    if (scope === 'internal' && file.ownerRole !== currentRole() && !['boss', 'manager', 'purchaser'].includes(currentRole()) && !trustedIds.has(file.fileId)) fail(403, '无权限使用该凭证');
    const { ownerRole, ...view } = file; return view;
  });
}
const shopShare = createShopShare(db, {fail, currentRole, requirePermission, paginate, publicUnit});
const customerRequests=createCustomerRequests(db,{fail,currentRole,requirePermission,paginate,clone,shopShare,publicUnit});
const repairMock=createRepair(db,{fail,currentRole,requirePermission,paginate,clone,uploadedFiles});
const loanMock=createLoans(db,{fail,currentRole,requirePermission,paginate,clone,uploadedFiles});
const routes = [
  ['GET', '/files/:id', (d, h, p) => {
    const file = uploadedFiles.get(p.id) || fail(404, '文件不存在');
    if(file.scope==='internal'){
      const loanLinked=loanMock.canReadFile(file.fileId);if(loanLinked===false)fail(403,'无权限查看借还凭证');
      const linked=loanLinked===true?true:repairMock.canReadFile(file.fileId);
      if(linked===false||(linked===undefined&&(!['boss','manager','purchaser','warehouse','engineer','finance'].includes(currentRole())||(file.ownerRole!==currentRole()&&!['boss','manager','purchaser'].includes(currentRole())))))fail(403,'无权限查看凭证');
    }
    const { ownerRole, ...view } = file;
    return view;
  }],
  ...createCatalogRoutes(db, { fail, requirePermission, clone, templateHistory, getOperator: () => ROLE_LABELS[currentRole()] }),
  // ---------- auth ----------
  ['POST', '/auth/wx-login', () => ({ token: 'mock-token', user: makeUser(currentRole()) })],
  ['POST', '/auth/staff-login', (d) => {
    const role = d.mockRole || 'boss';
    wx.setStorageSync(ROLE_KEY, role);
    return { token: 'mock-staff-token', user: makeUser(role) };
  }],
  ['POST', '/auth/sms-code', () => ({ sent: true })],
  ['GET', '/auth/me', () => makeUser(currentRole())],
  ['POST', '/auth/logout', () => {
    wx.removeStorageSync(ROLE_KEY);
    return true;
  }],

  // ---------- shop ----------
  ...shopShare.routes,
  ['GET', '/shop/categories', () => db.categories.map(c => {
    const brands = clone(c.brands || []);
    db.models.filter(m => m.category === c.value).forEach(m => {
      let b = brands.find(b => b.value === m.brand);
      if (!b) { b = { value: m.brand, label: m.brandLabel, series: [] }; brands.push(b); }
      let series = b.series.find(s => s.label === m.series);
      if (!series) { series = { label: m.series, models: [] }; b.series.push(series); }
      if (!series.models.includes(m.name)) series.models.push(m.name);
    });
    return { value: c.value, label: c.label, brands };
  })],
  ...customerRequests.routes,

  // ---------- agent ----------
  ['POST', '/agent/applications', () => ({ status: 'pending' })],
  ['GET', '/agent/me', () => ({ status: currentRole() === 'agent' ? 'active' : 'none', markupMax: 800, inviteCode: 'XM8K2Q' })],
  ['GET', '/agent/overview', () => db.agentOverview],
  ['GET', '/agent/units', (d) => paginate(
    db.units.filter((u) => u.flags.shareAgent && u.status === 'in_stock').map((u) => ({
      unitId: u.id, name: u.name, spec: `${u.storage} · ${u.color} · ${u.grade}`, cover: u.images[0],
      markup: 200, markupMin: 0, markupMax: 800, sharePrice: u.agentBase + 200
    })), d)],
  ['PUT', '/agent/units/:id/markup', (d, h, p) => {
    const u = db.units.find((x) => x.id === p.id);
    if (!u) fail(404, '商品不可分享');
    if (d.markup < 0 || d.markup > 800) fail(400, '加价超出允许范围');
    return { markup: d.markup, sharePrice: u.agentBase + Number(d.markup) };
  }],
  ['GET', '/agent/orders', (d) => paginate([], d)],
  ['GET', '/agent/commissions', (d) => paginate(db.settlements, d)],
  ['GET', '/agent/invite', () => ({ inviteCode: 'XM8K2Q', members: [] })],

  ...createReportRoutes(db, {fail, requirePermission, currentRole}),
  ...createAnalyticsRoutes(db, {fail, requirePermission, paginate, currentRole, clone, staffUnit, resolveShare: shopShare.resolve, repair:repairMock}),

  // ---------- purchase ----------
  ...createPurchaseRoutes(db, { fail, requirePermission, clone, paginate, currentRole, getTemplate, prepareUnit: inboundRoutes.prepareUnit, commitUnits: inboundRoutes.commitUnits, validateFiles: validatePurchaseFiles }),

  // ---------- inbound ----------
  ['POST', '/inbound/check-imei', (d) => {
    requirePermission(PERM.INBOUND);
    if (!isImei(d.imei)) fail(400, 'IMEI 格式或校验位无效');
    const exist = db.units.find((u) => u.imei1 === d.imei || u.imei2 === d.imei);
    if (db.acceptanceReservations?.[d.imei]) return { unique: false };
    return exist ? { unique: false, conflictUnitId: exist.id } : { unique: true };
  }],
  ['POST', '/pricing/suggest', (d) => {
    const cost = Number(d.cost) || 0;
    const retail = d.targetMargin ? Math.round(cost / (1 - d.targetMargin)) : cost + (Number(d.targetProfit) || 0);
    return { retail, wholesale: retail - 300, agentBase: retail - 300 };
  }],
  ['GET', '/pricing/cost-presets', () => [6200, 6450, 6600]],
  ...inboundRoutes,

  // ---------- templates ----------
  ['GET', '/models/tree', (d) => {
    requirePermission(PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE, PERM.INVENTORY_VIEW);
    const brands = [];
    db.models.filter(m => !d.category || m.category === d.category).forEach(m => {
      let brand = brands.find(b => b.id === m.brand);
      if (!brand) { brand = { name: m.brandLabel || m.brand, id: m.brand, series: [] }; brands.push(brand); }
      let series = brand.series.find(s => s.name === m.series);
      if (!series) { series = { name: m.series, models: [] }; brand.series.push(series); }
      const { tacs, tacSource, ...model } = m;
      series.models.push(clone((ROLE_PERMISSIONS[currentRole()] || []).includes(PERM.TEMPLATE_MANAGE) ? m : model));
    });
    return brands;
  }],
  ['GET', '/templates', (d) => {
    requirePermission(PERM.TEMPLATE_MANAGE);
    return clone(paginate(db.templates.filter(t => !d.category || t.category === d.category), d));
  }],
  ['GET', '/templates/:id/versions', (d, h, p) => {
    requirePermission(PERM.TEMPLATE_MANAGE);
    getTemplate(p.id);
    return clone(paginate(templateHistory[p.id].slice().reverse(), d));
  }],
  ['GET', '/templates/:id', (d, h, p) => {
    requirePermission(PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE);
    return clone(getTemplate(p.id));
  }],
  ['POST', '/templates/:id/versions', (d, h, p) => {
    requirePermission(PERM.TEMPLATE_MANAGE);
    const template = getTemplate(p.id);
    if (d.baseVersion !== template.version) fail(409, '模板已被更新，请刷新后重新编辑');
    const error = validateFields(d.fields);
    if (error) fail(400, error);
    const presets = d.descriptionPresets === undefined ? template.descriptionPresets : d.descriptionPresets;
    if (presets && (typeof presets !== 'object' || ['peer', 'customer'].some(k => !Array.isArray(presets[k]) || presets[k].length > 6 || presets[k].some(v => typeof v !== 'string' || !v.trim() || v.length > 200)))) fail(400, '每类快捷描述最多 6 句，每句 1～200 字');
    const next = { ...template, descriptionPresets: clone(presets || { peer: [], customer: [] }), version: template.version + 1, fields: clone(d.fields), publishedAt: new Date().toISOString(), operator: ROLE_LABELS[currentRole()] };
    db.templates[db.templates.indexOf(template)] = next;
    templateHistory[p.id].push(clone(next));
    db.auditLogs.unshift({ id: `a_${Date.now()}`, time: next.publishedAt, operator: next.operator, action: '发布模板版本', detail: `${next.name} v${next.version}` });
    return clone(next);
  }],

  ...createInventoryRoutes(db, {fail, requirePermission, clone, paginate, currentRole, staffUnit, validateFiles: validatePurchaseFiles}),

  ...createSalesRoutes(db, {fail, requirePermission, paginate, clone, currentRole, staffUnit, customerRequests}),


  ...repairMock.routes,

  ...loanMock.routes,

  // ---------- admin agent ----------
  ['GET', '/admin/agent-applications', (d) => paginate(db.agentApplications, d)],
  ['POST', '/admin/agent-applications/:id/review', () => true],
  ['GET', '/admin/agents', (d) => paginate([], d)],
  ['GET', '/admin/settlements', (d) => paginate(db.settlements, d)],
  ['POST', '/admin/settlements/:id/settle', () => ({ status: 'settled' })],

  // ---------- staff / audit ----------
  ['GET', '/staff', (d) => paginate(db.staff, d)],
  ['POST', '/staff', () => ({ id: `st_${Date.now()}` })],
  ['PUT', '/staff/:id', () => true],
  ['GET', '/roles', (d) => paginate(Object.keys(ROLE_PERMISSIONS).map((k) => ({ id: k, name: ROLE_LABELS[k], permissions: ROLE_PERMISSIONS[k] })), d)],
  ['PUT', '/roles/:id', () => true],
  ['GET', '/audit-logs', (d) => paginate(db.auditLogs, d)]
];

const compiled = routes.map(([method, pattern, handler]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (m, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return { method, re, keys, handler };
});

function handle({ url, method, data, header }) {
  const path = url.split('?')[0];
  return new Promise((resolve) => {
    setTimeout(() => {
      const route = compiled.find((r) => r.method === method && r.re.test(path));
      if (!route) {
        console.warn(`[mock] 未实现: ${method} ${path}`);
        resolve({ code: 0, data: null, message: 'mock 未实现' });
        return;
      }
      const match = path.match(route.re);
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });
      try {
        resolve({ code: 0, data: route.handler(data || {}, header || {}, params), message: 'ok' });
      } catch (e) {
        resolve({ code: e.code || 500, data: null, message: e.message });
      }
    }, DELAY);
  });
}

module.exports = { handle, ROLE_KEY, registerFile };
