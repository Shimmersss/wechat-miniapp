/** 维修：真实服务端负责权限、当前版本、成本/报价核算与事务。金额单位为元。 */
const { http } = require("../../utils/request");
module.exports = {
  /** 可分派工程师、安全/成本策略 → {engineers,canManageParts,passwordStorage:false,internalCostPolicy} */
  options: () => http.get("/repair-orders/options"),
  /** {status?,engineerId?,keyword?,waitingParts?,overdue?,page?} → {columns,total,page,pageSize,hasMore}，每页最多200台；未完结单在前，同类按开单时间新→旧 */
  board: (params) => http.get("/repair-orders/board", params),
  /** 同看板过滤 + page/pageSize → 标准分页；工程师只能本人获分派工单 */
  list: (params) => http.get("/repair-orders", params),
  /** 单据/照片/节点/支付/领退料；成本和完整串码按服务端当前权限裁剪 */
  detail: (id) => http.get(`/repair-orders/${id}`),
  /** {requestKey,kind:external|inventory,unitId?,model?,identifier?,customer?,phone?,fault,engineerId?,expectedAt?,photos?:[{fileId}]}；附件须internal，不接受密码 */
  create: (data) => http.post("/repair-orders", data, { loading: true }),
  /** {requestKey,version,reason,diagnosis?,waitingParts?,engineerId?,expectedAt?,fault?,customer?,phone?,photos?}；指派/联系方式另需授权 */
  update: (id, data) =>
    http.put(`/repair-orders/${id}`, data, { loading: true }),
  /** {requestKey,version,reason,amount} → 最新报价版本；需repair:quote，0元报价有效 */
  quote: (id, data) => http.post(`/repair-orders/${id}/quote`, data),
  /** {requestKey,version,reason,quoteVersion,confirmed:true}；本店机须管理授权确认维修方案 */
  confirm: (id, data) => http.post(`/repair-orders/${id}/confirm`, data),
  /** {requestKey,version,reason,to,result?,pickupName?,pickupProof?,warrantyDays?}；完工需取机/交接凭证且回待复检 */
  transition: (id, data) =>
    http.post(`/repair-orders/${id}/transition`, data, { loading: true }),
  /** {requestKey,version,reason,kind:receipt|refund|expense|expense_refund,amount,method,confirmed:true,proof?}；仅记录已实际办理业务，不发起平台扣退款 */
  payment: (id, data) => http.post(`/repair-orders/${id}/payment`, data),
  /** {requestKey,version,reason,partId,quantity}；实际库存扣料，成本由后端分摊 */
  issueParts: (id, data) => http.post(`/repair-orders/${id}/parts/issue`, data),
  /** {requestKey,version,reason,issueId,quantity}；按原领用剩余成本退料，不能超过原数量 */
  returnParts: (id, data) =>
    http.post(`/repair-orders/${id}/parts/return`, data),
  /** {range/from/to,engineerId?} → 实际发生期收支及开/完工指标；成本利润按权限返回 */
  stats: (params) => http.get("/repair-orders/stats", params),
  /** {keyword?,page?,pageSize?} → 配件库存；stockValue仅授权角色返回 */
  parts: (params) => http.get("/repair-parts", params),
  /** {sku,name,unit?} → 新配件，SKU相同且字段相同可重试 */
  createPart: (data) => http.post("/repair-parts", data),
  /** {requestKey,version,reason,quantity,unitCost} → 最新配件库存；需parts:manage及成本权限 */
  receivePart: (id, data) => http.post(`/repair-parts/${id}/receive`, data),
  /** 配件领退/采购流水分页；成本裁剪 */
  partLedger: (id, params) => http.get(`/repair-parts/${id}/ledger`, params),
};
