#!/usr/bin/env node
/** 已部署借还云函数 + 真实微信SDK验收。使用忽略目录中的测试账号；临时切换测试员工为库管，finally恢复原角色/状态及顾客会话。 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const local='.local/cloudbase',login=JSON.parse(fs.readFileSync(local+'/live-login-args.json'))[0];
assert.match(login.phone,/^\d{11}$/);
function control(tool,args){const listing=execFileSync('tcb',['env','list','--json'],{encoding:'utf8'}),envId=JSON.parse(listing.slice(listing.indexOf('{'))).data[0].EnvId;const raw=execFileSync('npx',['-y','mcporter','call','--stdio','npx -y @cloudbase/cloudbase-mcp@latest',tool,'--args',JSON.stringify({...args,envId}),'--output','json'],{encoding:'utf8',maxBuffer:4e6});const r=JSON.parse(raw.slice(raw.indexOf('{')));if(!r.success)throw Error(r.message);return r;}
function evaluate(fn,args=[]){const file=path.join(root,local+'/loans-eval-args.json');fs.writeFileSync(file,JSON.stringify(args),{mode:0o600});const raw=execFileSync('wechatide',['-c','Codex','automation_evaluate','--project',root,'--fn-source',fn,'--args-file',file],{encoding:'utf8',maxBuffer:2e6});const r=JSON.parse(raw.slice(raw.indexOf('{')));assert.equal(r.ok,true);assert.equal(r.result.success,true);return r.result.result.result;}
const request=async function(i){const start=Date.now();const r=await wx.cloud.callFunction({name:i.name||'staff-loans',data:{path:i.path,method:i.method||'GET',data:i.data||{},headers:{Authorization:'Bearer '+wx.getStorageSync('xm_token')}}});return {...r.result,e2eMs:Date.now()-start};};
function call(path,method='GET',data={},name){const r=evaluate(request.toString(),[{path,method,data,name}]);assert.equal(r.code,0,r.message);return r;}
const results={checks:[],timings:[]};const fixture=JSON.parse(fs.readFileSync(local+'/loans-fixture.json'));
const staff=control('queryPgDatabase',{action:'sql',sql:`SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`}).data.rows[0];assert.ok(staff);assert.match(staff.id,/^[0-9a-f-]{36}$/);assert.match(staff.role_key,/^[a-z_]+$/);
fs.writeFileSync(local+'/loans-live-original-staff.json',JSON.stringify(staff),{mode:0o600});
const setRole=(role,status='active')=>control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='${role}',status='${status}' WHERE id='${staff.id}'`});
const imei=()=>{const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){const d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
(async()=>{try{
 setRole('warehouse');
 const session=evaluate((async function(i){const c=async(path,data)=>(await wx.cloud.callFunction({name:'auth',data:{path,method:'POST',data}})).result;await c('/auth/sms-code',{phone:i.phone});const s=await c('/auth/staff-login',{account:i.phone,smsCode:i.code});if(s.code===0){wx.setStorageSync('xm_token',s.data.token);wx.setStorageSync('xm_user',s.data.user);getApp().globalData.user=s.data.user;}return {code:s.code,role:s.data?.user?.role};}).toString(),[login]);assert.equal(session.code,0);assert.equal(session.role,'warehouse');
 for(let i=0;i<3;i++){const r=call('/loans/options');results.timings.push({e2eMs:r.e2eMs,...r.timing});}
 const input={requestKey:'wechat-loan-'+crypto.randomUUID(),type:'borrow_in',devices:[{modelId:fixture.modelId,imei1:imei()}],counterparty:'微信SDK借还验证',phone:login.phone,dueAt:'2030-01-01',reason:'真实微信SDK借入'};
 const o=call('/loans','POST',input).data;assert.equal(o.items[0].unitStatus,'borrowed_in');assert.equal(call('/loans','POST',input).data.id,o.id);results.checks.push('已部署函数真实微信借入与开单幂等');
 const bytes=fs.readFileSync('miniprogram/assets/brands/apple.png');const intent=call('/files/upload-intent','POST',{scope:'internal',size:bytes.length,requestKey:crypto.randomUUID()},'files').data;
 const sent=await fetch(intent.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});assert.ok(sent.ok);const proof=call('/files/'+intent.uploadId+'/complete','POST',{},'files').data;
 const returnBody={requestKey:crypto.randomUUID(),version:o.version,reason:'真实微信逐台交还',items:[{unitId:o.items[0].unitId,condition:'外观功能已检查',photos:[{fileId:proof.fileId}]}]};
 const raced=evaluate((async function(i){return Promise.all([i.body,{...i.body,requestKey:i.otherKey}].map(async data=>(await wx.cloud.callFunction({name:'staff-loans',data:{path:'/loans/'+i.id+'/return',method:'POST',data,headers:{Authorization:'Bearer '+wx.getStorageSync('xm_token')}}})).result));}).toString(),[{id:o.id,body:returnBody,otherKey:crypto.randomUUID()}]);assert.deepEqual(raced.map(r=>r.code).sort(),[0,409]);const closed=raced.find(r=>r.code===0).data;assert.equal(closed.status,'closed');assert.equal(closed.items[0].unitStatus,'returned');assert.ok((await fetch(closed.photos[0].url)).ok);results.checks.push('真实凭证上传、并发归还仅一个成功、借入归还冲销与照片可下载');
 const list=call('/loans','GET',{keyword:o.no}).data;assert.equal(list.total,1);assert.equal(list.list[0].status,'closed');
 const detail=call('/loans/'+fixture.orderId).data;assert.ok(detail.items.length);assert.equal(detail.photos.length,2);assert.ok((await fetch(detail.photos[0].url)).ok);results.checks.push('已部署列表/详情及分页契约，库管可读其他上传者的交接凭证');
 execFileSync('wechatide',['-c','Codex','automation_navigate','--project',root,'--action','navigateTo','--url','/packages/staff/loans/detail?id='+o.id],{stdio:['ignore','ignore','pipe']});
 const page=evaluate('function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,status:p.data.detail?.storedStatus,photos:p.data.detail?.photos?.length,items:p.data.detail?.items?.length};}');assert.equal(page.status,'closed');assert.equal(page.error,'');assert.equal(page.photos,1);results.page=page;results.checks.push('真实借还详情页渲染完结状态、逐台设备与交接照片');
 setRole('sales');const denied=evaluate(request.toString(),[{path:'/loans/'+o.id}]);assert.equal(denied.code,403);const fileDenied=evaluate(request.toString(),[{name:'files',path:'/files/'+proof.fileId}]);assert.equal(fileDenied.code,403);results.checks.push('真实微信会话权限变更即时生效，销售不能读借还单及凭证');
 setRole('warehouse','disabled');assert.equal(evaluate(request.toString(),[{path:'/loans/'+o.id}]).code,403);results.checks.push('测试员工停用后拒绝借还访问');
 results.orderId=o.id;results.unitId=o.items[0].unitId;results.fileId=proof.fileId;
}finally{
 setRole(staff.role_key,staff.status);results.restoredRole=staff.role_key;
 const restored=evaluate((async function(){const r=(await wx.cloud.callFunction({name:'auth',data:{path:'/auth/wx-login',method:'POST',data:{}}})).result;if(r.code===0){wx.setStorageSync('xm_token',r.data.token);wx.setStorageSync('xm_user',r.data.user);getApp().globalData.user=r.data.user;}return {code:r.code,role:r.data?.user?.role};}).toString());assert.equal(restored.code,0);assert.equal(restored.role,'customer');results.restoredSessionRole=restored.role;
 execFileSync('wechatide',['-c','Codex','automation_navigate','--project',root,'--action','switchTab','--url','/pages/shop/index'],{stdio:['ignore','ignore','pipe']});
 fs.writeFileSync(local+'/loans-live-results.json',JSON.stringify(results,null,2),{mode:0o600});
}console.log(JSON.stringify({passed:true,checks:results.checks,timings:results.timings,page:results.page,restoredRole:results.restoredRole,restoredSessionRole:results.restoredSessionRole}));})().catch(e=>{console.error(e.message);process.exitCode=1;});
