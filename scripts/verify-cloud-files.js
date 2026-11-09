#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的云存储上传集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-files.js。使用已登录 tcb/mcporter、functions.env。
 * 创建带随机标识的验证员工/分类/型号/单机；保留数据和审计作为验证证据，不自动删除。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
execFileSync(process.execPath, ['scripts/sync-cloudfunctions.js']);
const local = '.local/cloudbase';
fs.mkdirSync(local, { recursive: true });
const variables = Object.fromEntries(fs.readFileSync(`${local}/functions.env`, 'utf8').split('\n').map(x => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(x.trim())).filter(Boolean).map(x => [x[1], x[2]]));
const listing = execFileSync('tcb', ['env', 'list', '--json'], { encoding: 'utf8' });
const envId = JSON.parse(listing.slice(listing.indexOf('{'))).data[0].EnvId;
process.env.TCB_ENV = envId;
process.env.CLOUDBASE_API_KEY = variables.CLOUDBASE_API_KEY;
process.env.WHOLESALE_DISCOUNT = variables.WHOLESALE_DISCOUNT || '0';
if (!process.env.CLOUDBASE_API_KEY) throw new Error('缺少 CLOUDBASE_API_KEY');
function control(tool, args) {
  const raw = execFileSync('npx', ['-y', 'mcporter', 'call', '--stdio', 'npx -y @cloudbase/cloudbase-mcp@latest', tool, '--args', JSON.stringify({ ...args, envId }), '--output', 'json'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(raw.slice(raw.indexOf('{')));
  if (!result.success) throw new Error(result.message || result.errorCode);
  return result;
}
const fixture = { tag: crypto.randomUUID(), uid: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex') };
fixture.openid = 'stock-verification-' + fixture.tag;
const phone = '199' + String(Date.now()).slice(-8);
control('managePgDatabase', { action: 'execute', confirm: true, sql: `
 INSERT INTO users(id,openid,nickname) VALUES('${fixture.uid}','${fixture.openid}','库存迁移验证');
 INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${crypto.randomUUID()}','${fixture.uid}','${phone}','库存迁移验证','boss');
 INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash('sha256').update(fixture.token).digest('hex')}','${fixture.uid}','staff',now()+interval '2 hours');` });
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test', getWXContext: () => ({ OPENID: fixture.openid }) };
  return original.call(this, name, ...args);
};
const stock = require('../cloudfunctions/staff-stock').main;
const sales = require('../cloudfunctions/staff-sales').main;
const files = require('../cloudfunctions/files').main;
const shop = require('../cloudfunctions/shop').main;
Module._load = original;
// 32MiB上限在已部署函数通过真实微信SDK分段验收；本运行器不搬运整份大文件。
const results=[],evidence={};
const raw=(handler,path,method='GET',data={},token=fixture.token)=>handler({path,method,data,headers:token?{Authorization:'Bearer '+token}:{ }},{request_id:'files-verify-'+fixture.tag});
async function call(handler,path,method='GET',data={},expected=0,token=fixture.token){const r=await raw(handler,path,method,data,token);assert.equal(r.code,expected,JSON.stringify(r));return r.data;}
const png=fs.readFileSync('miniprogram/assets/brands/apple.png');
async function upload(bytes,scope='internal',key=crypto.randomUUID()){
 const intent=await call(files,'/files/upload-intent','POST',{scope,size:bytes.length,requestKey:key});
 assert.ok(!intent.uploadUrl.includes(variables.CLOUDBASE_API_KEY));
 const sent=await fetch(intent.uploadUrl,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes});
 assert.ok(sent.ok,`upload ${sent.status}: ${(await sent.text()).slice(0,200)}`);
 let result=await call(files,'/files/'+intent.uploadId+'/complete','POST');let steps=1;
 while(result.processing&&steps<130){result=await call(files,'/files/'+intent.uploadId+'/complete','POST');steps++;}
 assert.ok(result.fileId,'核验未完成不得作为文件返回');return {intent,file:result,steps};
}
(async()=>{
 const first=await upload(png);fixture.fileId=first.file.fileId;
 const bytes=Buffer.from(await(await fetch(first.file.url)).arrayBuffer());assert.ok(bytes.equals(png));
 assert.equal(first.file.mime,'image/png');assert.equal(first.file.size,png.length);
 assert.equal((await call(files,'/files/'+first.file.fileId+'/complete','POST')).fileId,first.file.fileId);
 const rows=control('queryPgDatabase',{action:'sql',sql:`SELECT f.sha256, f.byte_size, (SELECT count(*) FROM audit_logs WHERE action='上传文件' AND object_id=f.id::text) audits FROM files f WHERE id='${first.file.fileId}'`}).data.rows;
 assert.equal(rows[0].sha256,crypto.createHash('sha256').update(png).digest('hex'));assert.equal(Number(rows[0].audits),1);results.push('真实PNG上传、字节/摘要核验、登记审计与完成重试');
 await call(files,'/files/'+first.file.fileId,'GET',{},401,'');
 await call(files,'/files/upload-intent','POST',{scope:'internal',size:png.length,requestKey:'anon'},401,'');results.push('未登录不能上传或读取内部凭证');
 const publicFile=await upload(png,'public');const publicView=await call(files,'/files/'+publicFile.file.fileId,'GET',{},0,'');assert.ok((await fetch(publicView.url)).ok);results.push('公开媒体允许访客获取临时URL，存储桶仍为私有');
 const invalidIntent=await call(files,'/files/upload-intent','POST',{scope:'internal',size:12,requestKey:crypto.randomUUID()});await fetch(invalidIntent.uploadUrl,{method:'PUT',body:Buffer.from('not an image')});await call(files,'/files/'+invalidIntent.uploadId+'/complete','POST',{},400);await call(files,'/files/'+invalidIntent.uploadId,'GET',{},404);results.push('伪造图片内容不登记、不假成功');
 await call(files,'/files/upload-intent','POST',{scope:'internal',size:32*1024*1024+1,requestKey:'too-large'},413);
 const mismatch=await call(files,'/files/upload-intent','POST',{scope:'internal',size:png.length+1,requestKey:crypto.randomUUID()});await fetch(mismatch.uploadUrl,{method:'PUT',body:png});await call(files,'/files/'+mismatch.uploadId+'/complete','POST',{},400);results.push('超32MB与实际大小不符被拒');
 // 服务器分段恢复SHA256状态，最终摘要必须等于整份原始字节的标准SHA256。
 const segmented=Buffer.alloc(1024*1024);png.copy(segmented);const partial=await call(files,'/files/upload-intent','POST',{scope:'internal',size:segmented.length,requestKey:crypto.randomUUID()});await fetch(partial.uploadUrl,{method:'PUT',body:segmented});
 const progress=await call(files,'/files/'+partial.uploadId+'/complete','POST');assert.equal(progress.processing,true);assert.equal(progress.fileId,undefined);assert.equal(progress.processedBytes,524288);await call(files,'/files/'+partial.uploadId,'GET',{},404);
 const finished=await call(files,'/files/'+partial.uploadId+'/complete','POST',{processedBytes:segmented.length,sha256:'0'.repeat(64)});assert.ok(finished.fileId);
 const saved=control('queryPgDatabase',{action:'sql',sql:`SELECT sha256 FROM files WHERE id='${finished.fileId}'`}).data.rows[0];assert.equal(saved.sha256,crypto.createHash('sha256').update(segmented).digest('hex'));results.push('分段核验未完成不登记；恢复后完整SHA256正确且客户端不能伪造进度');
 // 32MiB上限由verify-cloud-files-large.js在实际部署函数另作验收。
 // 再用原暂存签名写入别的字节，正式文件必须不变（暂存可否复用由平台签名策略决定）。
 const rewrite=await fetch(first.intent.uploadUrl,{method:'PUT',body:Buffer.from('changed')});evidence.stagingRewriteStatus=rewrite.status;
 const still=await call(files,'/files/'+first.file.fileId);assert.ok(Buffer.from(await(await fetch(still.url)).arrayBuffer()).equals(png));results.push('旧上传签名不能覆盖正式凭证');
 const base=await call(stock,'/templates/t_phone');const category=await call(stock,'/catalog/categories','POST',{label:'文件验证'+fixture.tag.slice(0,8),copyTemplateId:base.id});const fields=base.fields.map(f=>['supplier','receipt'].includes(f.key)?{...f,required:false}:f);const template=await call(stock,'/templates/'+category.templateId+'/versions','POST',{baseVersion:1,fields});const model=await call(stock,'/models','POST',{category:category.value,name:'文件验证型号'+fixture.tag,brandLabel:'验证',series:'验证'});
 const attrs=Object.fromEntries(fields.filter(f=>f.required||f.default!==undefined).map(f=>[f.key,f.default!==undefined?f.default:f.type==='select'?f.options[0]:f.type==='number'?90:'验证']));
 function imei(){const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){const d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);}
 const unit=await call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes:attrs,imei1:imei(),cost:1000,retail:1500,wholesale:1400,agentBase:1300,publicImages:[{fileId:publicFile.file.fileId}],flags:{showInShop:true}});
 const inventory=await call(stock,'/units/'+unit.id);assert.equal(inventory.images.length,1);
 const catalog=await call(shop,'/shop/units','GET',{modelId:model.id},0,'');assert.equal(catalog.list[0].images.length,1);assert.ok((await fetch(catalog.list[0].cover)).ok);results.push('公开照片入库后库存与商城实际展示，内部凭证不进入公开商品');
 const order=await call(sales,'/sales-orders','POST',{requestKey:fixture.tag+'sale',items:[{unitId:unit.id,priceVersion:1}],payMethod:'现金',paymentConfirmed:true});
 const attached=await call(sales,'/sales-orders/'+order.id+'/receipts','POST',{receipts:[{fileId:first.file.fileId}],reason:'真实补传验收'});assert.equal(attached.receipts.length,1);assert.ok((await fetch(attached.receipts[0].url)).ok);
 assert.equal((await call(sales,'/sales-orders/'+order.id+'/receipts','POST',{receipts:[{fileId:first.file.fileId}],reason:'重试验收'})).receipts.length,1);results.push('销售补传凭证、读取预览与重复认领幂等');
 const secondUnit=await call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes:attrs,imei1:imei(),cost:1000,retail:1500,wholesale:1400,agentBase:1300});
 const secondOrder=await call(sales,'/sales-orders','POST',{requestKey:fixture.tag+'sale2',items:[{unitId:secondUnit.id,priceVersion:1}],payMethod:'现金',paymentConfirmed:true});
 const sharedReceipt=await upload(png);
 const claim=await Promise.all([order.id,secondOrder.id].map(id=>raw(sales,'/sales-orders/'+id+'/receipts','POST',{receipts:[{fileId:sharedReceipt.file.fileId}],reason:'并发认领验证'})));
 assert.deepEqual(claim.map(r=>r.code).sort(),[0,409]);results.push('两个销售单并发认领同一内部凭证只有一个成功');
 const crossReceipt=await upload(png);
 const cross=await Promise.all([
  raw(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes:attrs,imei1:imei(),cost:1000,retail:1500,wholesale:1400,agentBase:1300,receiptImages:[{fileId:crossReceipt.file.fileId}]}),
  raw(sales,'/sales-orders/'+secondOrder.id+'/receipts','POST',{receipts:[{fileId:crossReceipt.file.fileId}],reason:'跨域并发认领验证'})]);
 assert.equal(cross.filter(r=>r.code===0).length,1);assert.ok(cross.some(r=>[400,409].includes(r.code)));results.push('入库与销售跨域并发认领同一内部凭证只有一个成功');
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='warehouse' WHERE user_id='${fixture.uid}'`});
 await call(files,'/files/'+first.file.fileId,'GET',{},403);results.push('即使原上传者，失去销售读取权限也不能读取已关联销售的凭证');
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`});
 await call(files,'/files/'+first.file.fileId);await call(files,'/files/upload-intent','POST',{scope:'public',size:png.length,requestKey:'sales-public'},403);results.push('销售可读收款凭证，但不可上传公开设备媒体');
 await call(files,'/files/'+first.file.fileId,'GET',{},401,'');
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='boss' WHERE user_id='${fixture.uid}'`});
 const repairProof=await upload(png),loanProof=await upload(png);
 const repairId=crypto.randomUUID(),loanId=crypto.randomUUID(),eventId=crypto.randomUUID();
 control('managePgDatabase',{action:'execute',confirm:true,sql:`INSERT INTO repair_orders(id,no,kind,model,fault,engineer_id,request_key,request_hash,creator_id) VALUES('${repairId}','RP${repairId}','external','验证机型','附件访问测试','${fixture.uid}','${fixture.tag}repair','test','${fixture.uid}'); INSERT INTO repair_files(order_id,file_id,purpose,position) VALUES('${repairId}','${repairProof.file.fileId}','appearance',0); INSERT INTO loan_orders(id,no,type,counterparty,phone,due_date,remark,creator_id,request_key,request_hash) VALUES('${loanId}','LN${loanId}','loan_out','验证往来方','','2026-11-30','凭证访问验证','${fixture.uid}','${fixture.tag}loan','test'); INSERT INTO loan_events(id,order_id,actor_id,action,version,reason,data,request_key,request_hash) VALUES('${eventId}','${loanId}','${fixture.uid}','create',1,'访问验证','{}','${fixture.tag}event','test'); INSERT INTO loan_files(order_id,file_id,event_id) VALUES('${loanId}','${loanProof.file.fileId}','${eventId}'); UPDATE staff SET role_key='engineer' WHERE user_id='${fixture.uid}'`});
 await call(files,'/files/'+repairProof.file.fileId);await call(files,'/files/'+loanProof.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE repair_orders SET engineer_id=NULL WHERE id='${repairId}'`});await call(files,'/files/'+repairProof.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE repair_files SET purpose='expense' WHERE order_id='${repairId}'; UPDATE staff SET role_key='manager' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+repairProof.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='finance' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+repairProof.file.fileId);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='warehouse' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+loanProof.file.fileId);results.push('维修附件按指派/收款/成本权限，借还附件按借还权限判权');
 // 历史多域共用文件也必须满足每个关联业务的权限；管理员只建读取夹具，不模拟业务结果。
 control('managePgDatabase',{action:'execute',confirm:true,sql:`INSERT INTO loan_files(order_id,file_id,event_id) VALUES('${loanId}','${first.file.fileId}','${eventId}')`});await call(files,'/files/'+first.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+first.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='boss' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+first.file.fileId);results.push('历史跨销售/借还共用文件要求两域权限同时满足');
 if(!fs.existsSync('.local/cloudbase/upload-verification.mp4'))execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=32x32:d=0.2','-c:v','libx264','-pix_fmt','yuv420p','.local/cloudbase/upload-verification.mp4']);
 const movie=fs.readFileSync('.local/cloudbase/upload-verification.mp4');
 const videoIntent=await call(files,'/files/upload-intent','POST',{scope:'internal',size:movie.length,requestKey:crypto.randomUUID()});await fetch(videoIntent.uploadUrl,{method:'PUT',body:movie});await call(files,'/files/'+videoIntent.uploadId+'/complete','POST',{},400);
 const video=await upload(movie,'public');assert.equal(video.file.mime,'video/mp4');results.push('真实MP4只允许公开设备媒体，内部凭证拒绝视频');
 const stored=control('queryPgDatabase',{action:'sql',sql:`SELECT stored_name FROM files WHERE id='${publicFile.file.fileId}'`}).data.rows[0].stored_name;
 const direct=await fetch(`https://${envId}.api.tcloudbasegateway.com/v1/storages/object/${stored}`);assert.equal(direct.ok,false);
 const privileged=await fetch(`https://${envId}.api.tcloudbasegateway.com/v1/storages/object/${stored}`,{headers:{Authorization:'Bearer '+variables.CLOUDBASE_API_KEY}});assert.equal(privileged.ok,true);await privileged.body.cancel();results.push('知道对象位置仍不能匿名直读私有桶');
 if(!fs.existsSync('.local/cloudbase/upload-verification.webp'))execFileSync('python3',['-c',"from PIL import Image; Image.open('miniprogram/assets/brands/apple.png').save('.local/cloudbase/upload-verification.webp', 'WEBP')"]);
 const jpg=await upload(fs.readFileSync('miniprogram/assets/images/phone_blue_main.jpg'));
 const webp=await upload(fs.readFileSync('.local/cloudbase/upload-verification.webp'));
 assert.equal(jpg.file.mime,'image/jpeg');assert.equal(webp.file.mime,'image/webp');results.push('真实JPEG与WebP上传并由服务端识别实际类型');
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET status='disabled' WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+first.file.fileId,'GET',{},403);
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET status='active' WHERE user_id='${fixture.uid}'; DELETE FROM sessions WHERE user_id='${fixture.uid}'`});await call(files,'/files/'+first.file.fileId,'GET',{},401);results.push('员工停用或会话退出后不能再获取内部凭证链接');
 fs.writeFileSync(`${local}/files-fixture.json`,JSON.stringify({...fixture,orderId:order.id,unitId:unit.id}));fs.writeFileSync(`${local}/files-results.json`,JSON.stringify({date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),passed:results,evidence},null,2));console.log(JSON.stringify({results,evidence}));
})().catch(e=>{console.error(e);process.exitCode=1});
