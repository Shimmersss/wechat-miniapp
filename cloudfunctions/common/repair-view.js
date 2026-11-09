const {canSee}=require('./stock-view');
const {PERM}=require('./roles');
const has=(u,p)=>u.permissions.includes(p),cost=u=>canSee(u,'cost'),profit=u=>canSee(u,'profit')&&has(u,PERM.PROFIT_VIEW);
const part=(r,u)=>({id:r.id,sku:r.sku,name:r.name,unit:r.unit,quantity:r.quantity,version:r.version,active:r.active,...(cost(u)?{stockValue:Number(r.stock_value)}:{})});
function detail(r,u){
 return {id:r.id,no:r.no,kind:r.kind,unitId:r.unit_id,model:r.model,customer:r.customer,phone:r.phone,imeiMasked:r.identifier?(r.identifier.length>6?r.identifier.slice(0,2)+'****'+r.identifier.slice(-4):'***'):'',...(canSee(u,'fullImei')?{identifier:r.identifier}:{}),fault:r.fault,engineerId:r.engineer_id,engineer:r.engineer||'未分派',expectedAt:r.expected_date,status:r.status,version:r.version,diagnosis:r.diagnosis,waitingParts:r.waiting_parts,quote:r.quote===null?null:Number(r.quote),quoteVersion:r.quote_version,confirmedVersion:r.confirmed_version,warrantyDays:r.warranty_days,pickupName:r.pickup_name,createdAt:r.created_at,completedAt:r.completed_at,overdue:!['completed','cancelled'].includes(r.status)&&!!r.expected_date&&r.expected_date<new Date(Date.now()+28800000).toISOString().slice(0,10),
 files:(r.attached||[]).map(f=>({fileId:f.id,scope:f.scope,mime:f.mime,mediaType:f.mime.startsWith('video/')?'video':'image',url:f.resolved_url,purpose:f.purpose})),received:Number(r.totals.received),...(cost(u)?{partsCost:Number(r.totals.parts),expenses:Number(r.totals.expenses),costAllocation:r.allocation}:{}),...(profit(u)?{profit:r.kind==='external'?Math.round((Number(r.totals.received)-Number(r.totals.parts)-Number(r.totals.expenses))*100)/100:null}:{}),
 canManage:has(u,PERM.REPAIR_HANDLE)&&(has(u,PERM.REPAIR_ASSIGN)||r.engineer_id===u.id),canQuote:has(u,PERM.REPAIR_QUOTE),canAssign:has(u,PERM.REPAIR_ASSIGN),canCash:has(u,PERM.REPAIR_CASH),canRefund:has(u,PERM.REPAIR_CASH)&&has(u,PERM.REFUND),canExpense:has(u,PERM.REPAIR_CASH)&&cost(u),
 timeline:(r.events||[]).map(e=>({id:e.id,action:e.action,from:e.from_status,to:e.to_status,version:e.version,note:e.note,time:e.created_at,operator:e.operator,data:e.public_data,...(cost(u)?{costData:e.internal_data}:{})})),
 parts:(r.parts||[]).map(p=>({id:p.id,partId:p.part_id,name:p.name,sku:p.sku,quantity:p.quantity,returned:Number(p.returned),...(cost(u)?{cost:Number(p.cost_amount)}:{})})),
 payments:(r.payments||[]).filter(p=>cost(u)||!p.kind.startsWith('expense')).map(p=>({id:p.id,kind:p.kind,amount:Number(p.amount),method:p.method,reason:p.reason,time:p.created_at,operator:p.operator}))};
}
function view(action,r,u,d){
 if(action==='options')return r;
 if(action==='stats')return {created:Number(r.created),completed:Number(r.completed),completionRate:Number(r.created)?Number(r.cohort_completed)/Number(r.created):0,avgHours:Number(r.avg_hours),revenue:Number(r.revenue),...(cost(u)?{partsCost:Number(r.parts),expenses:Number(r.expenses),internalRepairCost:Number(r.internal_cost)}:{}),...(profit(u)?{profit:Math.round((Number(r.revenue)-Number(r.parts)-Number(r.expenses))*100)/100}:{}),definition:'开单完成率按本期开单队列；均时按本期完工。收入/退款、配件领退和费用按发生期统计；自有机成本另列，避免重复计入对客维修毛利。'};
 if(action==='parts.list')return {list:r.rows.map(x=>part(x,u)),total:Number(r.total),page:d.page,pageSize:d.pageSize};
 if(['parts.create','parts.receive'].includes(action))return part(r,u);
 if(action==='parts.ledger')return {list:r.rows.map(p=>({id:p.id,kind:p.kind,quantity:p.quantity,time:p.created_at,...(u.permissions.some(k=>[PERM.REPAIR_ASSIGN,PERM.REPAIR_CASH,PERM.PARTS_MANAGE].includes(k))||p.engineer_id===u.id?{orderId:p.order_id,issueId:p.issue_id,reason:p.reason,operator:p.operator}:{}),...(cost(u)?{cost:Number(p.cost_amount)}:{})})),total:Number(r.total),page:d.page,pageSize:d.pageSize};
 if(action==='list'||action==='board'){const list=r.rows.map(x=>detail(x,u));if(action==='list')return {list,total:Number(r.total),page:d.page,pageSize:d.pageSize};const columns=Object.fromEntries(['pending_check','checking','pending_confirm','repairing','pending_pickup','completed','cancelled'].map(k=>[k,[]]));for(const x of list)columns[x.status].push(x);return {columns,total:Number(r.total),page:d.page,pageSize:d.pageSize,hasMore:d.offset+list.length<Number(r.total)};}
 return detail(r,u);
}
module.exports={view};
