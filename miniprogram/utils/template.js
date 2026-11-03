/** 模板协议校验：前端提供即时提示，mock/后端仍须独立校验。 */
const TYPES = ['text', 'number', 'select', 'boolean', 'ref', 'image'];
const INTERNAL_KEYS = ['supplier', 'receipt', 'internalNote'];
function validateFields(fields) {
  if (!Array.isArray(fields) || !fields.length || fields.length > 50) return '模板需包含 1～50 个字段';
  const keys = new Set();
  for (const f of fields) {
    if (!f || typeof f !== 'object') return '字段格式无效';
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(f.key || '')) return '字段标识须以小写字母开头，限 40 位字母、数字或下划线';
    if (['constructor', 'prototype', '__proto__', 'imei1', 'imei2', 'cost', 'retail', 'wholesale', 'agentBase', 'flags'].includes(f.key)) return '字段标识为系统保留名称';
    if (keys.has(f.key)) return '字段标识不能重复';
    keys.add(f.key);
    if (typeof f.label !== 'string' || !f.label.trim() || f.label.length > 30) return '字段名称需为 1～30 个字符';
    if (!TYPES.includes(f.type)) return '不支持的字段类型';
    if (typeof f.required !== 'boolean' || typeof f.filterable !== 'boolean') return '请设置必填与筛选规则';
    if (!Array.isArray(f.visibility) || !f.visibility.length || f.visibility.some(v => !['customer', 'peer', 'internal'].includes(v))) return '请选择有效的可见范围';
    if (f.visibility.includes('internal') && f.visibility.length > 1) return '仅内部字段不能同时对外展示';
    if (INTERNAL_KEYS.includes(f.key) && (f.visibility.length !== 1 || f.visibility[0] !== 'internal')) return '供应商、凭证、内部备注只能内部可见';
    if (f.type === 'select' && (!Array.isArray(f.options) || !f.options.length || f.options.length > 50 || f.options.some(v => typeof v !== 'string' || !v.trim()) || new Set(f.options).size !== f.options.length)) return '选项需为 1～50 个不重复的非空文本';
    if (f.type === 'number' && (['min', 'max'].some(k => f[k] !== undefined && (typeof f[k] !== 'number' || !Number.isFinite(f[k]))) || (f.min !== undefined && f.max !== undefined && f.min > f.max))) return '数字范围无效';
    const value = f.default;
    if (value !== undefined && value !== '') {
      if (f.type === 'number' && (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value)))) return '数字字段默认值必须是有效数字';
      if (f.type === 'number' && ((f.min !== undefined && Number(value) < f.min) || (f.max !== undefined && Number(value) > f.max))) return '默认值超出数字范围';
      if (['text', 'ref'].includes(f.type) && typeof value !== 'string') return '文本字段默认值必须为文本';
      if (f.type === 'boolean' && typeof value !== 'boolean') return '开关默认值必须为是或否';
      if (f.type === 'select' && !f.options.includes(value)) return '默认值必须属于选项';
      if (f.type === 'image') return '图片字段不能设置默认值';
    }
  }
  return '';
}
function initialValues(fields) {
  const values = {};
  fields.forEach(f => { values[f.key] = f.type === 'image' ? [] : f.default !== undefined ? f.default : f.type === 'boolean' ? false : ''; });
  return values;
}
function validateValues(fields, values) {
  for (const f of fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
    if (empty) { if (f.required) return `请填写${f.label}`; continue; }
    if (f.type === 'number' && (!['string', 'number'].includes(typeof v) || !Number.isFinite(Number(v)))) return `${f.label}必须为数字`;
    if (f.type === 'number' && ((f.min !== undefined && Number(v) < f.min) || (f.max !== undefined && Number(v) > f.max))) return `${f.label}超出允许范围`;
    if (f.type === 'select' && !f.options.includes(v)) return `请选择有效的${f.label}`;
    if (['text', 'ref'].includes(f.type) && typeof v !== 'string') return `${f.label}必须为文本`;
    if (f.type === 'boolean' && typeof v !== 'boolean') return `${f.label}必须为是或否`;
    if (f.type === 'image' && (!Array.isArray(v) || v.some(x => !x || !x.fileId))) return `请上传${f.label}`;
  }
  return '';
}
module.exports = { TYPES, validateFields, initialValues, validateValues };
