const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path');
const original=Module._load;
Module._load=function(name,...args){if(name==='wx-server-sdk')return {init(){},getWXContext:()=>({OPENID:'test-platform'})};if(args[0]?.filename.startsWith(path.join(__dirname,'../cloudfunctions/common/'))&&['roles','status','template','validate'].some(k=>name==='./'+k)){const k=name.slice(2);return original.call(this,path.join(__dirname,'../miniprogram',['roles','status'].includes(k)?'constants':'utils',k),...args);}return original.call(this,name,...args);};
const {prepare}=require('../cloudfunctions/common/loan-input');const {view}=require('../cloudfunctions/common/loan-view');Module._load=original;
const uid='00000000-0000-0000-0000-000000000001',user={id:uid,visibleFields:[],permissions:['loan:manage','inventory:view','acceptance:do']};
const body={requestKey:'test',type:'loan_out',unitIds:[uid],counterparty:'同行',phone:'19900000001',dueAt:'2030-01-01',reason:'实际交接'};
test('云借还拒绝收费、未知字段、伪造直接通过与缺归还凭证',()=>{
 for(const extra of [{deposit:1},{overdueFee:'1'},{compensation:'abc'},{status:'closed'}])assert.throws(()=>prepare('create',{...body,...extra},null,user));
 assert.throws(()=>prepare('recheck',{requestKey:'test',version:1,reason:'测试',pass:true,unitIds:[uid]},uid,user));
 assert.throws(()=>prepare('return',{requestKey:'test',version:1,reason:'测试',items:[{unitId:uid,condition:'正常',photos:[]}]},uid,user));
 for(const v of [0,'0',null,''])assert.ok(prepare('create',{...body,deposit:v},null,user));
});
test('云借还幂等摘要不依赖对象键顺序，内容与操作者变化会冲突',()=>{
 const a=prepare('create',body,null,user);assert.equal(a.signature,prepare('create',Object.fromEntries(Object.entries(body).reverse()),null,user).signature);
 assert.notEqual(a.signature,prepare('create',{...body,reason:'不同交接'},null,user).signature);assert.notEqual(a.signature,prepare('create',body,null,{...user,id:uid+'2'}).signature);
});
test('云借还拒绝重复主副串码及非法日期，分页上限与旧接口一致',()=>{
 assert.throws(()=>prepare('create',{...body,type:'borrow_in',unitIds:undefined,devices:[{modelId:'test',imei1:'350000000000006',imei2:'350000000000006'}]},null,user));
 assert.throws(()=>prepare('create',{...body,dueAt:'2030-02-30'},null,user));assert.equal(prepare('list',{page:2,pageSize:1000},null,user).offset,1000);
});
test('云借还从设备快照裁剪完整IMEI与成本，部分归还仍显示逾期',()=>{
 const row={id:uid,type:'loan_out',status:'active',due_date:'2020-01-01',version:2,items:[{id:uid,unit_id:uid,status:'active',unit_status:'loaned_out',snapshot:{name:'设备',modelId:'model',imei1:'350000000000006',imei2:'',cost:999}}],attached:[],events:[]};
 const v=view('get',row,user,{});assert.equal(v.status,'overdue');assert.equal(v.items[0].imei1,undefined);assert.equal(v.items[0].cost,undefined);assert.equal(v.items[0].imeiMasked,'35****0006');assert.equal(v.financialPolicy,'none');assert.equal(v.supportsPayments,false);
 assert.equal(view('get',row,{...user,visibleFields:['fullImei']},{}).items[0].imei1,'350000000000006');
});
