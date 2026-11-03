const { PERM } = require('../constants/roles');
module.exports = function catalog(db, { fail, requirePermission, clone, templateHistory, getOperator }) {
  let sequence = 0;
  const id = prefix => `${prefix}_${Date.now().toString(36)}_${++sequence}`;
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 50) fail(400, `${label}需为 1～50 个字符`);
    return value.trim();
  };
  function saveModel(d, existing) {
    requirePermission(PERM.TEMPLATE_MANAGE);
    if (!db.categories.some(c => c.value === d.category)) fail(400, '分类不存在');
    const name = text(d.name, '型号'), brandLabel = text(d.brandLabel, '品牌'), series = text(d.series, '系列');
    if (db.models.some(m => m.id !== (existing || {}).id && m.name === name)) fail(400, '型号名称已存在');
    const tacs = d.tacs || [];
    if (!Array.isArray(tacs) || tacs.length > 100 || tacs.some(t => typeof t !== 'string' || !/^\d{8}$/.test(t)) || new Set(tacs).size !== tacs.length) fail(400, 'TAC 必须为不重复的 8 位数字');
    if (tacs.length && (typeof d.tacSource !== 'string' || !d.tacSource.trim())) fail(400, '请填写 TAC 核验来源');
    if (db.models.some(m => m.id !== (existing || {}).id && (m.tacs || []).some(t => tacs.includes(t)))) fail(409, '该 TAC 已关联其他型号，请先核验');
    const brandMatch = db.models.find(m => m.brandLabel === brandLabel);
    const model = { id: existing ? existing.id : id('m'), category: d.category, name, brand: brandMatch ? brandMatch.brand : brandLabel, brandLabel, series, tacs: clone(tacs), tacSource: String(d.tacSource || '').trim().slice(0, 200) };
    if (existing) model.templateId = existing.templateId;
    else {
      const base = db.templates.find(t => t.id === d.copyTemplateId) || fail(400, '请选择要复制的基础模板');
      const template = { ...clone(base), id: id('t'), name: `${name}入库模板`, category: d.category, version: 1 };
      db.templates.push(template); templateHistory[template.id] = [clone(template)]; model.templateId = template.id;
    }
    if (existing) {
      const template = db.templates.find(t => t.id === model.templateId);
      if (existing.category !== model.category && db.models.some(m => m.id !== existing.id && m.templateId === model.templateId)) {
        const copy = { ...clone(template), id: id('t'), category: model.category, name: `${name}入库模板`, version: 1 };
        db.templates.push(copy); templateHistory[copy.id] = [clone(copy)]; model.templateId = copy.id;
      } else if (template.category !== model.category) {
        const next = { ...clone(template), category: model.category, version: template.version + 1 };
        db.templates[db.templates.indexOf(template)] = next; templateHistory[next.id].push(clone(next));
      }
      db.models[db.models.indexOf(existing)] = model;
    }
    else db.models.push(model);
    db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: existing ? '修改型号' : '新增型号', detail: name });
    return clone(model);
  }
  return [
    ['GET', '/catalog/categories', d => { requirePermission(PERM.TEMPLATE_MANAGE, PERM.INBOUND, PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE, PERM.INVENTORY_VIEW); return clone({ list: db.categories.map(c => ({ value: c.value, label: c.label })), total: db.categories.length, page: 1, pageSize: db.categories.length }); }],
    ['POST', '/catalog/categories', d => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const label = text(d.label, '分类名称');
      if (db.categories.some(c => c.label === label)) fail(400, '分类名称已存在');
      const category = { value: id('category'), label, brands: [] }; db.categories.push(category);
      db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: '新增分类', detail: label });
      return { value: category.value, label };
    }],
    ['PUT', '/catalog/categories/:id', (d, h, p) => {
      requirePermission(PERM.TEMPLATE_MANAGE);
      const category = db.categories.find(c => c.value === p.id) || fail(404, '分类不存在');
      const label = text(d.label, '分类名称');
      if (db.categories.some(c => c.value !== p.id && c.label === label)) fail(400, '分类名称已存在');
      const old = category.label; category.label = label; db.auditLogs.unshift({ id: id('a'), time: new Date().toISOString(), operator: getOperator(), action: '修改分类', detail: `${old} → ${label}` }); return { value: category.value, label };
    }],
    ['POST', '/models', d => saveModel(d)],
    ['PUT', '/models/:id', (d, h, p) => saveModel(d, db.models.find(m => m.id === p.id) || fail(404, '型号不存在'))],
    ['POST', '/inbound/identify-model', d => {
      requirePermission(PERM.INBOUND);
      if (!require('../utils/validate').isImei(d.imei)) fail(400, 'IMEI 格式或校验位无效');
      const models = db.models.filter(m => (m.tacs || []).includes(d.imei.slice(0, 8)));
      if (models.length !== 1) return { matched: false, message: '未找到已核验的型号，请手动选择' };
      const { tacs, tacSource, ...model } = models[0];
      return { matched: true, model: clone(model), source: tacSource, message: '已匹配核验记录，请确认实机型号；容量、颜色与机况需另行填写' };
    }]
  ];
};
