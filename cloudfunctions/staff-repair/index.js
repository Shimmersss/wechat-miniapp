const moduleStarted=process.hrtime.bigint();
const {createHandler,rpc}=require('./shared/gateway');
const {requireUser}=require('./shared/identity');
const {prepare}=require('./shared/repair-input');
const {view}=require('./shared/repair-view');
const {resolveFiles}=require('./shared/stock-files');
const routes=[['GET','/repair-orders/options','options'],['GET','/repair-orders/board','board'],['GET','/repair-orders/stats','stats'],['GET','/repair-orders','list'],['POST','/repair-orders','create'],['GET','/repair-orders/:id','get'],['PUT','/repair-orders/:id','update'],...['quote','confirm','payment','transition'].map(k=>['POST','/repair-orders/:id/'+k,k]),['POST','/repair-orders/:id/parts/issue','issue'],['POST','/repair-orders/:id/parts/return','return_parts'],['GET','/repair-parts','parts.list'],['POST','/repair-parts','parts.create'],['POST','/repair-parts/:id/receive','parts.receive'],['GET','/repair-parts/:id/ledger','parts.ledger']];
exports.main=require('./shared/startup-timing')(createHandler(routes.map(([method,path,action])=>[method,path,async ctx=>{
 const user=await requireUser(ctx),d=prepare(action,ctx.data,ctx.params.id,user);
 const result=await rpc('api_repairs',{p_action:action,p_id:ctx.params.id||null,p_data:d,p_user:user,p_request_id:ctx.requestId,p_policy:process.env.REPAIR_INTERNAL_COST_POLICY||'capitalize'});
 await resolveFiles(result,user);return view(action,result,user,d);
}])),moduleStarted);
