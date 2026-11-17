const { PERM } = require('../constants/roles');
const { validateSpecs, normalizeSpecs, supportsRam } = require('../utils/template');
module.exports = function catalog(db, { fail, requirePermission, clone, templateHistory, getOperator }) {
  let sequence = 0;
  const id = prefix => `${prefix}_${Date.now().toString(36)}_${++sequence}`;
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 50) fail(400, `${label}需为 1～50 个字符`);
    return value.trim();
  };
  const identifierMode = v => (['imei', 'serial', 'serial_imei'].includes(v) ? v : fail(400, '串码方式无效'));
  const unitCount = value => db.units.filter(u => (db.models.find(m => m.id === u.modelId) || {}).category === value || (!u.modelId && u.category === value)).length;
  function saveModel(d, existing) {
    requirePermission(PERM.TEMPLATE_MANAGE);
    const category = db.categories.find(c => c.value === d.category) || fail(400, '分类不存在');
    if (!category.templateId) fail(400, '该分类还没有入库模板');
    const specError = validateSpecs(d.specs);
    if (specError) fail(400, specError);
    const name = text(d.name, '型号'), label = text(d.brandLabel, '品牌'), seriesName = text(d.series, '系列');
    if (db.models.some(m => m.id !== (existing || {}).id && m.name === name)) fail(400, '型号名称已存在');
    const tacs = d.tacs || [];
    if (!Array.isArray(tacs) || tacs.length > 100 || tacs.some(t => typeof t !== 'string' || !/^\d{8}$/.test(t)) || new Set(tacs).size !== tacs.length) fail(400, 'TAC 必须为不重复的 8 位数字');
    if (tacs.length && (typeof d.tacSource !== 'string' || !d.tacSource.trim())) fail(400, '请填写 TAC 核验来源');
    if (db.models.some(m => m.id !== (existing || {}).id && (m.tacs || []).some(t => tacs.includes(t)))) fail(409, '该 TAC 已关联其他型号，请先核验');
    const matchingBrands = db.models.filter(m => d.brandId === undefined
      ? m.brandLabel.toLowerCase() === label.toLowerCase()
      : m.brand === text(d.brandId, '品牌'));
    const brandMatch = matchingBrands.find(m => m.category === category.value) || matchingBrands[0];
    if (d.brandId !== undefined && !brandMatch) fail(409, '所选品牌已不存在，请重新选择或手动填写');
    const brand = brandMatch?.brand || label;
    const brandLabel = d.brandId === undefined ? label : brandMatch.brandLabel;
    const seriesMatch = db.models.find(m => m.category === category.value && m.brand === brand && m.series.toLowerCase() === seriesName.toLowerCase());
    const series = seriesMatch?.series || seriesName;
    // 型号统一使用所属分类的模板，单独覆盖规格选项；修改时未传 specs 保留原规格
    const specs = d.specs === undefined && existing ? normalizeSpecs(existing.specs) : normalizeSpecs(d.specs);
    if (!supportsRam(d.category)) delete specs.ram;
    const model = { id: existing ? existing.id : id('m'), category: d.category, name, brand, brandLabel, series, templateId: category.templateId, specs, tacs: clone(tacs), tacSource: String(d.tacSource || '').trim().slice(0, 200) };
    if (existing) db.models[db.models.indexOf(existing)] = model;
    else db.models.push(model);
    db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: existing ? '修改型号' : '新增型号', detail: name });
    return clone({ ...model, identifierMode: category.identifierMode || 'imei' });
  }
  return [
    ['GET', '/catalog/categories', d => {
      requirePermission(PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE, PERM.INVENTORY_VIEW);
      const list = db.categories.slice().sort((a, b) => (a.sortOrder || 100) - (b.sortOrder || 100)).map(c => ({ value: c.value, label: c.label, templateId: c.templateId, identifierMode: c.identifierMode || 'imei', sortOrder: c.sortOrder || 100, unitCount: unitCount(c.value) }));
      return clone({ list, total: list.length, page: 1, pageSize: list.length });
    }],
    ['POST', '/catalog/categories', d => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const label = text(d.label, '分类名称');
      if (db.categories.some(c => c.label === label)) fail(400, '分类名称已存在');
      // 新分类复制一份基础模板作为本分类模板
      const base = db.templates.find(t => t.id === d.copyTemplateId) || fail(400, '请选择要复制的基础模板');
      const mode = d.identifierMode === undefined ? 'serial' : identifierMode(d.identifierMode);
      const category = { value: id('category'), label, brands: [], identifierMode: mode, sortOrder: 100 };
      const template = { ...clone(base), fields: clone(base.fields.filter(f => f.key !== 'ram')), id: id('t'), category: category.value, name: `${label}通用模板`, version: 1 };
      db.templates.push(template); templateHistory[template.id] = [clone(template)];
      category.templateId = template.id; db.categories.push(category);
      db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: '新增分类', detail: label });
      return { value: category.value, label, templateId: template.id, identifierMode: mode, sortOrder: 100 };
    }],
    ['PUT', '/catalog/categories/:id', (d, h, p) => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const category = db.categories.find(c => c.value === p.id) || fail(404, '分类不存在');
      const label = text(d.label, '分类名称');
      if (db.categories.some(c => c.value !== p.id && c.label === label)) fail(400, '分类名称已存在');
      const mode = d.identifierMode === undefined ? category.identifierMode || 'imei' : identifierMode(d.identifierMode);
      if (mode !== (category.identifierMode || 'imei') && unitCount(category.value)) fail(409, '该分类下已有设备，不能修改串码方式');
      category.identifierMode = mode;
      const old = category.label; category.label = label; db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: '修改分类', detail: `${old} → ${label}` }); return { value: category.value, label, templateId: category.templateId, identifierMode: mode, sortOrder: category.sortOrder || 100 };
    }],
    ['GET', '/models/series', d => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const category = text(d.category, '分类'), brand = text(d.brand, '品牌');
      return [...new Set(db.models.filter(m => m.category === category && m.brand === brand).map(m => m.series))].sort();
    }],
    ['POST', '/models', d => saveModel(d)],
    ['PUT', '/models/:id', (d, h, p) => saveModel(d, db.models.find(m => m.id === p.id) || fail(404, '型号不存在'))],
    ['DELETE', '/models/:id', (d, h, { id: modelId }) => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const index = db.models.findIndex(m => m.id === modelId);
      if (index < 0) fail(404, '型号不存在');
      if (db.units.some(u => u.modelId === modelId) || db.purchaseOrders.some(order =>
        order.lines?.some(line => line.modelId === modelId) || order.exceptions?.some(item => item.modelId === modelId))) {
        fail(409, '该型号已被库存、采购或验收记录引用，不能删除');
      }
      const [model] = db.models.splice(index, 1);
      db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: '删除型号', detail: model.name });
      return { id: modelId, deleted: true };
    }],
    ['POST', '/inbound/identify-model', d => {
      requirePermission(PERM.INBOUND);
      if (!require('../utils/validate').isImei(d.imei)) fail(400, 'IMEI 格式或校验位无效');
      const models = db.models.filter(m => (m.tacs || []).includes(d.imei.slice(0, 8)));
      if (models.length !== 1) return { matched: false, message: '未找到已核验的型号，请手动选择' };
      const { tacs, tacSource, ...model } = models[0];
      return { matched: true, model: clone(model), source: tacSource, message: '已匹配核验记录，请确认实机型号；存储容量、运行内存、颜色与机况需另行填写' };
    }]
  ];
};
