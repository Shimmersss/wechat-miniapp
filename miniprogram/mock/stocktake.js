const { PERM, ROLE_LABELS, SENSITIVE_FIELDS } = require('../constants/roles');
const { UNIT_STATUS, STOCKTAKE_SCOPE, STOCKTAKE_DEFAULT_SCOPE, STOCKTAKE_RESOLUTION } = require('../constants/status');
/** 盘点单 mock：与服务端相同的开单快照、边扫边勾、结束生成只读结果与差异处理记录 */
module.exports = function (db, { fail, requirePermission, clone, paginate, currentRole, staffUnit }) {
  let seq = 0;
  const sessions = [], takes = [], keys = {};
  const uid = p => p + '_' + Date.now().toString(36) + '_' + ++seq;
  const now = () => new Date().toISOString();
  const who = () => ROLE_LABELS[currentRole()] || currentRole();
  const auth = () => { requirePermission(PERM.STOCKTAKE); requirePermission(PERM.INVENTORY_VIEW); };
  const visible = key => !SENSITIVE_FIELDS[key] || SENSITIVE_FIELDS[key].includes(currentRole());
  const masked = code => !visible('fullImei') && /^\d{15}$/.test(code) ? code.slice(0, 2) + '****' + code.slice(-4) : code;
  const unitOf = id => db.units.find(u => u.id === id) || fail(404, '设备不存在');
  const categoryOf = u => u.category || ((db.models || []).find(m => m.id === u.modelId) || {}).category;
  const text = (v, label, max, optional) => { if (optional && (v === undefined || v === '')) return ''; if (typeof v !== 'string' || !v.trim() || v.trim().length > max) fail(400, label + '格式无效'); return v.trim(); };
  const session = id => sessions.find(s => s.id === id) || fail(404, '盘点单不存在');
  const counts = s => ({ expectedCount: s.units.length, scannedCount: s.units.filter(i => i.scannedAt).length, extraCount: s.extras.length });
  const sessionView = s => clone({ id: s.id, status: s.status, scope: s.scope, note: s.note, operator: s.operator, createdAt: s.createdAt, closedAt: s.closedAt || null, stocktakeId: s.stocktakeId || null, cancelReason: s.cancelReason || '', ...counts(s) });
  const latest = (t, key) => { const r = t.resolutions.filter(x => x.key === key).pop(); return r ? { resolution: r.resolution, label: STOCKTAKE_RESOLUTION[r.resolution].label, note: r.note, operator: r.operator, time: r.time } : null; };
  const settled = r => r && r.resolution !== 'pending';
  function summary(t) {
    const open = t.missingIds.filter(id => !settled(latest(t, 'unit:' + id))).length + t.extra.filter((e, i) => !settled(latest(t, 'extra:' + i))).length;
    return { id: t.id, time: t.time, operator: t.operator, scope: t.scope, sessionId: t.sessionId, expectedCount: t.expectedCount, scannedCount: t.scannedCount, matched: t.matchedIds.length, missingCount: t.missingIds.length, extraCount: t.extra.length, changedCount: t.changed.length, openCount: open };
  }
  function detail(t) {
    return clone({
      ...summary(t), missingIds: t.missingIds, matchedIds: t.matchedIds,
      missing: t.missingIds.map(id => ({ ...staffUnit(unitOf(id)), resolution: latest(t, 'unit:' + id) })),
      changed: t.changed.map(c => { const u = staffUnit(unitOf(c.unitId)); return { id: u.id, name: u.name, imeiMasked: u.imeiMasked, from: c.from, to: c.to }; }),
      extra: t.extra.map((e, i) => ({ key: String(i), code: masked(e.code), unitId: e.unitId, reason: e.reason, resolution: latest(t, 'extra:' + i) }))
    });
  }
  const take = id => takes.find(t => t.id === id) || fail(404, '盘点记录不存在');
  return [
    ['GET', '/stocktakes', d => { auth(); return clone(paginate(takes.map(summary), d)); }],
    ['GET', '/stocktakes/:id', (d, h, p) => { auth(); return detail(take(p.id)); }],
    ['POST', '/stocktakes/:id/resolutions', (d, h, p) => {
      auth(); const t = take(p.id);
      if (!['unit', 'extra'].includes(d.type)) fail(400, '差异类型无效');
      const target = text(d.target, '差异项', 80);
      if (!(d.type === 'unit' ? ['pending', 'found', 'lost'] : ['pending', 'handled']).includes(d.resolution)) fail(400, '处理结果无效');
      const note = text(d.note, '处理说明', 200);
      if (d.type === 'unit' && !t.missingIds.includes(target)) fail(400, '该设备不是本次盘点的缺失设备');
      if (d.type === 'extra' && !(/^\d+$/.test(target) && t.extra[Number(target)])) fail(400, '盘点异常项不存在');
      t.resolutions.push({ key: d.type + ':' + target, resolution: d.resolution, note, operator: who(), time: now() });
      return detail(t);
    }],
    ['GET', '/stocktake-sessions', d => {
      auth(); const status = d.status || 'open';
      if (!['open', 'closed', 'cancelled'].includes(status)) fail(400, '盘点单状态无效');
      return paginate(sessions.filter(s => s.status === status).map(sessionView), d);
    }],
    ['POST', '/stocktake-sessions', d => {
      auth();
      const selected = d.statuses === undefined ? STOCKTAKE_DEFAULT_SCOPE : d.statuses;
      if (!Array.isArray(selected) || !selected.length || selected.some(s => !STOCKTAKE_SCOPE.includes(s))) fail(400, '盘点范围只能选择在店内的库存状态');
      const statuses = [...new Set(selected)].sort(), modelId = d.modelId || null, category = d.category || null, note = text(d.note, '盘点说明', 200, true), key = text(d.requestKey, '提交标识', 80);
      if (modelId && category) fail(400, '型号和分类只能选一种范围');
      const signature = JSON.stringify({ statuses, modelId, category, note });
      if (keys[key]) { if (keys[key].signature !== signature) fail(409, '提交标识已用于其他内容，请保留原内容重试'); return sessionView(keys[key].session); }
      const model = modelId ? ((db.models || []).find(m => m.id === modelId) || fail(400, '盘点型号不存在')) : null;
      const cat = category ? (db.categories.find(c => c.value === category) || fail(400, '盘点分类不存在')) : null;
      const s = { id: uid('session'), status: 'open', scope: { statuses, modelId, modelName: model ? model.name : '', category, categoryLabel: cat ? cat.label : '' }, note, operator: who(), createdAt: now(), extras: [],
        units: db.units.filter(u => statuses.includes(u.status) && (!modelId || u.modelId === modelId) && (!category || categoryOf(u) === category)).map(u => ({ unitId: u.id, startStatus: u.status, scannedAt: null, scanner: '' })) };
      sessions.unshift(s); keys[key] = { signature, session: s };
      db.auditLogs.unshift({ id: uid('a'), time: now(), operator: who(), action: '开始盘点', detail: s.id });
      return sessionView(s);
    }],
    ['GET', '/stocktake-sessions/:id', (d, h, p) => { auth(); return sessionView(session(p.id)); }],
    ['GET', '/stocktake-sessions/:id/units', (d, h, p) => {
      auth(); const s = session(p.id), state = d.state || 'pending';
      if (state === 'extra') return clone(paginate(s.extras.slice().reverse().map(e => ({ id: e.id, code: masked(e.code), unitId: e.unitId, name: e.unitId ? unitOf(e.unitId).name : '', reason: e.reason, scannedAt: e.scannedAt, scanner: e.scanner })), d));
      if (!['pending', 'scanned'].includes(state)) fail(400, '清单类型无效');
      const rows = s.units.filter(i => state === 'pending' ? !i.scannedAt : i.scannedAt);
      if (state === 'scanned') rows.sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
      return clone(paginate(rows.map(i => ({ ...staffUnit(unitOf(i.unitId)), scannedAt: i.scannedAt, scanner: i.scanner })), d));
    }],
    ['POST', '/stocktake-sessions/:id/scans', (d, h, p) => {
      auth(); const s = session(p.id);
      if (s.status !== 'open') fail(409, '盘点单已结束，不能继续扫码');
      const code = text(d.code, '设备编号或串码', 80);
      const unit = db.units.find(u => [u.id, u.imei1, u.imei2].includes(code));
      const entry = unit && s.units.find(i => i.unitId === unit.id);
      let result, message;
      if (entry && entry.scannedAt) { result = 'duplicate'; message = '这台已经盘过'; }
      else if (entry) { entry.scannedAt = now(); entry.scanner = who(); result = 'matched'; message = '已盘到'; }
      else if (s.extras.some(e => e.code === code || (unit && e.unitId === unit.id))) { result = 'duplicate'; message = '已记为异常，不重复登记'; }
      else {
        const inScope = unit && s.scope.statuses.includes(unit.status) && (!s.scope.modelId || s.scope.modelId === unit.modelId) && (!s.scope.category || s.scope.category === categoryOf(unit));
        result = unit ? 'out_of_scope' : 'unknown';
        message = !unit ? '系统里没有这台设备' : inScope ? '开盘后才进入盘点范围，不在开盘清单' : (UNIT_STATUS[unit.status] || {}).label + '，不在本次盘点范围';
        s.extras.push({ id: uid('extra'), code, unitId: unit ? unit.id : null, unitStatus: unit ? unit.status : null, reason: message, scannedAt: now(), scanner: who() });
      }
      return clone({ result, message, code: masked(code), unit: unit ? staffUnit(unit) : null, ...counts(s) });
    }],
    ['POST', '/stocktake-sessions/:id/close', (d, h, p) => {
      auth(); const s = session(p.id);
      if (s.status === 'closed') return detail(take(s.stocktakeId));
      if (s.status !== 'open') fail(409, '盘点单已作废');
      const matchedIds = [], missingIds = [], changed = [];
      s.units.forEach(i => { const u = unitOf(i.unitId); if (i.scannedAt) matchedIds.push(u.id); else if (s.scope.statuses.includes(u.status)) missingIds.push(u.id); else changed.push({ unitId: u.id, from: i.startStatus, to: u.status }); });
      const t = { id: uid('stocktake'), time: now(), operator: who(), scope: { ...s.scope, note: s.note, startedAt: s.createdAt }, sessionId: s.id, expectedCount: s.units.length, scannedCount: matchedIds.length + s.extras.length, matchedIds, missingIds, changed, extra: s.extras.map(e => ({ code: e.code, unitId: e.unitId, unitStatus: e.unitStatus, reason: e.reason })), resolutions: [] };
      takes.unshift(t); s.status = 'closed'; s.stocktakeId = t.id; s.closedAt = t.time;
      db.auditLogs.unshift({ id: uid('a'), time: t.time, operator: who(), action: '结束盘点', detail: t.id });
      return detail(t);
    }],
    ['POST', '/stocktake-sessions/:id/cancel', (d, h, p) => {
      auth(); const s = session(p.id), reason = text(d.reason, '作废原因', 200);
      if (s.status !== 'open') fail(409, '只能作废进行中的盘点单');
      s.status = 'cancelled'; s.cancelReason = reason; s.closedAt = now();
      db.auditLogs.unshift({ id: uid('a'), time: s.closedAt, operator: who(), action: '作废盘点', detail: s.id, reason });
      return sessionView(s);
    }]
  ];
};
