#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的借还集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-loans.js。使用已登录 tcb/mcporter、functions.env。
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
const loans = require('../cloudfunctions/staff-loans').main;
Module._load = original;
// 32MiB上限在已部署函数通过真实微信SDK分段验收；本运行器不搬运整份大文件。
const results=[],evidence={};
const raw=(handler,path,method='GET',data={},token=fixture.token)=>handler({path,method,data,headers:token?{Authorization:'Bearer '+token}:{ }},{request_id:'loans-verify-'+fixture.tag});
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
const imei=()=>{const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){const d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
const query=sql=>control('queryPgDatabase',{action:'sql',sql}).data.rows;
const execute=sql=>control('managePgDatabase',{action:'execute',confirm:true,sql});
const key=()=>crypto.randomUUID();
const outBody=unitIds=>({requestKey:key(),type:'loan_out',unitIds,counterparty:'云端借还验证',phone:'199'+String(Date.now()).slice(-8),dueAt:'2020-01-01',reason:'真实交接出借'});
const mutation=(o,extra)=>({requestKey:key(),version:o.version,reason:'真实逐台处理',...extra});
(async()=>{
 assert.equal((await call(loans,'/loans/options')).financialPolicy,'none');
 const base=await call(stock,'/templates/t_phone');const category=await call(stock,'/catalog/categories','POST',{label:'借还验证'+fixture.tag.slice(0,8),copyTemplateId:base.id});
 const fields=base.fields.map(f=>['supplier','receipt'].includes(f.key)?{...f,required:false}:f);const template=await call(stock,'/templates/'+category.templateId+'/versions','POST',{baseVersion:1,fields});
 const model=await call(stock,'/models','POST',{category:category.value,name:'借还验证型号'+fixture.tag,brandLabel:'借还验证',series:'验证',specs:{storage:['128G'],color:['黑色']}});
 const attributes=Object.fromEntries(fields.filter(f=>f.required||f.default!==undefined).map(f=>[f.key,f.default!==undefined?f.default:f.type==='select'?f.options[0]:f.type==='number'?90:'验证']));attributes.storage='128G';attributes.color='黑色';
 const unit=()=>call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes,imei1:imei(),cost:1000,retail:1500,wholesale:1400,agentBase:1300,flags:{showInShop:true,sharePeer:true,shareAgent:true}});
 const a=await unit(),b=await unit(),c=await unit();
 const race=await Promise.all([raw(loans,'/loans','POST',outBody([a.id])),raw(loans,'/loans','POST',outBody([a.id]))]);
 assert.deepEqual(race.map(r=>r.code).sort(),[0,409]);let order=race.find(r=>r.code===0).data;
 assert.equal((await call(stock,'/units/'+a.id)).status,'loaned_out');assert.equal((await call(stock,'/units/'+a.id)).flags.showInShop,false);results.push('同一自有设备并发出借仅一单成功、关闭分享且不产生销售');
 await call(loans,'/loans','POST',outBody([b.id,a.id]),409);assert.equal((await call(stock,'/units/'+b.id)).status,'in_stock');results.push('多台出借任一冲突整单回滚');
 const create=outBody([b.id,c.id]);let o=await call(loans,'/loans','POST',create);assert.equal(o.status,'overdue');assert.equal((await call(loans,'/loans','POST',create)).id,o.id);await call(loans,'/loans','POST',{...create,reason:'内容冲突'},409);
 await call(loans,'/loans','POST',{...outBody([b.id]),deposit:'100'},400);await call(loans,'/loans/'+o.id+'/return','POST',mutation(o,{items:[{unitId:b.id,condition:'正常',photos:[]}]}),400);assert.equal((await call(loans,'/loans/'+o.id)).version,1);results.push('开单幂等/标识冲突、禁止收费、缺归还凭证不变库存');
 const proof=(await upload(png)).file;const returnBody=mutation(o,{items:[{unitId:b.id,condition:'外观功能正常',damage:'无新增损坏',photos:[{fileId:proof.fileId}]}]});
 o=await call(loans,'/loans/'+o.id+'/return','POST',returnBody);assert.equal(o.storedStatus,'active');assert.equal(o.items.find(i=>i.unitId===b.id).status,'returned_recheck');assert.equal((await call(loans,'/loans/'+o.id+'/return','POST',returnBody)).version,o.version);
 assert.equal((await call(stock,'/units/'+b.id)).status,'recheck');assert.ok((await call(loans,'/loans','GET',{status:'returned_recheck',keyword:create.counterparty})).list.some(r=>r.id===o.id));assert.ok((await call(loans,'/loans','GET',{status:'overdue',keyword:create.counterparty})).list.some(r=>r.id===o.id));assert.equal((await call(loans,'/loans','GET',{keyword:b.imei1})).list.some(r=>r.id===o.id),true);results.push('部分归还保持进行中、待复检/逾期筛选与串码搜索、归还幂等');
 await call(loans,'/loans/'+o.id+'/recheck','POST',mutation(o,{unitIds:[b.id]}),409);
 const recheck=async id=>{const f=await call(stock,'/units/'+id+'/recheck-form');return call(stock,'/units/'+id+'/recheck','POST',{inspectionVersion:f.inspectionVersion,result:'pass',attributes:{},reason:'真实库存复检通过'});};
 await recheck(b.id);const closeBody=mutation(o,{unitIds:[b.id]});o=await call(loans,'/loans/'+o.id+'/recheck','POST',closeBody);assert.equal(o.items.find(i=>i.unitId===b.id).status,'closed');assert.equal((await call(loans,'/loans/'+o.id+'/recheck','POST',closeBody)).version,o.version);
 assert.equal((await call(stock,'/units/'+b.id)).loan,undefined);assert.equal((await call(stock,'/units/'+b.id)).flags.showInShop,false);results.push('不能跳过真实库存复检，核验流水后逐台完结且不自动恢复分享');
 const proof2=(await upload(png)).file;const body2=mutation(o,{items:[{unitId:c.id,condition:'正常',photos:[{fileId:proof2.fileId}]}]});const returned=await Promise.all([raw(loans,'/loans/'+o.id+'/return','POST',body2),raw(loans,'/loans/'+o.id+'/return','POST',{...body2,requestKey:key()})]);assert.deepEqual(returned.map(r=>r.code).sort(),[0,409]);o=returned.find(r=>r.code===0).data;
 await recheck(c.id);o=await call(loans,'/loans/'+o.id+'/recheck','POST',mutation(o,{unitIds:[c.id]}));assert.equal(o.status,'closed');results.push('同单同版本并发归还只有一个成功，全部复检后完结');
 const code1=imei(),code2=imei(),code3=imei();const borrowBody={requestKey:key(),type:'borrow_in',devices:[{modelId:model.id,imei1:code1,imei2:code2,description:'外部货主交接'},{modelId:model.id,imei1:code3}],counterparty:'借入验证',phone:create.phone,dueAt:'2030-01-01',reason:'真实借入'};
 const both=await Promise.all([call(loans,'/loans','POST',borrowBody),call(loans,'/loans','POST',borrowBody)]);let borrow=both[0];assert.equal(borrow.id,both[1].id);assert.ok(borrow.items.every(i=>i.ownership==='borrowed'&&i.unitStatus==='borrowed_in'));
 const first=borrow.items.find(i=>i.imei1===code1),second=borrow.items.find(i=>i.imei1===code3),bv=await call(stock,'/units/'+first.unitId);assert.equal(bv.cost,0);assert.equal(bv.flags.showInShop,false);await call(sales,'/sales/quote','POST',{items:[{unitId:first.unitId,priceVersion:bv.priceVersion}]},409);
 await call(loans,'/loans','POST',{...borrowBody,requestKey:key(),devices:[{modelId:model.id,imei1:code2}]},409);results.push('借入并发同标识幂等、外部货权零成本且不可售、主副IMEI跨槽冲突拒绝');
 const badCode=imei();await call(loans,'/loans','POST',{...borrowBody,requestKey:key(),devices:[{modelId:model.id,imei1:badCode},{modelId:model.id,imei1:badCode}]},400);assert.equal(query(`SELECT count(*) AS n FROM unit_identifiers WHERE imei='${badCode}'`)[0].n,'0');
 const rollbackCode=imei();await call(loans,'/loans','POST',{...borrowBody,requestKey:key(),devices:[{modelId:model.id,imei1:rollbackCode},{modelId:model.id,imei1:code2}]},409);assert.equal(query(`SELECT count(*) AS n FROM unit_identifiers WHERE imei='${rollbackCode}'`)[0].n,'0');results.push('借入重复串码与中途冲突整单回滚，不遗留串码登记');
 const proof3=(await upload(png)).file;borrow=await call(loans,'/loans/'+borrow.id+'/return','POST',mutation(borrow,{items:[{unitId:first.unitId,condition:'已核对交还',photos:[{fileId:proof3.fileId}]}]}));assert.equal(borrow.storedStatus,'active');assert.equal((await call(stock,'/units/'+first.unitId)).status,'returned');
 const proof4=(await upload(png)).file;borrow=await call(loans,'/loans/'+borrow.id+'/return','POST',mutation(borrow,{items:[{unitId:second.unitId,condition:'已核对交还',photos:[{fileId:proof4.fileId}]}]}));assert.equal(borrow.status,'closed');
 const again=await call(loans,'/loans','POST',{...borrowBody,requestKey:key(),devices:[borrowBody.devices[0]]});assert.equal(again.items[0].unitId,first.unitId);const old=await call(loans,'/loans/'+borrow.id);assert.equal(old.items.find(i=>i.unitId===first.unitId).status,'closed');assert.equal(old.items.find(i=>i.unitId===first.unitId).name,model.name);results.push('借入逐台归还冲销并完结，再借入沿用同设备且历史状态/快照不变');
 const role=r=>execute(`UPDATE staff SET role_key='${r}' WHERE user_id='${fixture.uid}'`);
 role('warehouse');const warehouse=await call(loans,'/loans/'+borrow.id);assert.ok(warehouse.photos.length);assert.ok((await fetch(warehouse.photos[0].url)).ok);assert.equal((await call(files,'/files/'+proof3.fileId)).fileId,proof3.fileId);
 role('sales');await call(loans,'/loans/options','GET',{},403);await call(loans,'/loans/'+borrow.id,'GET',{},403);await call(files,'/files/'+proof3.fileId,'GET',{},403);assert.equal((await call(stock,'/units/'+a.id)).loan,undefined);
 role('engineer');await call(files,'/files/'+proof3.fileId,'GET',{},403);role('boss');await call(loans,'/loans/'+borrow.id,'GET',{},401,'');results.push('库管可读交接照片，销售/维修/访客禁读借还与内部凭证');
 const sold=await unit();const sale=await call(sales,'/sales-orders','POST',{requestKey:key(),items:[{unitId:sold.id,priceVersion:1}],paymentConfirmed:true,payMethod:'现金'});
 const shared=(await upload(png)).file;const cross=await Promise.all([raw(loans,'/loans','POST',{...borrowBody,requestKey:key(),devices:[{modelId:model.id,imei1:imei()}],photos:[{fileId:shared.fileId}]}),raw(sales,'/sales-orders/'+sale.id+'/receipts','POST',{receipts:[{fileId:shared.fileId}],reason:'跨域并发认领'})]);assert.equal(cross.filter(r=>r.code===0).length,1);assert.ok(cross.some(r=>[400,409].includes(r.code)));results.push('借还与销售并发认领同一内部凭证只有一个成功');
 const audits=query(`SELECT action,reason FROM audit_logs WHERE object_id='${o.id}' AND action LIKE '借还:%'`);assert.equal(audits.length,5);assert.ok(audits.every(a=>a.reason));assert.equal(query(`SELECT count(*) AS n FROM sales_items WHERE unit_id IN('${a.id}','${b.id}','${c.id}')`)[0].n,'0');
 const grants=execute("SELECT relname,has_table_privilege('service_role',oid,'UPDATE') AS can_update,has_table_privilege('service_role',oid,'DELETE') AS can_delete FROM pg_class WHERE relname IN('loan_orders','loan_items','loan_events','loan_files') AND relnamespace='public'::regnamespace").data.previewRows;assert.ok(grants.every(r=>r.can_update==='false'&&r.can_delete==='false'));results.push('原因审计真实落库、借还不计销售、订单/快照/事件/附件表只追加');
 fs.writeFileSync(`${local}/loans-fixture.json`,JSON.stringify({...fixture,orderId:o.id,activeOrderId:order.id,modelId:model.id,borrowId:again.id,unitId:a.id}));
 fs.writeFileSync(`${local}/loans-results.json`,JSON.stringify({date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),passed:results,evidence:{auditCount:audits.length,appendOnly:grants}},null,2));console.log(JSON.stringify({results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
