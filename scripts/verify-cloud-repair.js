#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的维修集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-repair.js。使用已登录 tcb/mcporter、functions.env。
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
const repair = require('../cloudfunctions/staff-repair').main;
const loans = require('../cloudfunctions/staff-loans').main;
Module._load = original;
// 32MiB上限在已部署函数通过真实微信SDK分段验收；本运行器不搬运整份大文件。
const results=[],evidence={};
const raw=(handler,path,method='GET',data={},token=fixture.token)=>handler({path,method,data,headers:token?{Authorization:'Bearer '+token}:{ }},{request_id:'repair-verify-'+fixture.tag});
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
const key=()=>crypto.randomUUID();
const execute=sql=>control('managePgDatabase',{action:'execute',confirm:true,sql});
const query=sql=>control('queryPgDatabase',{action:'sql',sql}).data.rows;
const imei=()=>{const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){let d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
const body=(o,d)=>({requestKey:key(),version:o.version,reason:'真实维修事务验证',...d});
const act=(o,a,d={},expect=0)=>call(repair,'/repair-orders/'+o.id+(a==='update'?'':'/'+a),a==='update'?'PUT':'POST',body(o,d),expect);
const role=r=>execute(`UPDATE staff SET role_key='${r}' WHERE user_id='${fixture.uid}'`);
(async()=>{
 if(process.argv.includes('--extra')){await extraChecks();return;}
 if(process.argv.includes('--bounds')){await boundsChecks();return;}
 if(process.argv.includes('--identifiers')){await identifierChecks();return;}
 const eng=crypto.randomUUID(),eng2=crypto.randomUUID();
 for(const uid of [eng,eng2])execute(`INSERT INTO users(id,openid,nickname) VALUES('${uid}','repair-engineer-${uid}','维修验证工程师'); INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${crypto.randomUUID()}','${uid}','199${String(Date.now()).slice(-8)}','维修验证工程师','engineer')`);
 const options=await call(repair,'/repair-orders/options');assert.equal(options.passwordStorage,false);assert.ok(options.engineers.some(e=>e.id===eng));
 const pic=(await upload(png)).file;
 const create={requestKey:key(),kind:'external',model:'云端维修验证机',identifier:imei(),customer:'维修验证顾客',phone:'199'+String(Date.now()).slice(-8),fault:'不开机',engineerId:eng,photos:[{fileId:pic.fileId}],expectedAt:'2020-01-01'};
 let o=await call(repair,'/repair-orders','POST',create);assert.equal((await call(repair,'/repair-orders','POST',create)).id,o.id);await call(repair,'/repair-orders','POST',{...create,fault:'不同故障'},409);await call(repair,'/repair-orders','POST',{...create,requestKey:key(),password:'禁止保存'},400);await act(o,'transition',{to:'repairing'},409);
 const twins=await Promise.all([raw(repair,'/repair-orders/'+o.id+'/transition','POST',body(o,{to:'checking'})),raw(repair,'/repair-orders/'+o.id+'/transition','POST',body(o,{to:'checking'}))]);assert.deepEqual(twins.map(r=>r.code).sort(),[0,409]);o=twins.find(r=>r.code===0).data;results.push('外部维修开单幂等/标识冲突、密码拒绝、同版本并发推进只有一个成功');
 o=await act(o,'update',{diagnosis:'检测完成，需更换配件'});o=await act(o,'quote',{amount:'100.01'});o=await act(o,'transition',{to:'pending_confirm'});await act(o,'transition',{to:'repairing'},409);
 o=await act(o,'confirm',{quoteVersion:o.quoteVersion,confirmed:true});o=await act(o,'quote',{amount:'101.01'});await act(o,'transition',{to:'repairing'},409);o=await act(o,'confirm',{quoteVersion:o.quoteVersion,confirmed:true});o=await act(o,'transition',{to:'repairing'});results.push('报价版本与确认绑定，改价后必须重新确认，不能跨节点');
 let part=await call(repair,'/repair-parts','POST',{sku:'repair-'+fixture.tag,name:'真实维修配件',unit:'件'});const receive={requestKey:key(),version:part.version,quantity:3,unitCost:'10.01',reason:'真实配件采购'};
 part=await call(repair,'/repair-parts/'+part.id+'/receive','POST',receive);assert.equal(part.stockValue,30.03);assert.equal((await call(repair,'/repair-parts/'+part.id+'/receive','POST',receive)).quantity,3);
 o=await act(o,'parts/issue',{partId:part.id,quantity:2});assert.equal(o.partsCost,20.02);const issue=o.parts[0];o=await act(o,'parts/return',{issueId:issue.id,quantity:1});assert.equal(o.partsCost,10.01);await act(o,'parts/return',{issueId:issue.id,quantity:2},400);results.push('配件采购幂等、移动平均领料与按原剩余成本退料、超量回滚');
 const expense=(await upload(png)).file;o=await act(o,'payment',{kind:'expense',amount:'5.02',method:'现金',confirmed:true,proof:[{fileId:expense.fileId}]});o=await act(o,'payment',{kind:'expense_refund',amount:'1.01',method:'现金',confirmed:true});assert.equal(o.expenses,4.01);
 await act(o,'payment',{kind:'receipt',amount:'200',method:'现金',confirmed:true},400);o=await act(o,'payment',{kind:'receipt',amount:'101.01',method:'现金',confirmed:true});await act(o,'payment',{kind:'refund',amount:'200',method:'现金',confirmed:true},400);o=await act(o,'payment',{kind:'refund',amount:'1',method:'现金',confirmed:true});o=await act(o,'payment',{kind:'receipt',amount:'1',method:'现金',confirmed:true});assert.equal(o.received,101.01);results.push('真实费用/退费、收款/退款和上下限控制，金额精确到分');
 const list=await call(repair,'/repair-orders','GET',{keyword:o.no});assert.equal(list.total,1);const board=await call(repair,'/repair-orders/board','GET',{keyword:o.no});assert.equal(board.columns.repairing.length,1);assert.equal(board.pageSize,200);
 let stats=await call(repair,'/repair-orders/stats');assert.ok(stats.revenue>=101.01);assert.ok(stats.partsCost>=10.01);assert.ok((await call(repair,'/repair-parts/'+part.id+'/ledger')).total>=3);results.push('维修列表/看板、配件流水与发生期统计');
 role('manager');const manager=await call(repair,'/repair-orders/'+o.id);assert.equal(manager.partsCost,undefined);assert.equal(manager.expenses,undefined);assert.equal(manager.identifier,o.identifier);assert.ok(manager.files.every(f=>f.purpose!=='expense'));assert.ok(manager.payments.every(p=>!p.kind.startsWith('expense')));assert.ok(manager.timeline.every(e=>e.costData===undefined));assert.ok(manager.parts.every(p=>p.cost===undefined));assert.equal((await call(repair,'/repair-parts')).list.find(p=>p.id===part.id).stockValue,undefined);assert.equal((await call(repair,'/repair-orders/stats')).profit,undefined);
 role('sales');await call(repair,'/repair-orders/'+o.id,'GET',{},403);await call(repair,'/repair-parts','GET',{},403);await call(files,'/files/'+expense.fileId,'GET',{},403);role('boss');results.push('店长无成本/费用/成本事件但按既有字段授权可见串码，销售禁读维修与配件');
 // 独立工程师会话，验证真实角色/指派过滤，完全不改全局角色定义。
 const engToken=crypto.randomBytes(32).toString('hex');execute(`INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash('sha256').update(engToken).digest('hex')}','${eng}','staff',now()+interval '2 hours')`);
 const bossOpenid=fixture.openid;fixture.openid='repair-engineer-'+eng;
 const engView=await call(repair,'/repair-orders/'+o.id,'GET',{},0,engToken);assert.equal(engView.partsCost,undefined);assert.ok(engView.files.some(f=>f.purpose==='appearance'));assert.ok(engView.files.every(f=>!['expense','payment'].includes(f.purpose)));
 await call(repair,'/repair-orders/'+o.id+'/quote','POST',body(o,{amount:99}),403,engToken);fixture.openid=bossOpenid;
 o=await act(o,'update',{engineerId:eng2});fixture.openid='repair-engineer-'+eng;await call(repair,'/repair-orders/'+o.id,'GET',{},404,engToken);assert.equal((await call(repair,'/repair-orders','GET',{keyword:o.no},0,engToken)).total,0);await call(files,'/files/'+pic.fileId,'GET',{},403,engToken);fixture.openid=bossOpenid;results.push('工程师仅获分派工单，改派即时撤权，报价与附件按角色判权');
 o=await act(o,'update',{waitingParts:true});await act(o,'transition',{to:'pending_pickup',result:'修复完成'},400);o=await act(o,'update',{waitingParts:false});o=await act(o,'transition',{to:'pending_pickup',result:'修复完成'});await act(o,'transition',{to:'completed',pickupName:'顾客',pickupProof:[],warrantyDays:30},400);
 const pickup=(await upload(png)).file;const completeBody=body(o,{to:'completed',pickupName:'顾客',pickupProof:[{fileId:pickup.fileId}],warrantyDays:30});o=await call(repair,'/repair-orders/'+o.id+'/transition','POST',completeBody);assert.equal(o.status,'completed');assert.equal((await call(repair,'/repair-orders/'+o.id+'/transition','POST',completeBody)).version,o.version);assert.equal(query(`SELECT count(*) n FROM repair_external_slots WHERE order_id='${o.id}'`)[0].n,'0');await act(o,'update',{diagnosis:'不能编辑'},409);results.push('待配件阻止完工、取机凭证和结清检查、完成幂等并释放外部串码');
 // 本店机：真实入库→送修→费用归集→取消/完成均回待复检。
 const base=await call(stock,'/templates/t_phone'),cat=await call(stock,'/catalog/categories','POST',{label:'维修'+fixture.tag.slice(0,8),copyTemplateId:base.id});const fields=base.fields.map(f=>['supplier','receipt'].includes(f.key)?{...f,required:false}:f);const t=await call(stock,'/templates/'+cat.templateId+'/versions','POST',{baseVersion:1,fields});const model=await call(stock,'/models','POST',{category:cat.value,name:'维修库存验证'+fixture.tag,brandLabel:'验证',series:'验证'});const attributes=Object.fromEntries(fields.filter(f=>f.required||f.default!==undefined).map(f=>[f.key,f.default!==undefined?f.default:f.type==='select'?f.options[0]:f.type==='number'?90:'验证']));
 const unit=await call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:t.version,inspectionConfirmed:true,attributes,imei1:imei(),cost:'1000.12',retail:1500,wholesale:1400,agentBase:1300,flags:{showInShop:true}});
 let own=await call(repair,'/repair-orders','POST',{requestKey:key(),kind:'inventory',unitId:unit.id,fault:'库存机维修'});assert.equal((await call(stock,'/units/'+unit.id)).status,'repairing');assert.equal((await call(stock,'/units/'+unit.id)).flags.showInShop,false);own=await act(own,'payment',{kind:'expense',amount:'10.01',method:'现金',confirmed:true});await act(own,'payment',{kind:'receipt',amount:1,method:'现金',confirmed:true},400);own=await act(own,'transition',{to:'cancelled'});assert.equal((await call(stock,'/units/'+unit.id)).status,'recheck');assert.equal((await call(stock,'/units/'+unit.id)).cost,1010.13);assert.equal(Number(own.costAllocation.total_cost),10.01);await act(own,'payment',{kind:'expense',amount:1,method:'现金',confirmed:true},409);results.push('库存机送修关闭分享、对客收款拒绝、取消后成本资本化且回待复检、归档不重复加成本');
 // 跨域认领，错误必须回滚整个操作与版本。
 await call(repair,'/repair-orders','POST',{...create,requestKey:key(),identifier:imei(),photos:[{fileId:expense.fileId}]},400);
 const externalCode=imei();const raced=await Promise.all([raw(repair,'/repair-orders','POST',{...create,requestKey:key(),identifier:externalCode,photos:[]}),raw(repair,'/repair-orders','POST',{...create,requestKey:key(),identifier:externalCode,photos:[]})]);assert.deepEqual(raced.map(r=>r.code).sort(),[0,409]);results.push('费用凭证不能降级为外观照片，外部相同串码并发开单仅一单');
 // 两种成本策略和非法配置均连接真实PG，不用模拟返回值。
 const unit2=await call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:t.version,inspectionConfirmed:true,attributes,imei1:imei(),cost:'1000.12',retail:1500,wholesale:1400,agentBase:1300});
 let separate=await call(repair,'/repair-orders','POST',{requestKey:key(),kind:'inventory',unitId:unit2.id,fault:'单列成本验证'});separate=await act(separate,'payment',{kind:'expense',amount:'10.01',method:'现金',confirmed:true});
 try{process.env.REPAIR_INTERNAL_COST_POLICY='invalid';await act(separate,'transition',{to:'cancelled'},503);assert.equal((await call(stock,'/units/'+unit2.id)).status,'repairing');assert.equal((await call(repair,'/repair-orders/'+separate.id)).version,separate.version);process.env.REPAIR_INTERNAL_COST_POLICY='separate';separate=await act(separate,'transition',{to:'cancelled'});assert.equal((await call(stock,'/units/'+unit2.id)).cost,1000.12);assert.equal(separate.costAllocation.policy,'separate');}finally{delete process.env.REPAIR_INTERNAL_COST_POLICY;}
 results.push('非法库存维修成本策略完整回滚，separate单列费用不加库存成本');
 const ext=async()=>call(repair,'/repair-orders','POST',{...create,requestKey:key(),identifier:imei(),photos:[]});
 const started=async r=>{r=await act(r,'transition',{to:'checking'});r=await act(r,'update',{diagnosis:'验证检测'});r=await act(r,'quote',{amount:0});r=await act(r,'transition',{to:'pending_confirm'});r=await act(r,'confirm',{quoteVersion:r.quoteVersion,confirmed:true});return act(r,'transition',{to:'repairing'});};
 let weighted=await call(repair,'/repair-parts','POST',{sku:'weighted-'+fixture.tag,name:'加权成本验证'});weighted=await call(repair,'/repair-parts/'+weighted.id+'/receive','POST',{requestKey:key(),version:weighted.version,quantity:2,unitCost:'0.01',reason:'第一批'});weighted=await call(repair,'/repair-parts/'+weighted.id+'/receive','POST',{requestKey:key(),version:weighted.version,quantity:1,unitCost:'0.02',reason:'第二批'});
 let wo=await started(await ext());wo=await act(wo,'parts/issue',{partId:weighted.id,quantity:2});assert.equal(wo.partsCost,0.03);const wi=wo.parts[0].id;wo=await act(wo,'parts/return',{issueId:wi,quantity:1});assert.equal(wo.partsCost,0.01);wo=await act(wo,'parts/return',{issueId:wi,quantity:1});assert.equal(wo.partsCost,0);const restored=(await call(repair,'/repair-parts','GET',{keyword:weighted.sku})).list[0];assert.equal(restored.quantity,3);assert.equal(restored.stockValue,0.04);results.push('多批配件加权到分与部分退料成本守恒，零元报价有效');
 let last=await call(repair,'/repair-parts','POST',{sku:'last-'+fixture.tag,name:'最后一件'});last=await call(repair,'/repair-parts/'+last.id+'/receive','POST',{requestKey:key(),version:1,quantity:1,unitCost:1,reason:'并发测试库存'});const wo2=await started(await ext());
 const issuance=await Promise.all([wo,wo2].map(r=>raw(repair,'/repair-orders/'+r.id+'/parts/issue','POST',body(r,{partId:last.id,quantity:1}))));assert.deepEqual(issuance.map(r=>r.code).sort(),[0,409]);assert.equal((await call(repair,'/repair-parts','GET',{keyword:last.sku})).list[0].quantity,0);results.push('两个维修单并发争用最后一件配件，仅一个成功且库存不透支');
 const empty=await call(repair,'/repair-orders/stats','GET',{from:'1900-01-01',to:'1900-01-01'});assert.equal(empty.created,0);assert.equal(empty.revenue,0);const scoped=await call(repair,'/repair-orders/stats','GET',{engineerId:eng2});assert.equal(scoped.revenue,101.01);results.push('统计空范围补零，按工程师过滤实际收支且不混入本店维修成本');
 const grants=execute("SELECT relname,has_table_privilege('service_role',oid,'UPDATE') can_update,has_table_privilege('service_role',oid,'DELETE') can_delete FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN('repair_events','repair_files','repair_part_ledger','repair_payments','repair_cost_allocations')").data.previewRows;assert.ok(grants.every(g=>g.can_update==='false'&&g.can_delete==='false'));const auditCount=Number(query(`SELECT count(*) n FROM audit_logs WHERE object_id='${o.id}' AND action LIKE '维修处理:%' AND reason<>''`)[0].n);assert.ok(auditCount>=10);results.push('维修事件/凭证/配件流水/收支/成本分摊只追加，原因审计真实落库');
 fs.writeFileSync(`${local}/repair-fixture.json`,JSON.stringify({...fixture,orderId:o.id,ownOrderId:own.id,unitId:unit.id,engineerId:eng,partId:part.id}));fs.writeFileSync(`${local}/repair-results.json`,JSON.stringify({passed:results,evidence:{auditCount,grants}},null,2));console.log(JSON.stringify({results}));
})().catch(e=>{console.error(e);process.exitCode=1;});
/** 补充跨业务锁、库存维修完成路径与外部串码释放，不重跑整套主夹具。 */
async function extraChecks(){
 const previous=JSON.parse(fs.readFileSync(`${local}/repair-fixture.json`)),groups=[];
 const oldUnit=await call(stock,'/units/'+previous.unitId),form=await call(stock,'/models/'+oldUnit.modelId+'/form');
 const phone='199'+String(Date.now()).slice(-8),external=()=>({requestKey:key(),kind:'external',model:'跨域验证机',identifier:imei(),customer:'云端验证顾客',phone,fault:'交接检测',photos:[]});
 const shared=(await upload(png)).file;
 const claim=await Promise.all([raw(repair,'/repair-orders','POST',{...external(),photos:[{fileId:shared.fileId}]}),raw(loans,'/loans','POST',{requestKey:key(),type:'borrow_in',devices:[{modelId:oldUnit.modelId,imei1:imei()}],counterparty:'跨域验证',phone,dueAt:'2030-01-01',reason:'跨域认领验证',photos:[{fileId:shared.fileId}]})]);assert.equal(claim.filter(r=>r.code===0).length,1);assert.ok(claim.some(r=>[400,409].includes(r.code)));groups.push('维修与借还并发认领同一内部照片，仅一个业务成功');
 const attributes=Object.fromEntries(oldUnit.parameters.map(f=>[f.key,f.value]));const inbound=code=>({modelId:oldUnit.modelId,templateVersion:form.version,inspectionConfirmed:true,attributes,imei1:code,cost:'1000.12',retail:1500,wholesale:1400,agentBase:1300,flags:{showInShop:true}});
 const ownUnit=await call(stock,'/inbound/units','POST',inbound(imei()));let own=await call(repair,'/repair-orders','POST',{requestKey:key(),kind:'inventory',unitId:ownUnit.id,fault:'完整完工验证'});
 own=await act(own,'transition',{to:'checking'});own=await act(own,'update',{diagnosis:'真实库存机检测'});own=await act(own,'quote',{amount:0});own=await act(own,'transition',{to:'pending_confirm'});own=await act(own,'confirm',{quoteVersion:own.quoteVersion,confirmed:true});own=await act(own,'transition',{to:'repairing'});
 let part=await call(repair,'/repair-parts','POST',{sku:'extra-'+fixture.tag,name:'库存机完工配件'});part=await call(repair,'/repair-parts/'+part.id+'/receive','POST',{requestKey:key(),version:1,quantity:1,unitCost:'0.02',reason:'真实配件采购'});own=await act(own,'parts/issue',{partId:part.id,quantity:1});own=await act(own,'payment',{kind:'expense',amount:'0.07',method:'现金',confirmed:true});own=await act(own,'transition',{to:'pending_pickup',result:'已修复并检查'});
 const pickup=(await upload(png)).file,done=body(own,{to:'completed',pickupName:'内部交接',pickupProof:[{fileId:pickup.fileId}],warrantyDays:30});own=await call(repair,'/repair-orders/'+own.id+'/transition','POST',done);assert.equal(own.status,'completed');assert.equal(Number(own.costAllocation.total_cost),0.09);const after=await call(stock,'/units/'+ownUnit.id);assert.equal(after.status,'recheck');assert.equal(after.cost,1000.21);assert.equal(after.flags.showInShop,false);assert.equal((await call(repair,'/repair-orders/'+own.id+'/transition','POST',done)).version,own.version);groups.push('库存机完整检测/报价确认/领料/费用/交接完工，成本归集一次且回待复检');
 await call(repair,'/repair-orders','POST',{...external(),identifier:after.imei1},409);
 const extData=external();let ext=await call(repair,'/repair-orders','POST',extData);await call(stock,'/inbound/units','POST',inbound(extData.identifier),409);await call(loans,'/loans','POST',{requestKey:key(),type:'borrow_in',devices:[{modelId:oldUnit.modelId,imei1:extData.identifier}],counterparty:'不可借入',phone,dueAt:'2030-01-01',reason:'占用检查'},409);
 ext=await act(ext,'transition',{to:'checking'});ext=await act(ext,'quote',{amount:1});ext=await act(ext,'payment',{kind:'receipt',amount:1,method:'现金',confirmed:true});await act(ext,'transition',{to:'cancelled'},409);ext=await act(ext,'payment',{kind:'refund',amount:1,method:'现金',confirmed:true});ext=await act(ext,'transition',{to:'cancelled'});const released=await call(stock,'/inbound/units','POST',inbound(extData.identifier));assert.equal((await call(stock,'/units/'+released.id)).status,'in_stock');groups.push('外部维修串码占用阻止入库/借入，未退清不能取消，退清取消释放后可真实入库');
 fs.writeFileSync(`${local}/repair-extra-results.json`,JSON.stringify({passed:groups,concurrentClaimCodes:claim.map(r=>r.code),completedOrder:own.id},null,2));console.log(JSON.stringify({results:groups}));
}
async function boundsChecks(){
 let o=await call(repair,'/repair-orders','POST',{requestKey:key(),kind:'external',model:'累计金额上限专用验证机',customer:'隔离金额验证夹具',phone:'199'+String(Date.now()).slice(-8),fault:'仅用于累计金额边界验证'});
 o=await act(o,'payment',{kind:'expense',amount:'600000000000.00',method:'现金',confirmed:true});
 await act(o,'payment',{kind:'expense',amount:'600000000000.00',method:'现金',confirmed:true},400);
 const current=await call(repair,'/repair-orders/'+o.id);assert.equal(current.version,o.version);assert.equal(current.expenses,600000000000);assert.equal(current.payments.length,1);assert.equal(current.timeline.length,2);assert.equal(query(`SELECT count(*) n FROM audit_logs WHERE object_id='${o.id}'`)[0].n,'2');
 const rows=query(`SELECT count(*) AS n FROM repair_payments WHERE order_id='${o.id}'`);assert.equal(rows[0].n,'1');
 fs.writeFileSync(`${local}/repair-bounds-results.json`,JSON.stringify({passed:['单笔金额合法但累计费用超限时，第二笔、事件、版本和审计全部回滚'],version:current.version,paymentCount:1},null,2));console.log('累计金额边界验收通过');
}
async function identifierChecks(){
 const prev=JSON.parse(fs.readFileSync(`${local}/repair-fixture.json`)),oldUnit=await call(stock,'/units/'+prev.unitId),form=await call(stock,'/models/'+oldUnit.modelId+'/form');const attributes=Object.fromEntries(oldUnit.parameters.map(f=>[f.key,f.value]));const phone='199'+String(Date.now()).slice(-8),pairs=[];
 for(let i=0;i<3;i++){
  const code=imei(),external={requestKey:key(),kind:'external',model:'并发串码验证机',identifier:code,customer:'验证顾客',phone,fault:'串码并发验证'};
  const inbound={modelId:oldUnit.modelId,templateVersion:form.version,inspectionConfirmed:true,attributes,imei1:code,cost:1000,retail:1500,wholesale:1400,agentBase:1300};
  const r=await Promise.all([raw(repair,'/repair-orders','POST',external),raw(stock,'/inbound/units','POST',inbound)]);assert.deepEqual(r.map(v=>v.code).sort(),[0,409]);pairs.push(r.map(v=>v.code));
 }
 const code=imei(),external={requestKey:key(),kind:'external',model:'维修借入争用验证机',identifier:code,customer:'验证顾客',phone,fault:'串码并发验证'},borrow={requestKey:key(),type:'borrow_in',devices:[{modelId:oldUnit.modelId,imei1:code}],counterparty:'验证往来方',phone,dueAt:'2030-01-01',reason:'真实并发争用'};
 const r=await Promise.all([raw(repair,'/repair-orders','POST',external),raw(loans,'/loans','POST',borrow)]);assert.deepEqual(r.map(v=>v.code).sort(),[0,409]);
 fs.writeFileSync(`${local}/repair-identifier-results.json`,JSON.stringify({passed:['外部维修与真实库存入库争用同串码，连续3组均仅一个成功','外部维修与借入争用同串码仅一个成功'],inboundPairs:pairs,borrowPair:r.map(v=>v.code)},null,2));console.log(JSON.stringify({inboundPairs:pairs,borrowPair:r.map(v=>v.code)}));
}
