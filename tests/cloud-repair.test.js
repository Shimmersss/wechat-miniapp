const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path');
const load=Module._load;Module._load=function(name,...args){if(name==='wx-server-sdk')return {init(){},getWXContext:()=>({OPENID:'platform'})};if(args[0]?.filename.startsWith(path.join(__dirname,'../cloudfunctions/common/'))&&['roles','status','template','validate'].some(k=>name==='./'+k)){const k=name.slice(2);return load.call(this,path.join(__dirname,'../miniprogram',['roles','status'].includes(k)?'constants':'utils',k),...args);}return load.call(this,name,...args);};
const {prepare}=require('../cloudfunctions/common/repair-input'),{view}=require('../cloudfunctions/common/repair-view');Module._load=load;
const id='00000000-0000-0000-0000-000000000001',u={id,permissions:['repair:handle','repair:assign'],visibleFields:[]};
const creation={requestKey:'create',model:'设备',customer:'顾客',phone:'19900000001',fault:'不开机'};
test('云维修不保存密码、所有修改必须带版本和原因，金额与质保有界',()=>{
 assert.throws(()=>prepare('create',{...creation,password:'secret'},null,u));assert.throws(()=>prepare('quote',{requestKey:'x',amount:10,reason:'报价'},id,u));assert.throws(()=>prepare('quote',{requestKey:'x',version:1,amount:10},id,u));
 assert.throws(()=>prepare('payment',{requestKey:'x',version:1,reason:'真实办理',amount:'0.001'},id,u));assert.throws(()=>prepare('transition',{requestKey:'x',version:1,reason:'完成',to:'completed',warrantyDays:-1},id,u));assert.equal(prepare('quote',{requestKey:'x',version:1,reason:'零元方案',amount:0},id,u).amount,'0');
});
test('配件采购摘要使用准确分值，维修请求摘要对对象键顺序稳定',()=>{
 const d={requestKey:'receive',quantity:3,unitCost:'1.15',version:1,reason:'采购'};assert.equal(prepare('parts.receive',d,id,u).signature,prepare('parts.receive',{...d,unitCost:1.15},id,u).signature);
 assert.equal(prepare('create',creation,null,u).signature,prepare('create',Object.fromEntries(Object.entries(creation).reverse()),null,u).signature);
});
test('维修响应裁剪所有费用入口，不能从事件、付款或配件泄露成本',()=>{
 const row={id,kind:'external',identifier:'350000000000006',status:'checking',quote:null,quote_version:0,version:1,totals:{received:100,parts:20,expenses:5},attached:[],allocation:{total_cost:25},events:[{internal_data:{amount:5},public_data:{kind:'expense'}}],parts:[{id,cost_amount:20}],payments:[{kind:'expense',amount:5},{kind:'receipt',amount:100}],request_hash:'hidden',creator_id:'hidden'};
 const r=view('get',row,u,{});for(const k of ['partsCost','expenses','costAllocation','profit','identifier','request_hash','creator_id'])assert.equal(Object.hasOwn(r,k),false,k);assert.equal(r.timeline[0].costData,undefined);assert.equal(r.parts[0].cost,undefined);assert.equal(r.payments.length,1);assert.equal(r.imeiMasked,'35****0006');
 const boss=view('get',row,{...u,visibleFields:['cost','fullImei','profit'],permissions:[...u.permissions,'profit:view']},{});assert.equal(boss.partsCost,20);assert.equal(boss.profit,75);
});
test('维修统计使用北京时间边界，限制366天并裁剪成本利润；看板固定200条',()=>{
 const d=prepare('stats',{from:'2030-01-01',to:'2030-01-01'},null,u);assert.equal(d.start,'2029-12-31T16:00:00.000Z');assert.equal(d.end,'2030-01-01T16:00:00.000Z');assert.throws(()=>prepare('stats',{from:'2030-01-01',to:'2032-01-01'},null,u));assert.equal(prepare('board',{pageSize:999},null,u).pageSize,200);
 const r=view('stats',{created:0,completed:0,cohort_completed:0,avg_hours:0,revenue:0,parts:3,expenses:2,internal_cost:9},u,{});assert.equal(r.completionRate,0);assert.equal(r.partsCost,undefined);assert.equal(r.profit,undefined);
});
