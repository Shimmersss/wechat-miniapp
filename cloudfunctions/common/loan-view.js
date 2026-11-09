/** 只返回旧借还接口的白名单字段，设备快照不向客户端透传。 */
const {canSee}=require('./stock-view');
const {PERM}=require('./roles');
function detail(row,user){
 const items=row.items||[],overdue=row.status==='active'&&items.some(i=>i.status==='active')&&row.due_date<new Date(Date.now()+28800000).toISOString().slice(0,10);
 return {id:row.id,no:row.no,type:row.type,counterparty:row.counterparty,phone:row.phone,dueAt:row.due_date,remark:row.remark,status:overdue?'overdue':row.status,storedStatus:row.status,version:row.version,overdue,createdAt:row.created_at,
  items:items.map(i=>{const s=i.snapshot;return {id:i.id,unitId:i.unit_id,name:s.name,modelId:s.modelId,ownership:row.type==='borrow_in'?'borrowed':'own',status:i.status,unitStatus:i.unit_status,returnedAt:i.returned_at,imeiMasked:s.imei1.slice(0,2)+'****'+s.imei1.slice(-4),...(canSee(user,'fullImei')?{imei1:s.imei1,imei2:s.imei2}:{}),canRecheck:i.status==='returned_recheck'&&user.permissions.includes(PERM.ACCEPTANCE)&&user.permissions.includes(PERM.INVENTORY_VIEW)};}),
  timeline:(row.events||[]).map(e=>({id:e.id,action:e.action,version:e.version,reason:e.reason,data:e.data,time:e.created_at,operator:e.operator})),
  photos:(row.attached||[]).map(f=>({fileId:f.id,scope:f.scope,mime:f.mime,mediaType:f.mime.startsWith('video/')?'video':'image',url:f.resolved_url,eventId:f.event_id})),financialPolicy:'none',supportsPayments:false};
}
function view(action,result,user,d){return action==='options'?result:action==='list'?{list:result.rows.map(r=>detail(r,user)),total:Number(result.total),page:d.page,pageSize:d.pageSize}:detail(result,user);}
module.exports={view};
