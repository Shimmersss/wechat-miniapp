/**
 * 顾客端公开接口（框架文档 九.1 / 十一）
 * 服务端按访问身份（登录用户 + X-Channel 分享记录）决定返回零售价/同行价/代理分享价，
 * 绝不返回成本、供应商、内部备注、完整 IMEI。
 */
const { http } = require('../../utils/request');

module.exports = {
  /** 首页：banner、当前在售现货数、品牌筛选项 */
  home: () => http.get('/shop/home'),
  /** 商品列表 { keyword, brand, category, condition, page, pageSize } → { list, total } */
  units: (params) => http.get('/shop/units', params),
  /** 单机详情（一机一档），price 字段已由服务端按身份计算 */
  unit: (id, shareId) => http.get(`/shop/units/${id}`,undefined,shareId !== undefined?{header:{'X-Channel':shareId}}:undefined),
  /** 分类树：分类 → 品牌 → 系列 → 型号 */
  categories: () => http.get('/shop/categories'),
  /** 预约可选时段与北京时间日期范围 → {timeSlots,minDate,maxDate,notice}；提交仍需门店确认 */
  contactOptions: () => http.get('/shop/contact-options'),
  /** {requestKey,unitId?,content,phone,name?} → 本人咨询快照；shareId固定本次来源，重试不更换 */
  consult: (data, shareId) => http.post('/shop/consults', data, {loading:true,...(shareId !== undefined?{header:{'X-Channel':shareId}}:{})}),
  /** {requestKey,unitId?,content?,phone,name,date,timeSlot} → 本人预约；不锁库存/价格 */
  appointment: (data, shareId) => http.post('/shop/appointments', data, {loading:true,...(shareId !== undefined?{header:{'X-Channel':shareId}}:{})}),
  /** 代理链接下单 {requestKey,unitId,name,phone,content?} + 代理分享 shareId → 本人订单（kind=order，含 agentOrder 锁定到期时间与分享价）；仅代理链接可下单，锁库期间门店确认成交 */
  order: (data, shareId) => http.post('/shop/orders', data, {loading:true,header:{'X-Channel':shareId}}),
  /** {kind?,status?,page?,pageSize?} → 本人咨询/预约/下单分页，内部备注不返回 */
  requests: params => http.get('/shop/requests',params),
  /** id → 本人记录/公开时间线；其他账号404 */
  request: id => http.get(`/shop/requests/${id}`),
  /** {requestKey,version,reason} → {id,status,version}；结果未知时原样重试 */
  cancelRequest: (id,data) => http.patch(`/shop/requests/${id}/cancel`,data)
};
