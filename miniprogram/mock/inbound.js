const { PERM } = require('../constants/roles');
const { isImei } = require('../utils/validate');
const { validateValues } = require('../utils/template');
module.exports = function inbound(db, { fail, requirePermission, clone, getTemplate, modelForm, getOperator }) {
  let sequence = 0;
  function prepare(d, seen) {
    const model = db.models.find(m => m.id === d.modelId) || fail(400, '请选择有效型号');
    const template = modelForm(model.id);
    if (d.templateVersion !== template.version) fail(409, '模板已更新，请重新选择型号');
    if (db.acceptanceReservations?.[d.imei1] || (d.imei2 && db.acceptanceReservations?.[d.imei2])) fail(409, '串码正在异常验收中');
    const attributes = d.attributes || {};
    const error = validateValues(template.fields, attributes);
    if (error) fail(400, error);
    for (const imei of [d.imei1, d.imei2].filter(Boolean)) {
      if (!isImei(imei) || seen.has(imei) || db.units.some(u => u.imei1 === imei || u.imei2 === imei)) fail(400, 'IMEI 无效或已存在（含批内重复）');
      seen.add(imei);
    }
    if (!d.imei1) fail(400, '请填写 IMEI1');
    const matched = db.models.find(m => (m.tacs || []).includes(d.imei1.slice(0, 8)));
    if (matched && matched.id !== model.id) fail(400, '串码识别型号与所选型号不一致，请核验');
    if (['cost', 'retail', 'wholesale', 'agentBase'].some(k => !['string', 'number'].includes(typeof d[k]) || String(d[k]).trim() === '' || !Number.isFinite(Number(d[k])) || Number(d[k]) < 0)) fail(400, '请填写有效的成本与三价');
    if (d.condition && !['used', 'new'].includes(d.condition)) fail(400, '设备类型无效');
    if (d.flags && Object.keys(d.flags).some(k => !['showInShop', 'sharePeer', 'shareAgent'].includes(k) || typeof d.flags[k] !== 'boolean')) fail(400, '分享开关格式无效');
    const clean = {};
    template.fields.forEach(f => { if (attributes[f.key] !== undefined) clean[f.key] = clone(attributes[f.key]); });
    const preparing = clean.refurbishment === '正在整备';
    return {
      id: `u_${Date.now()}_${++sequence}`, modelId: model.id, name: model.name, brand: model.brand, category: model.category, condition: d.condition || 'used',
      supplier: clean.supplier || '', receiptImages: clone(clean.receipt || d.receiptImages || []),
      imei1: d.imei1, imei2: d.imei2 || '', status: preparing ? 'recheck' : 'in_stock', ageDays: 0,
      cost: Number(d.cost), retail: Number(d.retail), wholesale: Number(d.wholesale), agentBase: Number(d.agentBase),
      flags: preparing ? { showInShop: false, sharePeer: false, shareAgent: false } : clone(d.flags || {}),
      images: (d.publicImages || []).filter(f => f.mediaType !== 'video').map(f => f.url),
      videos: (d.publicImages || []).filter(f => f.mediaType === 'video').map(f => f.url),
      customerDesc: d.customerDesc || '', peerDesc: d.peerDesc || '', internalNote: d.internalNote || '',
      storage: clean.storage || '', color: clean.color || '', grade: clean.grade || '', version: clean.version || '', battery: clean.battery || '',
      templateSnapshot: clone(template), attributes: clean
    };
  }
  function commit(units) {
    db.units.unshift(...units);
    db.auditLogs.unshift({ id: `a_${Date.now()}_${++sequence}`, time: new Date().toISOString(), operator: getOperator(), action: '入库', detail: `${units.length} 台设备，已保存模板快照` });
  }
  const routes = [
    ['POST', '/inbound/units', d => { requirePermission(PERM.INBOUND); const unit = prepare(d, new Set()); commit([unit]); return { id: unit.id }; }],
    ['POST', '/inbound/batch', d => {
      requirePermission(PERM.INBOUND);
      if (!Array.isArray(d.units) || !d.units.length || d.units.length > 100) fail(400, '批量入库需为 1～100 台');
      const seen = new Set();
      const units = d.units.map((row, i) => {
        if (!row || typeof row !== 'object') fail(400, `第 ${i + 1} 台数据无效`);
        const common = d.common || {};
        try { return prepare({ ...common, ...row, attributes: { ...(common.attributes || {}), ...(row.attributes || {}) } }, seen); }
        catch (e) { e.message = `第 ${i + 1} 台：${e.message}`; throw e; }
      });
      commit(units); return { created: units.length, ids: units.map(u => u.id) };
    }]
  ];
  routes.prepareUnit = prepare;
  routes.commitUnits = commit;
  return routes;
};
