const { PERM, SENSITIVE_FIELDS } = require('../constants/roles');
const { isImei } = require('../utils/validate');
module.exports = function purchase(db, { fail, requirePermission, clone, paginate, currentRole, getTemplate, prepareUnit, commitUnits, validateFiles }) {
  let sequence = 0;
  const makeId = prefix => prefix + '_' + Date.now() + '_' + ++sequence;
  db.suppliers = db.suppliers || [{ id: 'sp1', name: '深圳严选供应链', contact: '严经理', settle: '月结', active: true }, { id: 'sp2', name: '华强北 B 档', contact: '陈老板', settle: '现结', active: true }];
  db.acceptanceReservations = db.acceptanceReservations || {};
  const batches = {};
  const visible = key => !SENSITIVE_FIELDS[key] || SENSITIVE_FIELDS[key].includes(currentRole());
  const read = () => requirePermission(PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE);
  const manage = () => { requirePermission(PERM.PURCHASE_MANAGE); requirePermission(PERM.SUPPLIER_VIEW); };
  const note = (action, target) => db.auditLogs.unshift({ id: makeId('audit'), operator: currentRole(), time: new Date().toISOString(), action, detail: target });
  const amount = (v, label) => { if (!/^\d{1,12}(\.\d{1,2})?$/.test(String(v))) fail(400, label + '须为非负金额，最多两位小数'); return Math.round(Number(v) * 100); };
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.keys(value).sort().reduce((o, k) => { o[k] = canonical(value[k]); return o; }, {}) : value;
  for (const po of db.purchaseOrders) {
    po.supplierId = po.supplierId || (po.id === 'po1' ? 'sp1' : 'sp2');
    po.shipments = po.shipments || (po.shipment ? [{ ...po.shipment, status: po.status === 'arrived' ? 'signed' : 'in_transit' }] : []);
    po.lines = po.lines || [{ id: makeId('line'), modelId: 'm_17pm', modelName: 'iPhone 17 Pro Max', templateId: 't_phone', quantity: po.qty, unitCost: po.amount / po.qty, attributes: {}, received: 0, accepted: 0, rejected: 0 }];
    po.exceptions = po.exceptions || [];
  }
  function poById(id) { return db.purchaseOrders.find(p => p.id === id) || fail(404, '采购单不存在'); }
  function refresh(po) {
    const remaining = po.lines.reduce((n, l) => n + l.quantity - l.received, 0), received = po.lines.reduce((n, l) => n + l.received, 0);
    po.status = po.exceptions.some(e => ['none', 'dispute'].includes(e.resolution)) ? 'exception' : remaining === 0 && po.shipments.every(s => s.status === 'signed') ? 'completed' : received ? 'accepting' : po.shipments.some(s => s.status === 'signed') ? 'arrived' : po.shipments.length ? 'in_transit' : 'pending_ship';
  }
  function view(po) {
    const out = clone(po); out.shipment = out.shipments[0] || null;
    out.lines.forEach(l => { l.remaining = l.quantity - l.received; if (!visible('cost')) delete l.unitCost; });
    out.exceptions.forEach(e => { delete e.receiptImages; if (!visible('fullImei')) { delete e.imei1; delete e.imei2; } });
    if (!visible('supplier')) { delete out.supplier; delete out.supplierId; }
    if (!visible('cost')) { delete out.amount; delete out.freight; }
    return out;
  }
  function saveSupplier(d, id) {
    manage();
    if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 100) fail(400, '请填写供应商名称，最多100字');
    if (d.active !== undefined && typeof d.active !== 'boolean') fail(400, '供应商状态无效');
    if (db.suppliers.some(s => s.id !== id && s.name === d.name.trim())) fail(409, '供应商名称已存在');
    const old = id ? db.suppliers.find(s => s.id === id) : null;
    if (id && !old) fail(404, '供应商不存在');
    const row = { id: id || makeId('supplier'), name: d.name.trim(), contact: d.contact || '', phone: d.phone || '', settle: d.settle || '', note: d.note || '', active: d.active === undefined ? true : d.active };
    if (old) Object.assign(old, row); else db.suppliers.unshift(row);
    note(old ? '修改供应商' : '新增供应商', row.id); return clone(row);
  }
  function saveOrder(d, id) {
    manage();
    const supplier = db.suppliers.find(s => s.id === d.supplierId && s.active);
    if (!supplier) fail(400, '请选择有效供应商');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.expectedAt || '') || !Number.isFinite(new Date(d.expectedAt).getTime()) || new Date(d.expectedAt).toISOString().slice(0, 10) !== d.expectedAt) fail(400, '预计到货日期无效');
    if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > 100) fail(400, '请添加1～100行采购明细');
    const old = id ? poById(id) : null;
    if (old && old.status !== 'pending_ship') fail(409, '已发货采购单不能修改');
    let total = amount(d.freight || 0, '运费'), qty = 0;
    const lines = d.lines.map(row => {
      const model = db.models.find(m => m.id === row.modelId);
      if (!model || !/^\d+$/.test(String(row.quantity)) || Number(row.quantity) < 1 || Number(row.quantity) > 1000) fail(400, '采购型号或数量无效');
      const cost = amount(row.unitCost, '采购单价'), quantity = Number(row.quantity);
      qty += quantity; total += quantity * cost;
      if (total > 99999999999999) fail(400, '采购金额超出范围');
      const attributes = {};
      for (const key of ['storage', 'color', 'version']) if (row.attributes && row.attributes[key]) { if (typeof row.attributes[key] !== 'string' || row.attributes[key].length > 100) fail(400, '采购规格无效'); attributes[key] = row.attributes[key]; }
      return { id: makeId('line'), modelId: model.id, modelName: model.name, templateId: model.templateId, attributes, quantity, unitCost: cost / 100, received: 0, accepted: 0, rejected: 0 };
    });
    if (qty > 10000) fail(400, '采购数量超出范围');
    const target = id || makeId('po'), po = { id: target, no: old ? old.no : 'PO-' + target, supplierId: supplier.id, supplier: supplier.name, status: 'pending_ship', expectedAt: d.expectedAt, freight: Number(d.freight || 0), amount: Number(total) / 100, qty, owner: currentRole(), remark: d.remark || '', lines, shipments: [], exceptions: [] };
    if (old) Object.assign(old, po); else db.purchaseOrders.unshift(po);
    note(old ? '修改采购单' : '创建采购单', target); return view(po);
  }
  function shipped(id) {
    for (const po of db.purchaseOrders) { const shipment = po.shipments.find(s => s.id === id); if (shipment) return { po, shipment }; }
    fail(404, '运单不存在');
  }
  function prepareAccepted(item, line, po, trustedIds) {
    if (item.modelId !== line.modelId || Object.keys(line.attributes).some(k => item.attributes && item.attributes[k] !== line.attributes[k])) fail(400, '型号或规格不符，应记录异常');
    const template = getTemplate(line.templateId), attributes = { ...item.attributes, supplier: po.supplier };
    const receipt = validateFiles(item.receiptImages || attributes.receipt || [], 'internal', trustedIds);
    if (!receipt.length) fail(400, '请上传收货凭证'); attributes.receipt = receipt;
    for (const field of template.fields.filter(f => f.type === 'image' && f.key !== 'receipt')) attributes[field.key] = validateFiles(attributes[field.key] || [], field.visibility.includes('internal') ? 'internal' : 'public');
    const publicImages = validateFiles(item.publicImages || [], 'public');
    for (const key of ['retail', 'wholesale', 'agentBase']) amount(item[key], '单台三价');
    return prepareUnit({ ...item, attributes, cost: line.unitCost, receiptImages: receipt, publicImages, flags: item.flags || {} }, new Set());
  }
  function accept(d, id) {
    requirePermission(PERM.ACCEPTANCE);
    const po = poById(id);
    if (!d.requestKey || typeof d.requestKey !== 'string' || d.requestKey.length > 80) fail(400, '请刷新验收表单');
    const key = d.requestKey, signature = JSON.stringify(canonical({ ...d, poId: id }));
    if (batches[key]) { if (batches[key].signature !== signature) fail(409, '提交标识冲突'); return clone(batches[key].result); }
    if (!['arrived', 'accepting', 'exception'].includes(po.status) || !po.shipments.some(s => s.status === 'signed')) fail(409, '请先登记实际签收');
    if (!Array.isArray(d.items) || !d.items.length || d.items.length > 100 || Number(d.declaredCount) !== d.items.length) fail(400, '实收数量与扫码数量不符');
    const remaining = po.lines.reduce((n, l) => n + l.quantity - l.received, 0);
    if (d.items.length > remaining) fail(400, '验收数量超过采购剩余数量');
    if (d.items.length < remaining && (d.partialConfirmed !== true || !d.partialReason || !d.partialReason.trim())) fail(400, '请确认分批验收并填写原因');
    const seen = new Set(), lineCounts = {}, planned = [];
    for (const item of d.items) {
      const line = po.lines.find(l => l.id === item.lineId);
      if (!line || (lineCounts[line.id] = (lineCounts[line.id] || 0) + 1) > line.quantity - line.received || !['pass', 'fail'].includes(item.result)) fail(400, '采购明细或验收结论无效');
      const imei1 = String(item.imei1 || ''), imei2 = item.imei2 || '';
      if (!imei1) fail(400, '请填写 IMEI1');
      for (const code of [imei1, imei2].filter(Boolean)) {
        if (!isImei(code) || seen.has(code) || db.units.some(u => u.imei1 === code || u.imei2 === code) || db.acceptanceReservations[code]) fail(409, '串码无效或重复');
        seen.add(code);
      }
      const proof = validateFiles(item.receiptImages || (item.attributes || {}).receipt || [], 'internal');
      if (!proof.length) fail(400, '请上传收货凭证');
      const itemId = makeId('accept');
      if (item.result === 'pass') planned.push({ itemId, line, unit: prepareAccepted(item, line, po) });
      else {
        if (!item.remark || !item.remark.trim()) fail(400, '请填写异常原因');
        planned.push({ itemId, line, exception: { id: itemId, lineId: line.id, modelId: line.modelId, modelName: line.modelName, imei1, imei2, imeiMasked: imei1.slice(0, 2) + '****' + imei1.slice(-4), reason: item.remark, resolution: 'none', observedModel: item.observedModel || '', receiptImages: proof } });
      }
    }
    const units = planned.filter(p => p.unit).map(p => p.unit);
    // 全部校验后才写入，失败不留下库存、计数或审计。
    for (const p of planned) {
      p.line.received++;
      if (p.unit) { p.line.accepted++; p.unit.purchaseLineId = p.line.id; }
      else { p.line.rejected++; po.exceptions.push(p.exception); for (const code of [p.exception.imei1, p.exception.imei2].filter(Boolean)) db.acceptanceReservations[code] = p.itemId; }
    }
    if (units.length) commitUnits(units);
    refresh(po);
    const result = { batchId: makeId('batch'), accepted: units.length, rejected: planned.length - units.length, unitIds: units.map(u => u.id), itemIds: planned.map(p => p.itemId) };
    batches[key] = { signature, result }; note('采购到货验收', po.id); return clone(result);
  }
  return [
    ['GET', '/suppliers', d => { requirePermission(PERM.SUPPLIER_VIEW); let rows = db.suppliers; if (d.active !== undefined) { if (!['true', 'false'].includes(String(d.active))) fail(400, '供应商状态无效'); rows = rows.filter(s => s.active === (String(d.active) === 'true')); } if (d.keyword) rows = rows.filter(s => s.name.includes(d.keyword)); return clone(paginate(rows, d)); }],
    ['POST', '/suppliers', d => saveSupplier(d)], ['PUT', '/suppliers/:id', (d, h, p) => saveSupplier(d, p.id)],
    ['GET', '/purchase-orders', d => {
      read(); let rows = db.purchaseOrders;
      if (d.status) rows = rows.filter(p => p.status === d.status);
      if (d.supplierId) { requirePermission(PERM.SUPPLIER_VIEW); if (!visible('supplier')) fail(403, '无权限筛选供应商'); rows = rows.filter(p => p.supplierId === d.supplierId); }
      if (d.keyword) rows = rows.filter(p => p.no.includes(d.keyword) || p.shipments.some(s => s.trackingNo.includes(d.keyword)));
      const remaining = p => p.lines.reduce((n, l) => n + l.quantity - l.received, 0);
      return { ...paginate(rows.map(view), d), summary: { orders: rows.length, totalQty: rows.reduce((n, p) => n + p.qty, 0), remainingQty: rows.reduce((n, p) => n + remaining(p), 0), inTransitQty: rows.filter(p => p.status === 'in_transit').reduce((n, p) => n + remaining(p), 0) } };
    }],
    ['GET', '/purchase-orders/:id', (d, h, p) => { read(); return view(poById(p.id)); }],
    ['POST', '/purchase-orders', d => saveOrder(d)], ['PUT', '/purchase-orders/:id', (d, h, p) => saveOrder(d, p.id)],
    ['POST', '/purchase-orders/:id/shipments', (d, h, p) => {
      requirePermission(PERM.PURCHASE_MANAGE); const po = poById(p.id);
      if (!['SF', 'JD', 'OTHER'].includes(d.carrier) || !/^[A-Za-z0-9]{8,40}$/.test(d.trackingNo || '')) fail(400, '运单信息无效');
      if (po.status === 'completed') fail(409, '采购单已完成');
      if (db.purchaseOrders.some(po => po.shipments.some(s => s.carrier === d.carrier && s.trackingNo === d.trackingNo))) fail(409, '运单已绑定');
      const shipment = { id: makeId('shipment'), carrier: d.carrier, trackingNo: d.trackingNo, status: 'in_transit' };
      po.shipments.push(shipment); refresh(po); note('绑定采购运单', po.id); return { id: shipment.id };
    }],
    ['POST', '/shipments/:id/receive', (d, h, p) => { read(); if (!d.reason || !d.reason.trim()) fail(400, '请填写人工签收说明'); const { po, shipment } = shipped(p.id); if (shipment.status !== 'signed') { shipment.status = 'signed'; shipment.signedAt = new Date().toISOString(); refresh(po); note('采购运单人工签收', po.id); } return { received: true, purchaseStatus: po.status }; }],
    ['GET', '/purchase-orders/:id/acceptance', (d, h, p) => { requirePermission(PERM.ACCEPTANCE); const po = view(poById(p.id)); return { poId: po.id, no: po.no, status: po.status, lines: po.lines, exceptions: po.exceptions, items: [], expectedTotal: po.qty, remaining: po.lines.reduce((n, l) => n + l.remaining, 0), canAccept: ['arrived', 'accepting', 'exception'].includes(po.status) }; }],
    ['POST', '/purchase-orders/:id/acceptance', (d, h, p) => accept(d, p.id)],
    ['POST', '/acceptances/:id/resolve', (d, h, p) => {
      requirePermission(PERM.ACCEPTANCE);
      const po = db.purchaseOrders.find(po => po.exceptions.some(e => e.id === p.id));
      if (!po) fail(404, '异常记录不存在');
      const item = po.exceptions.find(e => e.id === p.id);
      if (!['none', 'dispute'].includes(item.resolution)) fail(409, '异常已处理');
      if (!d.reason || !d.reason.trim()) fail(400, '请填写处理原因');
      let unitId = null;
      if (d.action === 'return') { item.resolution = 'returned'; for (const code of [item.imei1, item.imei2].filter(Boolean)) delete db.acceptanceReservations[code]; }
      else if (d.action === 'dispute') item.resolution = 'dispute';
      else if (d.action === 'reinspect') {
        const line = po.lines.find(l => l.id === item.lineId);
        if (d.unit && ((d.unit.imei1 && d.unit.imei1 !== item.imei1) || (d.unit.imei2 && d.unit.imei2 !== item.imei2))) fail(400, '复验不能替换原串码');
        const reservations = { ...db.acceptanceReservations };
        let unit;
        try {
          for (const code of [item.imei1, item.imei2].filter(Boolean)) delete db.acceptanceReservations[code];
          unit = prepareAccepted({ ...d.unit, imei1: item.imei1, imei2: item.imei2, receiptImages: (d.unit || {}).receiptImages || (d.unit && d.unit.attributes || {}).receipt || item.receiptImages }, line, po, new Set(item.receiptImages.map(f => f.fileId)));
        } catch (e) { db.acceptanceReservations = reservations; throw e; }
        unitId = unit.id; unit.purchaseLineId = line.id; commitUnits([unit]); item.resolution = 'reinspected'; line.accepted++; line.rejected--;
      } else fail(400, '处理方式无效');
      item.reason = d.reason; refresh(po); note('处理验收异常', item.id); return { resolved: true, unitId, purchaseStatus: po.status };
    }]
  ];
};
