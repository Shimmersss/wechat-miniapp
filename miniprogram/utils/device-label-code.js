// 42 位数字以 Code 128 C 编码比直接打印含连字符的 UUID 短。
// 预留 98 前缀，长度超过设备序列号上限 40 位，不会截取或改变已有串码。
const PREFIX = '98';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function encodeDeviceLabel(unitId) {
  const id = String(unitId || '');
  if (!UUID.test(id)) return id;
  return PREFIX + BigInt('0x' + id.replace(/-/g, '')).toString(10).padStart(40, '0');
}

function decodeDeviceLabel(code) {
  if (code.length !== 42 || !code.startsWith(PREFIX) || !/^[0-9]+$/.test(code)) {
    return code;
  }
  const hex = BigInt(code.slice(PREFIX.length)).toString(16);
  if (hex.length > 32) return code;
  return hex.padStart(32, '0').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}

module.exports = { encodeDeviceLabel, decodeDeviceLabel };
