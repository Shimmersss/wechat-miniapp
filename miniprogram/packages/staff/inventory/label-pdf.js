const patterns = require('./vendor/jsbarcode-code128');
const { encodeDeviceLabel } = require('../../../utils/device-label-code');
const { money } = require('../../../utils/format');

const WIDTH = 720;
const HEIGHT = 480;
const LABEL_MM = [60, 40];
const PAPERS = { '60x40': LABEL_MM, '80x40': [80, 40], A4: [210, 297] };

function deviceBarcode(label) {
  const code = String(label?.qrcodeText || '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(code) || code !== String(label.unitId)) {
    throw new Error('设备标签缺少有效的扫码编号');
  }
  const value = encodeDeviceLabel(code);
  const pairs = /^(?:\d{2})+$/.test(value);
  const words = pairs
    ? value.match(/\d{2}/g).map(Number)
    : Array.from(value, char => char.charCodeAt(0) - 32);
  const start = pairs ? 105 : 104;
  const checksum = words.reduce((sum, word, i) => sum + word * (i + 1), start) % 103;
  const bits = [start, ...words, checksum, 106].map(word => patterns[word]).join('');
  const bars = Array.from(bits.matchAll(/1+/g), match => [match.index, match[0].length]);
  return { bars, modules: bits.length };
}

function barcodePreview(label) {
  const { bars, modules } = deviceBarcode(label);
  const width = (modules + 24) * 3;
  const height = 96;
  const canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000';
  for (const [x, w] of bars) ctx.fillRect((x + 12) * 3, 0, w * 3, height);
  return canvas.toDataURL('image/png');
}

function fitText(ctx, text, x, y, maxWidth, size, bold = false) {
  const chars = Array.from(String(text));
  ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`;
  let line = chars.join('');
  while (chars.length && ctx.measureText(line).width > maxWidth) {
    chars.pop();
    line = chars.join('') + '…';
  }
  ctx.fillText(line, x, y);
}

function drawLabel(ctx, label, brandName) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  fitText(ctx, brandName, 32, 24, 656, 28, true);
  fitText(ctx, label.name || '设备标签', 32, 66, 656, 44, true);
  const details = [label.storage, label.ram && '内存 ' + label.ram, label.grade].filter(Boolean).join(' · ');
  fitText(ctx, details, 32, 130, 656, 30);
  const price = label.retail == null ? '—' : '¥' + money(label.retail);
  fitText(ctx, '零售 ' + price, 32, 180, 656, 39, true);
  const masked = [label.serialMasked && 'SN ' + label.serialMasked,
    label.imeiMasked && 'IMEI ' + label.imeiMasked].filter(Boolean).join('   ');
  fitText(ctx, masked, 32, 236, 656, 25);
  fitText(ctx, '编号 ' + label.unitId, 32, 432, 656, 22);
}

// JPEG 的 ASCIIHex 表示使 PDF 内容全为 ASCII，字符串偏移等于写入后的字节偏移。
function makePdf(jpeg, barcode, paper) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('标签图像导出失败');
  const pt = mm => (mm * 72 / 25.4).toFixed(3);
  const [w, h] = LABEL_MM;
  const [pw, ph] = PAPERS[paper];
  const image = Array.from(jpeg, byte => byte.toString(16).padStart(2, '0')).join('') + '>';
  const left = (pw - w) / 2;
  const bottom = (ph - h) / 2;
  const wide = paper === '80x40';
  // 80 毫米版为 203 DPI 打印机留出每个窄条两个点的宽度。
  const moduleWidth = Math.min(wide ? 2 * 25.4 / 203 : 0.4,
    ((wide ? pw : w) - 2) / (barcode.modules + 24));
  const barLeft = (pw - moduleWidth * barcode.modules) / 2;
  const bars = barcode.bars.map(([x, width]) =>
    `${pt(barLeft + x * moduleWidth)} ${pt(bottom + 5.2)} ${pt(width * moduleWidth)} ${pt(11)} re`
  ).join('\n');
  // 把条形码写为矢量，打印时不受 JPEG 压缩影响，左右各保留至少 12 个模块的留白。
  const content = `q ${pt(w)} 0 0 ${pt(h)} ${pt(left)} ${pt(bottom)} cm /Label Do Q\n0 g\n${bars}\nf\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(pw)} ${pt(ph)}] /Resources << /XObject << /Label 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width ${WIDTH} /Height ${HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${image.length} >>\nstream\n${image}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
}

async function writeLabelPdf(label, brandName, paper) {
  if (!wx.createOffscreenCanvas) throw new Error('请更新微信后导出 PDF');
  if (!Object.prototype.hasOwnProperty.call(PAPERS, paper)) throw new Error('请选择标签纸型');
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: WIDTH, height: HEIGHT });
  const barcode = deviceBarcode(label);
  drawLabel(canvas.getContext('2d'), label, brandName);
  const jpeg = canvas.toDataURL('image/jpeg', 0.95).match(/^data:image\/jpeg;base64,(.+)$/)?.[1];
  if (!jpeg) throw new Error('标签图像导出失败');
  const pdf = makePdf(new Uint8Array(wx.base64ToArrayBuffer(jpeg)), barcode, paper);
  const filePath = wx.env.USER_DATA_PATH + '/设备标签-' + paper + '.pdf';
  await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({
    filePath, data: pdf, encoding: 'utf8', success: resolve, fail: reject
  }));
  return filePath;
}

module.exports = { deviceBarcode, barcodePreview, writeLabelPdf };
