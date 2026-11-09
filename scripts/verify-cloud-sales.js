#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的销售退款集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-sales.js。使用已登录 tcb/mcporter、functions.env。
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
Module._load = original;
const results=[];
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const raw=(handler,url,method='GET',data={})=>handler({path:url,method,data,headers:{Authorization:'Bearer '+fixture.token}},{request_id:'sales-verification-'+fixture.tag});
async function call(handler,url,method='GET',data={},expected=0){const r=await raw(handler,url,method,data);assert.equal(r.code,expected,JSON.stringify(r));return r.data;}
const imei=()=>{const s='35'+String(crypto.randomInt(1e12)).padStart(12,'0');let n=0;for(let i=0;i<14;i++){const d=+s[i]*(i%2?2:1);n+=Math.floor(d/10)+d%10;}return s+((10-n%10)%10);};
(async()=>{
 const base=await call(stock,'/templates/t_phone');
 const category=await call(stock,'/catalog/categories','POST',{label:'退款验证'+fixture.tag.slice(0,8),copyTemplateId:base.id});
 const fields=base.fields.map(f=>['supplier','receipt'].includes(f.key)?{...f,required:false}:f);
 const template=await call(stock,'/templates/'+category.templateId+'/versions','POST',{baseVersion:1,fields});
 const model=await call(stock,'/models','POST',{category:category.value,name:'退款验证机型-'+fixture.tag,brandLabel:'验证品牌',series:'退款验证',specs:{storage:['128G'],color:['黑色']}});
 const attributes=Object.fromEntries(fields.filter(f=>f.required||f.default!==undefined).map(f=>[f.key,f.default!==undefined?f.default:f.type==='select'?f.options[0]:f.type==='number'?90:'验证']));attributes.storage='128G';attributes.color='黑色';
 const sold=[];
 for(let i=0;i<4;i++){
  const unit=await call(stock,'/inbound/units','POST',{modelId:model.id,templateVersion:template.version,inspectionConfirmed:true,attributes,imei1:imei(),cost:1000,retail:1500,wholesale:1400,agentBase:1300});
  const order=await call(sales,'/sales-orders','POST',{items:[{unitId:unit.id,priceVersion:1}],requestKey:fixture.tag+'sale'+i,payMethod:'现金',paymentConfirmed:true});sold.push({unit,order});
 }
 const first=sold[0],url='/sales-orders/'+first.order.id+'/refund';
 const adjustment={kind:'adjustment',reason:'真实差价退款验证',requestKey:fixture.tag+'adjust',items:[{itemId:first.order.items[0].id,amount:100}]};
 const adjusted=await call(sales,url,'POST',adjustment);assert.equal(adjusted.netAmount,1400);assert.equal(adjusted.profit,400);assert.equal((await call(stock,'/units/'+first.unit.id)).status,'sold');results.push('差价退款不回库、净额与毛利正确');
 await call(sales,url,'POST',{...adjustment,requestKey:fixture.tag+'over',items:[{itemId:first.order.items[0].id,amount:1500}]},400);
 const returned=await call(sales,url,'POST',{reason:'整机退货验证',requestKey:fixture.tag+'return',items:[{itemId:first.order.items[0].id}]});assert.equal(returned.status,'refunded');assert.equal(returned.netAmount,0);assert.equal(returned.profit,0);assert.equal(returned.amount,1500);assert.equal((await call(stock,'/units/'+first.unit.id)).status,'recheck');results.push('整机退货进入待复检、成本冲回且销售快照不变');
 const replay=await call(sales,url,'POST',{reason:'整机退货验证',requestKey:fixture.tag+'return',items:[{itemId:first.order.items[0].id}]});assert.equal(replay.refunds.length,2);
 await call(sales,url,'POST',{reason:'不同内容',requestKey:fixture.tag+'return',items:[{itemId:first.order.items[0].id}]},409);results.push('超额退款拒绝、幂等重试与标识冲突');
 const second=sold[1];const concurrent=await Promise.all([1,2].map(i=>raw(sales,'/sales-orders/'+second.order.id+'/refund','POST',{reason:'并发退货验证',requestKey:fixture.tag+'concurrent'+i,items:[{itemId:second.order.items[0].id}]})));assert.deepEqual(concurrent.map(r=>r.code).sort(),[0,409]);results.push('同销售明细并发退货仅一个成功');
 // 部分代理模块尚未迁移：用真实PG夹具建立旧端可产生的订单/收益状态，验证退款边界。
 const agent=crypto.randomUUID(),share='vr'+fixture.tag.replaceAll('-','').slice(0,20);
 let sql=`INSERT INTO users(id,openid,role) VALUES('${agent}','agent-verify-${fixture.tag}','agent'); INSERT INTO agents(user_id,status,name,phone,region) VALUES('${agent}','active','退款验证代理','','验证地区'); INSERT INTO share_links(id,owner_id,owner_kind,channel,expires_at) VALUES('${share}','${agent}','agent','agent',now()+interval '1 day');`;
 const seeded=[];
 for(let i=2;i<4;i++){const s=sold[i],request=crypto.randomUUID(),earning=crypto.randomUUID();seeded.push({request,earning});sql+=`INSERT INTO customer_requests(id,owner_id,kind,phone,source,request_key,request_hash) VALUES('${request}','${fixture.uid}','order','','agent','${fixture.tag}agent${i}','test'); INSERT INTO agent_orders(request_id,agent_id,unit_id,share_id,agent_base,markup,share_price,price_version,lock_expires_at) VALUES('${request}','${agent}','${s.unit.id}','${share}',1400,100,1500,1,now()); INSERT INTO agent_order_states(request_id,status,sale_order_id) VALUES('${request}','sold','${s.order.id}'); INSERT INTO agent_earnings(id,agent_id,request_id,sale_order_id,kind,amount) VALUES('${earning}','${agent}','${request}','${s.order.id}','earning',100); INSERT INTO agent_earning_states(earning_id,status) VALUES('${earning}','${i===2?'pending':'settled'}');`;}
 control('managePgDatabase',{action:'execute',confirm:true,sql});
 for(let i=2;i<4;i++){const s=sold[i];await call(sales,'/sales-orders/'+s.order.id+'/refund','POST',{reason:'代理收益退货冲回验证',requestKey:fixture.tag+'agentrefund'+i,items:[{itemId:s.order.items[0].id}]});}
 const earned=control('queryPgDatabase',{action:'sql',sql:`SELECT e.kind,s.status,e.reversal_of,e.amount FROM agent_earnings e JOIN agent_earning_states s ON s.earning_id=e.id WHERE e.agent_id='${agent}' ORDER BY e.kind,e.id`}).data.rows;
 assert.equal(earned.filter(x=>x.status==='reversed').length,1);assert.equal(earned.filter(x=>x.kind==='reversal'&&x.status==='pending'&&x.reversal_of===seeded[1].earning).length,1);results.push('待转账收益冲回；已转账收益追加负向记录');
 const list=await call(sales,'/sales-orders','GET',{status:'refunded',sellerId:fixture.uid,from:day,to:day});assert.equal(list.total,4);await call(sales,'/sales-orders/sellers');results.push('销售列表、日期/销售员/状态筛选与详情查询');
 control('managePgDatabase',{action:'execute',confirm:true,sql:`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`});
 await call(sales,url,'POST',adjustment,403);const detail=await call(sales,'/sales-orders/'+sold[2].order.id);assert.equal(Object.hasOwn(detail,'profit'),false);assert.equal(Object.hasOwn(detail.items[0],'cost'),false);assert.equal(Object.hasOwn(detail.agentSources[0],'markup'),false);results.push('销售角色无退款权限，成本/毛利/代理收益裁剪');
 const audit=control('queryPgDatabase',{action:'sql',sql:`SELECT count(*) n FROM audit_logs WHERE request_id='sales-verification-${fixture.tag}' AND action='销售退款' AND reason<>''`}).data.rows[0];assert.equal(Number(audit.n),5);results.push('退款原因审计真实落库');
 fs.writeFileSync(`${local}/sales-fixture.json`,JSON.stringify({...fixture,sold}));fs.writeFileSync(`${local}/sales-results.json`,JSON.stringify({date:day,passed:results},null,2));console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1});
