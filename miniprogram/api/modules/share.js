/**
 * 分享（框架文档 7.1）：服务端生成分享记录，绑定渠道、分享人、价格版本与有效期。
 * 前端只拿 shareId 拼路径，不在链接里放价格。
 */
const { http } = require('../../utils/request');

module.exports = {
  /** { unitId?:string, unitIds?:string[], channel: 'customer'|'peer'|'agent' } → { shareId, path, title, price, imageUrl, expireAt } */
  createLink: (data) => http.post('/share/links', data),
  /** shareId → 已核验的公开商品与渠道价格；无权/撤销/失效明确报错 */
  resolve: (shareId) => http.get(`/shop/shares/${shareId}`),
  /** {reason} → {revoked:true}，仅分享创建者可撤销 */
  revoke: (shareId, data) => http.patch(`/share/links/${shareId}/revoke`, data),
  /** 海报数据 → {units,expireAt,qrcode:{mime,base64}|null,qrcodeStatus,message?}；缺外部凭据时不返回假小程序码 */
  poster: (shareId) => http.get(`/share/links/${shareId}/poster`),
  /** 分享文案 */
  copywriting: (shareId) => http.get(`/share/links/${shareId}/copywriting`)
};
