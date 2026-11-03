/** 出借不计销售；借入为外部货权。所有状态/库存/版本由服务端决定，金额单位元。 */
const {http}=require('../../utils/request');
module.exports={
 /** → {financialPolicy:'none',supportsPayments:false,borrowedSalesEnabled:false,maxItems}；首期不收押金/逾期费/赔偿（框架文档 十三.3） */
 options:()=>http.get('/loans/options'),
 /** {type?,status?:active|overdue|returned_recheck|closed,keyword?,page?,pageSize?} → 标准分页；逾期按北京时间动态计算；returned_recheck 表示任一设备已归还待复检（含部分归还的进行中单据） */
 list:params=>http.get('/loans',params),
 /** → 当前版本、逐台状态/设备快照、归还检查时间线及内部交接凭证；完整串码按权限裁剪 */
 detail:id=>http.get(`/loans/${id}`),
 /** {requestKey,type,counterparty,phone,dueAt,reason,remark?,photos?,unitIds?:[id],devices?:[{modelId,imei1,imei2?,condition?,description?}]} → 单据；每单1～50台，出借用unitIds，借入用devices；未确认收费非零返回503 */
 create:data=>http.post('/loans',data,{loading:true}),
 /** {requestKey,version,reason,items:[{unitId,condition,damage?,photos:[{fileId}]}]} → 部分/全部归还；出借回待复检，借入冲销；凭证必须internal */
 markReturned:(id,data)=>http.post(`/loans/${id}/return`,data,{loading:true}),
 /** {requestKey,version,reason,unitIds} → 核验已有库存复检流水后完结对应出借；不能用pass:true跳过实际模板复检，不改变库存状态 */
 recheck:(id,data)=>http.post(`/loans/${id}/recheck`,data,{loading:true})
};
