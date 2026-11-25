const qrcode = require('./vendor/qrcode');
const { money } = require('../../../utils/format');

const WIDTH = 720;
const HEIGHT = 480;
const LABEL_MM = [60, 40];
const A4_MM = [210, 297];

function deviceQr(label) {
  const code = String(label?.qrcodeText || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || code !== String(label.unitId)) {
    throw new Error('设备标签缺少有效的扫码编号');
  }
  const qr = qrcode(0, 'M');
  qr.addData(code);
  qr.make();
  return qr;
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
  const qr = deviceQr(label);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  fitText(ctx, brandName, 32, 30, 656, 28, true);
  fitText(ctx, label.name || '设备标签', 32, 78, 656, 44, true);
  fitText(ctx, [label.storage, label.ram && '内存 ' + label.ram].filter(Boolean).join(' · '), 32, 146, 390, 30);
  fitText(ctx, label.grade ?? '', 32, 194, 390, 30);
  const price = label.retail == null ? '—' : '¥' + money(label.retail);
  fitText(ctx, '零售 ' + price, 32, 250, 390, 39, true);
  if (label.serialMasked) fitText(ctx, 'SN ' + label.serialMasked, 32, 318, 390, 25);
  if (label.imeiMasked) fitText(ctx, 'IMEI ' + label.imeiMasked, 32, 354, 390, 25);
  fitText(ctx, '编号 ' + label.unitId, 32, 427, 656, 22);

  const modules = qr.getModuleCount();
  const cell = Math.floor(252 / (modules + 8));
  const left = 430 + Math.floor((258 - (modules + 8) * cell) / 2) + 4 * cell;
  const top = 145 + 4 * cell;
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) ctx.fillRect(left + col * cell, top + row * cell, cell, cell);
    }
  }
}

// JPEG 的 ASCIIHex 表示使 PDF 内容全为 ASCII，字符串偏移等于写入后的字节偏移。
function makePdf(jpeg, a4 = false) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('标签图像导出失败');
  const pt = mm => (mm * 72 / 25.4).toFixed(3);
  const [w, h] = LABEL_MM;
  const [pw, ph] = a4 ? A4_MM : LABEL_MM;
  const image = Array.from(jpeg, byte => byte.toString(16).padStart(2, '0')).join('') + '>';
  const content = `q ${pt(w)} 0 0 ${pt(h)} ${pt((pw - w) / 2)} ${pt((ph - h) / 2)} cm /Label Do Q\n`;
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

async function writeLabelPdf(label, brandName, a4) {
  if (!wx.createOffscreenCanvas) throw new Error('请更新微信后导出 PDF');
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: WIDTH, height: HEIGHT });
  drawLabel(canvas.getContext('2d'), label, brandName);
  const jpeg = canvas.toDataURL('image/jpeg', 0.95).match(/^data:image\/jpeg;base64,(.+)$/)?.[1];
  if (!jpeg) throw new Error('标签图像导出失败');
  const pdf = makePdf(new Uint8Array(wx.base64ToArrayBuffer(jpeg)), a4);
  const filePath = wx.env.USER_DATA_PATH + '/设备标签-' + (a4 ? 'A4' : '60x40') + '.pdf';
  await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({
    filePath, data: pdf, encoding: 'utf8', success: resolve, fail: reject
  }));
  return filePath;
}

module.exports = { deviceQr, writeLabelPdf };
