const moduleStarted=process.hrtime.bigint();
const {createHandler,rpc,fail}=require('./shared/gateway');
const {requireUser}=require('./shared/identity');
const {PERM}=require('./shared/roles');
const {prepare}=require('./shared/loan-input');
const {view}=require('./shared/loan-view');
const {resolveFiles}=require('./shared/stock-files');
const routes=[['GET','/loans/options','options'],['GET','/loans','list'],['POST','/loans','create'],['GET','/loans/:id','get'],['POST','/loans/:id/return','return'],['POST','/loans/:id/recheck','recheck']];
exports.main=require('./shared/startup-timing')(createHandler(routes.map(([method,path,action])=>[method,path,async ctx=>{
 const user=await requireUser(ctx);if(!user.staffNo||!user.permissions.includes(PERM.LOAN_MANAGE))fail(403,'仅有借还权限的员工可管理借还');
 const d=prepare(action,ctx.data,ctx.params.id,user);
 const result=await rpc('api_loans',{p_action:action,p_id:ctx.params.id||null,p_data:d,p_user:user,p_request_id:ctx.requestId});
 await resolveFiles(result,user);return view(action,result,user,d);
}])),moduleStarted);
