/**
 * 手机分类模板。容量、颜色在此只是通用选项，具体型号在型号资料里配置自己的容量和颜色。
 * 发布后以各分类模板版本为准；已入库设备保留入库时的快照。
 */
function fields() {
  const select = (key, label, options, required = false, visibility = ['customer', 'peer']) => ({ key, label, type: 'select', options, required, visibility, filterable: true });
  const text = (key, label, type = 'text', required = false, visibility = ['customer', 'peer']) => ({ key, label, type, required, visibility, filterable: false });
  return [
    select('version', '版本型号', ['国行', '港澳台版', '美版', '日版', '韩版', '其他海外版'], true),
    { ...select('networkLock', '网络锁', ['无锁', '有锁'], true), default: '无锁' },
    select('storage', '存储容量', ['64G', '128G', '256G', '512G', '1T', '2T'], true),
    select('color', '机身颜色', ['黑色', '白色', '银色', '金色', '蓝色', '紫色', '绿色', '红色', '粉色', '橙色', '其他'], true),
    select('grade', '成色', ['准新', '99新', '98新', '97新', '95新', '9成新'], true),
    select('peerGrade', '同行标准', ['L1-靓机', 'L2-小花靓', 'Y1-小花', 'Y2-南宁花'], false, ['peer']),
    select('activation', '激活状态', ['未激活', '已激活'], true),
    text('warrantyUntil', '官方保修到期（无则不填）', 'date'),
    select('idLock', 'ID 锁', ['已退出（无锁）', '有锁'], true),
    select('repairStatus', '拆修情况', ['无拆修', '有拆修'], true),
    text('repairNote', '拆修说明（换过的部件、非原装件）'),
    { ...select('refurbishment', '是否整备', ['无需整备', '正在整备', '整备完成'], true, ['internal']), default: '无需整备' },
    text('store', '所属门店', 'text', false, ['internal']),
    text('system', '系统版本'),
    select('allGreen', '是否全绿', ['爱思全绿', '沙漏全绿', '未检测', '检测异常']),
    { ...text('battery', '电池健康（%）', 'number', true), min: 0, max: 100 },
    { ...text('shopWarranty', '店保期限（天）', 'number'), min: 0 },
    select('warrantyLength', '保修时长', ['无', '30天', '90天', '180天', '365天']),
    text('supplier', '供应商', 'ref', true, ['internal']),
    text('receipt', '收货凭证', 'image', true, ['internal'])
  ];
}

/**
 * 已有数据库的手机模板升级（2026-11-05）：成色去掉“未激活”，版本拆出网络锁，颜色改通用选项，
 * 补激活状态、官方保修、ID 锁、拆修情况。已含 idLock 的模板视为已升级，返回 null。
 */
function upgradePhoneFields(current) {
  if (!Array.isArray(current) || current.some(f => f.key === 'idLock')) return null;
  const next = Object.fromEntries(fields().map(f => [f.key, f]));
  const rename = { '美版无锁': '美版', '其他国家无锁': '其他海外版' };
  const result = [];
  const add = (...keys) => keys.forEach(k => { if (!current.some(f => f.key === k) && !result.some(f => f.key === k)) result.push({ ...next[k] }); });
  for (const f of current) {
    let field = f;
    if (f.key === 'version' && f.type === 'select') field = { ...f, options: [...new Set(f.options.map(o => rename[o] || o))] };
    if (f.key === 'grade' && f.type === 'select') {
      field = { ...f, options: f.options.filter(o => o !== '未激活') };
      if (field.default === '未激活') delete field.default;
    }
    if (f.key === 'color' && f.type === 'select') field = { ...f, options: next.color.options.slice() };
    if (field.default !== undefined && field.type === 'select' && !field.options.includes(field.default)) { field = { ...field }; delete field.default; }
    result.push(field);
    if (f.key === 'version') add('networkLock');
    if (f.key === (current.some(x => x.key === 'peerGrade') ? 'peerGrade' : 'grade')) add('activation', 'warrantyUntil', 'idLock', 'repairStatus', 'repairNote');
  }
  // 原模板缺少锚点字段时，补在凭证类字段之前
  const missing = ['networkLock', 'activation', 'warrantyUntil', 'idLock', 'repairStatus', 'repairNote'].filter(k => !result.some(f => f.key === k));
  if (missing.length) {
    const at = result.findIndex(f => ['supplier', 'receipt'].includes(f.key));
    result.splice(at < 0 ? result.length : at, 0, ...missing.map(k => ({ ...next[k] })));
  }
  return result.length > 50 ? null : result;
}
module.exports = { fields, upgradePhoneFields };
