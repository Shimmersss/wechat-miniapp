/** 按用户提供的入库参考图初始化；发布后以各型号模板版本为准。 */
function fields() {
  const select = (key, label, options, required = false, visibility = ['customer', 'peer']) => ({ key, label, type: 'select', options, required, visibility, filterable: true });
  const text = (key, label, type = 'text', required = false, visibility = ['customer', 'peer']) => ({ key, label, type, required, visibility, filterable: false });
  return [
    select('version', '版本型号', ['国行', '港澳台版', '美版无锁', '其他国家无锁'], true),
    select('storage', '存储容量', ['128G', '256G', '512G', '1T', '2T'], true),
    select('color', '机身颜色', ['星宇橙色', '深蓝色', '银色', '黑色', '白色'], true),
    select('grade', '成色', ['准新', '未激活', '99新', '98新', '97新', '95新', '9成新'], true),
    select('peerGrade', '同行标准', ['L1-靓机', 'L2-小花靓', 'Y1-小花', 'Y2-南宁花'], false, ['peer']),
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
module.exports = { fields };
