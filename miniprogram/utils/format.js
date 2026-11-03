/** 显示格式化工具。金额单位统一为“元”，后端如用“分”需在 api 层转换。 */

function money(n, digits) {
  if (n === null || n === undefined || n === '') return '--';
  const num = Number(n);
  if (!Number.isFinite(num)) return '--';
  if (digits === undefined) digits = Math.round(Math.abs(num) * 100) % 100 ? 2 : 0;
  return num.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 金额遮挡：privacy 为 true 时显示 •••• */
function maskMoney(n, privacy, digits) {
  return privacy ? '••••' : money(n, digits);
}

function percent(n, digits = 1) {
  if (n === null || n === undefined) return '--';
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

/** IMEI 脱敏：35****1231（完整 IMEI 不进入任何公开页面） */
function maskImei(imei) {
  if (!imei) return '';
  const s = String(imei);
  if (s.includes('*')) return s;
  return s.length > 6 ? `${s.slice(0, 2)}****${s.slice(-4)}` : s;
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** @param {number|string|Date} t  @param {string} fmt 支持 YYYY MM DD HH mm */
function date(t, fmt = 'YYYY-MM-DD HH:mm') {
  if (!t) return '';
  const d = t instanceof Date ? t : new Date(typeof t === 'string' ? t.replace(/-/g, '/') : t);
  if (Number.isNaN(d.getTime())) return '';
  return fmt
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()))
    .replace('HH', pad(d.getHours()))
    .replace('mm', pad(d.getMinutes()));
}

/** 从状态枚举取 { label, tone } */
function statusMeta(map, key) {
  return (map && map[key]) || { label: key || '--', tone: 'gray' };
}

module.exports = { money, maskMoney, percent, maskImei, date, statusMeta };
