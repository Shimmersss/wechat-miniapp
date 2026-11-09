#!/usr/bin/env node
/** 真实微信SDK + 已部署files函数的32MiB上限验收。凭据只读忽略目录；不会创建假文件登记。
 * 运行前按wechatide skill完成Codex授权；本机live-login-args.json含测试员工phone/code。
 * 通过后台Promise避免自动化桥等待超时；每个分段仍是实际云函数调用。
 */
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
function evaluate(fn,args=[]){
 const file=path.join(root,'.local/cloudbase/files-eval-args.json');fs.writeFileSync(file,JSON.stringify(args),{mode:0o600});
 let text;try{text=execFileSync('wechatide',['-c','Codex','automation_evaluate','--project',root,'--fn-source',fn,'--args-file',file],{encoding:'utf8',maxBuffer:2e6});}catch(e){throw new Error(e.stdout?.toString()||'微信自动化失败');}
 const r=JSON.parse(text.slice(text.indexOf('{')));if(!r.ok)throw new Error(r.message);return r.result.result.result;
}
const startFn=async function(input){
 const c=async(name,path,data,token)=>{const r=await wx.cloud.callFunction({name,data:{path,method:'POST',data,headers:token?{Authorization:'Bearer '+token}:{}}});return r.result;};
 await c('auth','/auth/sms-code',{phone:input.phone});const s=await c('auth','/auth/staff-login',{account:input.phone,smsCode:input.code});if(s.code)return {error:s.message};
 const intent=await c('files','/files/upload-intent',{scope:'internal',size:33554432,requestKey:'large-'+Date.now()},s.data.token);
 return {intent,token:s.data.token};
};
const workFn=function(input){
 const job={state:'running',calls:0,processedBytes:0,startedAt:Date.now(),maxCallMs:0};getApp().globalData.__fileLargeVerification=job;
 (async()=>{
  try{for(let i=0;i<130;i++){
   const start=Date.now();const r=await wx.cloud.callFunction({name:'files',data:{path:'/files/'+input.id+'/complete',method:'POST',data:{processedBytes:33554432},headers:{Authorization:'Bearer '+input.token}}});job.maxCallMs=Math.max(job.maxCallMs,Date.now()-start);job.calls++;
   if(r.result.code!==0){job.state='failed';job.error=r.result.message;return;}
   if(r.result.data.fileId){job.state='done';job.file=r.result.data;job.completedMs=Date.now()-job.startedAt;return;}
   if(!r.result.data.processing){job.state='failed';job.error='未收到文件或核验进度';return;}
   job.processedBytes=r.result.data.processedBytes;
  }job.state='failed';job.error='分段次数超限';
  }catch(e){job.state='failed';job.error=e.errMsg||e.message;}
  finally{try{const r=await wx.cloud.callFunction({name:'auth',data:{path:'/auth/wx-login',method:'POST',data:{}}});if(r.result.code===0){wx.setStorageSync('xm_token',r.result.data.token);wx.setStorageSync('xm_user',r.result.data.user);getApp().globalData.user=r.result.data.user;}}catch(e){job.restoreError=e.errMsg||e.message;}}
 })();return {started:true};
};
(async()=>{
 const args=JSON.parse(fs.readFileSync('.local/cloudbase/live-login-args.json'));
 const context=evaluate(startFn.toString(),args);if(context.error||context.intent?.code!==0)throw new Error(context.error||context.intent?.message||'没有上传意图');
 fs.writeFileSync('.local/cloudbase/files-live-large-context.json',JSON.stringify(context),{mode:0o600});
 const bytes=Buffer.alloc(32*1024*1024);fs.readFileSync('miniprogram/assets/brands/apple.png').copy(bytes);const digest=crypto.createHash('sha256').update(bytes).digest('hex');
 const uploadStart=Date.now();const sent=await fetch(context.intent.data.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});if(!sent.ok)throw new Error('32MiB上传失败 '+sent.status);const uploadMs=Date.now()-uploadStart;
 evaluate(workFn.toString(),[{id:context.intent.data.uploadId,token:context.token}]);
 for(let poll=0;poll<60;poll++){
  await new Promise(resolve=>setTimeout(resolve,5000));
  const result=evaluate('function(){return getApp().globalData.__fileLargeVerification;}');
  if(poll%3===0)console.log(JSON.stringify({state:result.state,calls:result.calls,processedBytes:result.processedBytes}));
  if(result.state==='failed')throw new Error(result.error);
  if(result.state==='done'){
   if(result.file.size!==bytes.length)throw new Error('实际大小不符');
   fs.writeFileSync('.local/cloudbase/files-live-large-result.json',JSON.stringify({...result,uploadMs,expectedSha256:digest},null,2),{mode:0o600});
   console.log(JSON.stringify({passed:true,size:result.file.size,calls:result.calls,completeMs:result.completedMs,maxCallMs:result.maxCallMs,uploadMs}));return;
  }
 }
 throw new Error('32MiB核验超过5分钟，查看真实进度后重试，不作成功处理');
})().catch(e=>{console.error(e.message);process.exitCode=1});
