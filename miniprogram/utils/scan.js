/** 扫码封装：IMEI 条码 / 运单号 / 设备标签 */
const { isImei, normalizeSerial } = require('./validate');
const { decodeDeviceLabel } = require('./device-label-code');

function scan({ onlyFromCamera = true, scanType = ['barCode', 'qrCode'] } = {}) {
  return new Promise((resolve, reject) => {
    wx.scanCode({
      onlyFromCamera,
      scanType,
      success: (res) => resolve((res.result || '').trim()),
      fail: reject
    });
  });
}

/** 扫 IMEI：包装盒条码可能带前缀，提取 15 位数字 */
function scanImei() {
  return scan({ scanType: ['barCode', 'qrCode'] }).then((raw) => {
    const match = raw.match(/\d{15}/);
    const imei = match ? match[0] : raw;
    return { imei, valid: isImei(imei), raw };
  });
}

/** 扫序列号：条码内容常带“SN:”“S/N”前缀，去掉后转大写 */
function scanSerial() {
  return scan({ scanType: ['barCode', 'qrCode'] }).then((raw) => {
    const value = String(raw || '').trim().replace(/^(S\/?N|SERIAL(\s*NO\.?)?)\s*[:：]?\s*/i, '');
    return { serialNo: normalizeSerial(value), raw };
  });
}

/** 内部设备标签只编码设备 ID；IMEI 文本标签去掉明确前缀，不截取任意长数字。 */
function unitCode(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/^IMEI[12]?\s*[:：]?\s*(\d{15})$/i);
  return match ? match[1] : decodeDeviceLabel(value);
}
module.exports = { scan, scanImei, scanSerial, unitCode };
