/** 表单校验工具。前端校验只为体验，唯一性等规则必须由服务端再校验。 */

/** IMEI：15 位数字 + Luhn 校验位 */
function isImei(value) {
  const s = String(value || '').trim();
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    let d = Number(s[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** 序列号规范化：去首尾空格、转大写 */
function normalizeSerial(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * 序列号校验，与服务端 stock_serial 一致：4～40 位字母、数字或连字符；
 * 15 位且通过 IMEI 校验的串视为 IMEI。返回空串表示通过，否则返回提示。
 */
function serialError(value) {
  const s = normalizeSerial(value);
  if (!/^[A-Z0-9-]{4,40}$/.test(s)) return '序列号需为 4～40 位字母、数字或连字符';
  if (isImei(s)) return '这是 IMEI，请填写到 IMEI 栏';
  return '';
}

function isSerial(value) {
  return !serialError(value);
}

/** 无序列号原因：2～100 字 */
function noSerialReasonError(value) {
  const s = String(value || '').trim();
  return s.length >= 2 && s.length <= 100 ? '' : '没有序列号时请填写原因（2～100字）';
}

function isPhone(value) {
  return /^1\d{10}$/.test(String(value || '').trim());
}

/** 运单号：只做长度/字符的粗校验 */
function isTrackingNo(value) {
  return /^[A-Za-z0-9]{8,30}$/.test(String(value || '').trim());
}

/**
 * 通用必填校验
 * @param {object} form
 * @param {Array<[string, string]>} rules [字段名, 提示文案]
 * @returns {string} 第一条错误；无错误返回空串
 */
function required(form, rules) {
  const miss = rules.find(([key]) => form[key] === undefined || form[key] === null || String(form[key]).trim() === '');
  return miss ? miss[1] : '';
}

/** 按表单顺序返回第一处错误。校验器接收字段值和整份表单，返回提示或空串。 */
function firstError(rules, form) {
  for (const [field, validate] of rules) {
    const message = validate(form[field], form);
    if (message) return { field, message };
  }
  return null;
}

function showFieldError(page, error) {
  page.setData({ errors: error ? { [error.field]: error.message } : {} }, () => {
    if (error) wx.pageScrollTo({ selector: '#field-' + error.field, offsetTop: -16, duration: 200 });
  });
  return !!error;
}

module.exports = { firstError, showFieldError, isImei, normalizeSerial, serialError, isSerial, noSerialReasonError, isPhone, isTrackingNo, required };
