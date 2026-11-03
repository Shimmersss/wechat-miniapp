/** 员工咨询/预约跟进：每次由服务端核验consult:manage与员工身份。 */
const {http}=require('../../utils/request');
module.exports={
 /** {kind?,status?,keyword?,page?,pageSize?} → 授权顾客记录分页 */
 list: params=>http.get('/customer-requests',params),
 /** id → 联系方式/内部跟进时间线/可执行状态/是否可开收银单 */
 detail: id=>http.get(`/customer-requests/${id}`),
 /** {requestKey,version,status,reason} → {id,status,version}；内部原因只返回获授权员工 */
 updateStatus: (id,data)=>http.patch(`/customer-requests/${id}/status`,data)
};
