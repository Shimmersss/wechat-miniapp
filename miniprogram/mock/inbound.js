const { PERM } = require('../constants/roles');
const { isImei, normalizeSerial, serialError, noSerialReasonError } = require('../utils/validate');
const { validateValues } = require('../utils/template');
module.exports = function inbound(db, { fail, requirePermission, clone, getTemplate, modelForm, unitMode, getOperator }) {
  /** 与服务端 stock_identity 一致：按分类串码方式校验并返回 { imei1, imei2, serialNo, noSerialReason } */
  function identity(d, mode) {
    const trim = v => String(v === undefined || v === null ? '' : v).trim();
    let imei1 = trim(d.imei1), imei2 = trim(d.imei2), serialNo = trim(d.serialNo), reason = trim(d.noSerialReason);
    if (mode === 'imei') {
      if (serialNo || reason) fail(400, '手机请填写 IMEI，不登记序列号');
      if (!imei1) fail(400, '请填写 IMEI1');
      return { imei1, imei2, serialNo: '', noSerialReason: '' };
    }
    if (imei2) fail(400, 'IMEI2 只用于手机');
    if (imei1 && mode === 'serial') fail(400, '该分类不登记 IMEI，请填写序列号');
    if (serialNo) {
      const error = serialError(serialNo); if (error) fail(400, error);
      if (reason) fail(400, '已填写序列号，不需要填写无序列号原因');
      serialNo = normalizeSerial(serialNo);
    } else if (!imei1) {
      const error = noSerialReasonError(reason); if (error) fail(400, error);
    } else reason = '';
    return { imei1, imei2: '', serialNo, noSerialReason: reason };
  }
  let sequence = 0;
  function prepare(d, seen) {
    const model = db.models.find(m => m.id === d.modelId) || fail(400, '请选择有效型号');
    const template = modelForm(model.id);
    if (d.templateVersion !== template.version) fail(409, '模板已更新，请重新选择型号');
    const id = identity(d, unitMode({ modelId: model.id }));
    if ((id.imei1 && db.acceptanceReservations?.[id.imei1]) || (id.imei2 && db.acceptanceReservations?.[id.imei2])) fail(409, '串码正在异常验收中');
    const attributes = d.attributes || {};
    const error = validateValues(template.fields, attributes);
    if (error) fail(400, error);
    for (const imei of [id.imei1, id.imei2].filter(Boolean)) {
      if (!isImei(imei) || seen.has(imei) || db.units.some(u => u.imei1 === imei || u.imei2 === imei)) fail(400, 'IMEI 无效或已存在（含批内重复）');
      seen.add(imei);
    }
    if (id.serialNo) {
      // 只要求同型号下序列号不重复
      if (seen.has('SN:' + id.serialNo) || db.units.some(u => u.modelId === model.id && u.serialNo === id.serialNo)) fail(409, '同型号下该序列号已入库');
      seen.add('SN:' + id.serialNo);
    }
    const matched = id.imei1 && db.models.find(m => (m.tacs || []).includes(id.imei1.slice(0, 8)));
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
      imei1: id.imei1, imei2: id.imei2 || '', serialNo: id.serialNo, noSerialReason: id.noSerialReason, lotId: d.lotId || null, status: preparing ? 'recheck' : 'in_stock', ageDays: 0,
      cost: Number(d.cost), retail: Number(d.retail), wholesale: Number(d.wholesale), agentBase: Number(d.agentBase),
      flags: preparing ? { showInShop: false, sharePeer: false, shareAgent: false } : clone(d.flags || {}),
      images: (d.publicImages || []).filter(f => f.mediaType !== 'video').map(f => f.url),
      videos: (d.publicImages || []).filter(f => f.mediaType === 'video').map(f => f.url),
      customerDesc: d.customerDesc || '', peerDesc: d.peerDesc || '', internalNote: d.internalNote || '',
      storage: clean.storage || '', ram: clean.ram, color: clean.color || '', grade: clean.grade || '', version: clean.version || '', battery: clean.battery || '',
      templateSnapshot: clone(template), attributes: clean
    };
  }
  function commit(units) {
    db.units.unshift(...units);
    db.auditLogs.unshift({ id: `a_${Date.now()}_${++sequence}`, time: new Date().toISOString(), operator: getOperator(), action: '入库', detail: `${units.length} 台设备，已保存模板快照` });
  }
  const routes = [
    ['POST', '/inbound/units', d => {
      requirePermission(PERM.INBOUND);
      // 按数量入库：无任何串码时生成同批 N 件，共用 lotId
      const quantity = d.quantity === undefined ? 1 : Number(d.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) fail(400, '入库数量需为 1～100 的整数');
      if (quantity > 1 && [d.serialNo, d.imei1, d.imei2].some(v => v !== undefined && String(v).trim() !== '')) fail(400, '按数量入库只用于没有序列号的设备');
      const lotId = quantity > 1 ? `lot_${Date.now()}_${++sequence}` : null;
      const seen = new Set();
      const units = Array.from({ length: quantity }, () => prepare({ ...d, lotId }, seen));
      commit(units);
      return { id: units[0].id, created: units.length, ids: units.map(u => u.id), lotId };
    }],
    ['POST', '/inbound/check-serial', d => {
      requirePermission(PERM.INBOUND, PERM.ACCEPTANCE);
      const model = db.models.find(m => m.id === d.modelId) || fail(400, '请选择有效型号');
      const error = serialError(d.serialNo); if (error) fail(400, error);
      const serialNo = normalizeSerial(d.serialNo);
      const exist = db.units.find(u => u.modelId === model.id && u.serialNo === serialNo);
      return exist ? { unique: false, conflictUnitId: exist.id, serialNo } : { unique: true, serialNo };
    }],
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
