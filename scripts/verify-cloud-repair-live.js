#!/usr/bin/env node
/** 已部署维修云函数 + 真实微信SDK验收。使用忽略目录中的测试账号；临时切换测试员工为工程师/老板，finally恢复原角色/状态及顾客会话。 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const local='.local/cloudbase',login=JSON.parse(fs.readFileSync(local+'/live-login-args.json'))[0];
assert.match(login.phone,/^\d{11}$/);
function control(tool,args){const listing=execFileSync('tcb',['env','list','--json'],{encoding:'utf8'}),envId=JSON.parse(listing.slice(listing.indexOf('{'))).data[0].EnvId;const raw=execFileSync('npx',['-y','mcporter','call','--stdio','npx -y @cloudbase/cloudbase-mcp@latest',tool,'--args',JSON.stringify({...args,envId}),'--output','json'],{encoding:'utf8',maxBuffer:4e6});const r=JSON.parse(raw.slice(raw.indexOf('{')));if(!r.success)throw Error(r.message);return r;}
function evaluate(fn,args=[]){const file=path.join(root,local+'/repair-eval-args.json');fs.writeFileSync(file,JSON.stringify(args),{mode:0o600});const raw=execFileSync('wechatide',['-c','Codex','automation_evaluate','--project',root,'--fn-source',fn,'--args-file',file],{encoding:'utf8',maxBuffer:2e6});const r=JSON.parse(raw.slice(raw.indexOf('{')));assert.equal(r.ok,true);assert.equal(r.result.success,true);return r.result.result.result;}
const request=async function(i){const start=Date.now();const r=await wx.cloud.callFunction({name:i.name||'staff-repair',data:{path:i.path,method:i.method||'GET',data:i.data||{},headers:{Authorization:'Bearer '+wx.getStorageSync('xm_token')}}});return {...r.result,e2eMs:Date.now()-start};};
function call(path,method='GET',data={},name){const r=evaluate(request.toString(),[{path,method,data,name}]);assert.equal(r.code,0,r.message);return r;}
const results={checks:[],timings:[]};const fixture=JSON.parse(fs.readFileSync(local+'/repair-fixture.json'));
const staff=control('queryPgDatabase',{action:'sql',sql:`SELECT id,role_key,status FROM staff WHERE phone='${login.phone}'`}).data.rows[0];assert.ok(staff);assert.match(staff.id,/^[0-9a-f-]{36}$/);assert.match(staff.role_key,/^[a-z_]+$/);
fs.writeFileSync(local+'/repair-live-original-staff.json',JSON.stringify(staff),{mode:0o600});
const setRole=(role,status='active')=>control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='${role}',status='${status}' WHERE id='${staff.id}'`});
const imei=()=>{const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){const d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
(async()=>{try{
 setRole('engineer');
 const session=evaluate((async function(i){const c=async(path,data)=>(await wx.cloud.callFunction({name:'auth',data:{path,method:'POST',data}})).result;await c('/auth/sms-code',{phone:i.phone});const s=await c('/auth/staff-login',{account:i.phone,smsCode:i.code});if(s.code===0){wx.setStorageSync('xm_token',s.data.token);wx.setStorageSync('xm_user',s.data.user);getApp().globalData.user=s.data.user;}return {code:s.code,role:s.data?.user?.role};}).toString(),[login]);assert.equal(session.code,0);assert.equal(session.role,'engineer');
 for(let i=0;i<3;i++){const r=call('/repair-orders/options');results.timings.push({e2eMs:r.e2eMs,...r.timing});assert.equal(r.data.passwordStorage,false);}
 const bytes=fs.readFileSync('miniprogram/assets/brands/apple.png'),intent=call('/files/upload-intent','POST',{scope:'internal',size:bytes.length,requestKey:crypto.randomUUID()},'files').data;
 const sent=await fetch(intent.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});assert.ok(sent.ok);const proof=call('/files/'+intent.uploadId+'/complete','POST',{},'files').data;
 const input={requestKey:'wechat-repair-'+crypto.randomUUID(),kind:'external',model:'真实微信维修验证机',identifier:imei(),customer:'微信验证顾客',phone:login.phone,expectedAt:'2020-01-01',fault:'无法充电',photos:[{fileId:proof.fileId}]};
 let o=call('/repair-orders','POST',input).data;assert.equal(o.status,'pending_check');assert.equal(o.partsCost,undefined);assert.equal(call('/repair-orders','POST',input).data.id,o.id);
 const act=(a,data={})=>{const d={requestKey:crypto.randomUUID(),version:o.version,reason:'真实微信维修处理',...data};const r=call('/repair-orders/'+o.id+(a==='update'?'':'/'+a),a==='update'?'PUT':'POST',d);o=r.data;return o;};
 act('transition',{to:'checking'});act('update',{diagnosis:'检测确认充电接口损坏'});
 const deniedQuote=evaluate(request.toString(),[{path:'/repair-orders/'+o.id+'/quote',method:'POST',data:{requestKey:crypto.randomUUID(),version:o.version,reason:'工程师无报价权限',amount:'12.34'}}]);assert.equal(deniedQuote.code,403);results.checks.push('真实工程师开单自动归本人、照片上传、开单幂等、报价越权拒绝与成本裁剪');
 setRole('boss');
 const raced=evaluate((async function(i){return Promise.all([i.key1,i.key2].map(async requestKey=>(await wx.cloud.callFunction({name:'staff-repair',data:{path:'/repair-orders/'+i.id+'/quote',method:'POST',data:{requestKey,version:i.version,reason:'真实微信并发报价',amount:'12.34'},headers:{Authorization:'Bearer '+wx.getStorageSync('xm_token')}}})).result));}).toString(),[{id:o.id,version:o.version,key1:crypto.randomUUID(),key2:crypto.randomUUID()}]);assert.deepEqual(raced.map(r=>r.code).sort(),[0,409]);o=raced.find(r=>r.code===0).data;results.checks.push('真实微信同版本并发报价仅一个成功');
 act('transition',{to:'pending_confirm'});act('confirm',{quoteVersion:o.quoteVersion,confirmed:true});act('transition',{to:'repairing'});
 const board=call('/repair-orders/board','GET',{keyword:o.no,overdue:'true'}).data;assert.equal(board.total,1);assert.equal(board.columns.repairing.length,1);assert.equal(call('/repair-orders','GET',{keyword:o.no}).data.total,1);results.checks.push('已部署维修列表/看板/北京时间超期筛选');
 act('transition',{to:'pending_pickup',result:'更换接口后测试正常'});
 const complete={to:'completed',pickupName:'验证顾客',pickupProof:[{fileId:proof.fileId}],warrantyDays:30};const unpaid=evaluate(request.toString(),[{path:'/repair-orders/'+o.id+'/transition',method:'POST',data:{requestKey:crypto.randomUUID(),version:o.version,reason:'不得未结清取机',...complete}}]);assert.equal(unpaid.code,409);
 act('payment',{kind:'receipt',amount:'12.34',method:'现金',confirmed:true});act('transition',complete);assert.equal(o.status,'completed');assert.equal(o.received,12.34);assert.ok((await fetch(o.files[0].url)).ok);assert.equal(call('/repair-orders/stats').code,0);results.checks.push('真实报价确认、收款后取机完结，未结清拒绝，实际凭证可下载');
 execFileSync('wechatide',['-c','Codex','automation_navigate','--project',root,'--action','navigateTo','--url','/packages/staff/repair/detail?id='+o.id],{stdio:['ignore','ignore','pipe']});
 let page;for(let i=0;i<10;i++){page=evaluate('function(){const p=getCurrentPages().slice(-1)[0];return {route:p.route,error:p.data.error,status:p.data.detail?.status,received:p.data.detail?.received,files:p.data.detail?.files?.length};}');if(page.status)break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(page.status,'completed');assert.equal(page.error,'');assert.equal(page.files,2);assert.equal(page.received,12.34);results.page=page;results.checks.push('维修详情页实际加载completed、收款金额与外观/取机照片');
 setRole('sales');assert.equal(evaluate(request.toString(),[{path:'/repair-orders/'+o.id}]).code,403);assert.equal(evaluate(request.toString(),[{name:'files',path:'/files/'+proof.fileId}]).code,403);
 setRole('engineer');assert.equal(evaluate(request.toString(),[{path:'/repair-orders/'+fixture.orderId}]).code,404);
 setRole('engineer','disabled');assert.equal(evaluate(request.toString(),[{path:'/repair-orders/'+o.id}]).code,403);results.checks.push('真实角色变更即时生效：销售禁读、工程师非指派404、停用拒绝');
 results.orderId=o.id;results.fileId=proof.fileId;results.version=o.version;
}finally{
 setRole(staff.role_key,staff.status);results.restoredRole=staff.role_key;
 const restored=evaluate((async function(){const r=(await wx.cloud.callFunction({name:'auth',data:{path:'/auth/wx-login',method:'POST',data:{}}})).result;if(r.code===0){wx.setStorageSync('xm_token',r.data.token);wx.setStorageSync('xm_user',r.data.user);getApp().globalData.user=r.data.user;}return {code:r.code,role:r.data?.user?.role};}).toString());assert.equal(restored.code,0);assert.equal(restored.role,'customer');results.restoredSessionRole=restored.role;
 execFileSync('wechatide',['-c','Codex','automation_navigate','--project',root,'--action','switchTab','--url','/pages/shop/index'],{stdio:['ignore','ignore','pipe']});fs.writeFileSync(local+'/repair-live-results.json',JSON.stringify(results,null,2),{mode:0o600});
}console.log(JSON.stringify({passed:true,checks:results.checks,timings:results.timings,page:results.page,restoredRole:results.restoredRole,restoredSessionRole:results.restoredSessionRole}));})().catch(e=>{console.error(e.message);process.exitCode=1;});
