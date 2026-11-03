const { fail, text } = require("./core");
const MAX_CENTS = 99999999999999n;
function cents(value, label = "金额") {
  if (!["string", "number"].includes(typeof value))
    fail(400, `${label}格式无效`);
  const input = String(value).trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input))
    fail(400, `${label}需为非负金额，最多两位小数`);
  const [whole, fraction = ""] = input.split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > MAX_CENTS) fail(400, `${label}超出允许范围`);
  return Number(result);
}
function money(value) {
  const n = BigInt(value);
  if (n < 0n || n > MAX_CENTS) fail(400, "金额合计超出允许范围");
  return `${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
function integer(value, label, min = 1, max = 1000) {
  const n = Number(value);
  if (
    !["string", "number"].includes(typeof value) ||
    !/^\d+$/.test(String(value).trim()) ||
    value === "" ||
    value === null ||
    !Number.isInteger(n) ||
    n < min ||
    n > max
  )
    fail(400, `${label}需为 ${min}～${max} 的整数`);
  return n;
}
function date(value, label = "日期") {
  const result = text(value, label, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    Number.isNaN(Date.parse(result)) ||
    new Date(result).toISOString().slice(0, 10) !== result
  )
    fail(400, `${label}格式无效`);
  return result;
}
function flags(
  value,
  base = { showInShop: false, sharePeer: false, shareAgent: false },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        !["showInShop", "sharePeer", "shareAgent"].includes(k) ||
        typeof value[k] !== "boolean",
    )
  )
    fail(400, "分享开关格式无效");
  return { ...base, ...value };
}
module.exports = { cents, money, integer, date, flags };
