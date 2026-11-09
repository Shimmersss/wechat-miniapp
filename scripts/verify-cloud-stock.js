#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的库存集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-stock.js。使用已登录 tcb/mcporter、functions.env。
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
const { main } = require('../cloudfunctions/staff-stock');
Module._load = original;
const results=[];
async function call(path,method='GET',data={},expected=0){const r=await main({path,method,data,headers:{Authorization:'Bearer '+fixture.token}},{request_id:'verify-'+fixture.tag});if(r.code!==expected)throw new Error(`${method} ${path}: ${JSON.stringify(r)}`);return r.data;}
const imei=()=>{const s='35'+String(Math.floor(Math.random()*1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){let d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
(async()=>{
 const form=await call('/templates/t_phone'); results.push('型号表单读取');
 let model,template,fields;
 if(fixture.modelId){ model={id:fixture.modelId}; const current=await call('/models/'+model.id+'/form');template=current;fields=current.fields; }
 else {
 const supplier=await call('/suppliers','POST',{name:'库存验证-'+fixture.tag}); fixture.supplierId=supplier.id;
 // 单独分类与模板：字段来自正式手机模板；只把附件改为可选，模拟合法无附件的设备类型。
 const category=await call('/catalog/categories','POST',{label:'验证'+fixture.tag.slice(0,8),copyTemplateId:form.id});fixture.categoryId=category.value;
 fields=form.fields.map(f=>['supplier','receipt'].includes(f.key)?{...f,required:false}:f);
 template=await call('/templates/'+category.templateId+'/versions','POST',{baseVersion:1,fields});
 model=await call('/models','POST',{category:category.value,name:'验证机型-'+fixture.tag,brandLabel:'验证品牌',series:'验证系列',specs:{storage:['128G'],color:['黑色']},tacs:[]});fixture.modelId=model.id;
 }
 const attrs=Object.fromEntries(fields.filter(f=>f.required||f.default!==undefined).map(f=>[f.key,f.default!==undefined?f.default:f.type==='select'?f.options[0]:f.type==='number'?90:'验收']));attrs.storage='128G';attrs.color='黑色';
 const input={modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes:attrs,imei1:imei(),cost:'1000',retail:'1400',wholesale:'1300',agentBase:'1250',internalNote:'验证内部备注',flags:{showInShop:false,sharePeer:false,shareAgent:false}};
 const created=await call('/inbound/units','POST',input);fixture.unitId=created.id; const view=await call('/units/'+created.id);assert.equal(view.cost,1000);assert.equal(view.imei1,input.imei1);results.push('入库后库存可查');
 await call('/inbound/units','POST',input,409);results.push('重复IMEI被拒');
 const rollbackImei=imei();await call('/inbound/batch','POST',{common:{...input,imei1:undefined},units:[{imei1:rollbackImei},{imei1:input.imei1}]},409);
 assert.equal((await call('/inbound/check-imei','POST',{imei:rollbackImei})).unique,true);results.push('批量任一失败整批回滚');
 const priced=await call('/units/'+created.id+'/price','PATCH',{retail:1500,priceVersion:view.priceVersion,reason:'真实PG改价验收'});assert.equal(priced.retail,1500);results.push('改价事务成功');
 const concurrent=await Promise.all([1550,1600].map(retail=>main({path:'/units/'+created.id+'/price',method:'PATCH',data:{retail,priceVersion:priced.priceVersion,reason:'并发改价验收'},headers:{Authorization:'Bearer '+fixture.token}},{request_id:'verify-'+fixture.tag})));
 assert.deepEqual(concurrent.map(r=>r.code).sort(),[0,409]);results.push('同设备并发改价仅一个成功');
 const current=await call('/units/'+created.id);
 const ledger=await call('/units/'+created.id+'/ledger');assert.equal(ledger.total,1);
 await call('/units/'+created.id+'/label'); await call('/units', 'GET',{keyword:model.name});
 const session=await call('/stocktake-sessions','POST',{requestKey:'stocktake-'+fixture.tag,modelId:model.id});fixture.sessionId=session.id;assert.equal(session.expectedCount,1);
 assert.equal((await call('/stocktake-sessions/'+session.id+'/scans','POST',{code:input.imei1})).result,'matched');
 assert.equal((await call('/stocktake-sessions/'+session.id+'/scans','POST',{code:created.id})).result,'duplicate');
 await call('/stocktake-sessions/'+session.id+'/scans','POST',{code:'UNKNOWN-'+fixture.tag});
 const extra=await call('/stocktake-sessions/'+session.id+'/units','GET',{state:'extra'});assert.equal(extra.total,1);
 const record=await call('/stocktake-sessions/'+session.id+'/close','POST');assert.equal(record.matched,1);fixture.recordId=record.id;
 const replay=await call('/stocktake-sessions/'+session.id+'/close','POST');assert.equal(replay.id,record.id);
 await call('/stocktakes/'+record.id+'/resolutions','POST',{type:'extra',target:'0',resolution:'handled',note:'验证确认未知编号'});
 await call('/stocktakes');results.push('盘点开单、扫码、重复扫码、提交幂等与差异追加');
 const recheck=await call('/inbound/units','POST',{...input,imei1:imei(),attributes:{...attrs,refurbishment:'正在整备'}});fixture.recheckId=recheck.id;
 const rf=await call('/units/'+recheck.id+'/recheck-form');await call('/units/'+recheck.id+'/recheck','POST',{result:'pass',reason:'整备完成验收',inspectionVersion:rf.inspectionVersion,attributes:{refurbishment:'整备完成'}});results.push('复检事务成功');
 const lookup=await call('/sales/lookup','GET',{code:created.id});const items=[{unitId:created.id,priceVersion:lookup.priceVersion}];await call('/sales/quote','POST',{items});
 const saleResults=await Promise.all([1,2].map(n=>main({path:'/sales-orders',method:'POST',data:{items,requestKey:'sale-'+fixture.tag+'-'+n,payMethod:'现金',paymentConfirmed:true},headers:{Authorization:'Bearer '+fixture.token}},{request_id:'verify-'+fixture.tag})));
 assert.deepEqual(saleResults.map(r=>r.code).sort(),[0,409]);fixture.saleId=saleResults.find(r=>r.code===0).data.id;results.push('同设备并发收银出库仅一单成功');
 await call('/sales-orders','POST',{items,requestKey:'sale-'+fixture.tag+'-x',payMethod:'现金',paymentConfirmed:true,customerRequestId:'unmigrated'},400);
 
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`});
 const sales=await call('/units/'+fixture.unitId);
 for(const key of ['cost','supplier','supplierId','imei1','imei2','internalNote','agentBase'])assert.equal(Object.hasOwn(sales,key),false,key);
 const summary=(await call('/units')).summary; assert.equal(Object.hasOwn(summary,'costTotal'),false);
 results.push('销售角色看不到成本与嵌套敏感字段');
 const audit=control('queryPgDatabase',{action:'sql',sql:`SELECT count(*) AS n FROM audit_logs WHERE object_id='${fixture.unitId}' AND action='修改库存价格' AND reason<>''`});
 assert.ok(Number(audit.data.rows[0].n)>=2);results.push('改价原因与审计真实落库');
 fs.writeFileSync('.local/cloudbase/stock-fixture.json',JSON.stringify({...fixture,input}));fs.writeFileSync('.local/cloudbase/stock-results.json',JSON.stringify({results,at:new Date().toISOString()},null,2));console.log(JSON.stringify(results));
})().catch(e=>{fs.writeFileSync('.local/cloudbase/stock-fixture.json',JSON.stringify(fixture));console.error(e);process.exitCode=1});
