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

module.exports = { isImei, isPhone, isTrackingNo, required };
