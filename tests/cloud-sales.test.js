const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const original=Module._load;
Module._load=function(name,...args){
 if(name==='wx-server-sdk')return {init(){},getWXContext(){return {OPENID:'platform'}}};
 if(args[0]?.filename.startsWith(path.join(__dirname,'../cloudfunctions/common/'))&&['roles','status','template','validate'].some(k=>name==='./'+k)){const key=name.slice(2);return original.call(this,path.join(__dirname,'../miniprogram',['roles','status'].includes(key)?'constants':'utils',key),...args);}
 return original.call(this,name,...args);
};
const {prepare}=require('../cloudfunctions/common/stock-input');
const {sale}=require('../cloudfunctions/common/stock-view');
const {ROLE_PERMISSIONS,defaultVisibleFields}=require('../miniprogram/constants/roles');
Module._load=original;
const user=role=>({role,visibleFields:defaultVisibleFields(role),permissions:ROLE_PERMISSIONS[role]});
const row={amount:1500,cost_total:1000,items:[{id:'i',unit_id:'u',name:'设备',price:1500,cost:1000,refunded:200,reversed:0,returned:false}],refunds:[{id:'r',kind:'adjustment',amount:200}],agentSources:[{orderId:'a',sharePrice:1500,markup:100,earnings:[{amount:100}]}],attached:[]};
test('差价退款净额与毛利正确，销售视图不泄露成本和代理加价',()=>{
 const boss=sale(row,user('boss'),true);assert.equal(boss.status,'partially_refunded');assert.equal(boss.refundAmount,200);assert.equal(boss.netAmount,1300);assert.equal(boss.profit,300);assert.equal(boss.items[0].returnable,true);
 const sales=sale(row,user('sales'),true);assert.equal(Object.hasOwn(sales,'profit'),false);assert.equal(Object.hasOwn(sales.items[0],'cost'),false);assert.equal(Object.hasOwn(sales.agentSources[0],'markup'),false);assert.equal(Object.hasOwn(sales.agentSources[0],'earnings'),false);
});
test('整机退货冲回成本，原始销售快照不因退款被改写',()=>{
 const input={...row,items:[{...row.items[0],returned:true,refunded:1500,reversed:1000}],refunds:[...row.refunds,{kind:'return',amount:1300}]};
 const result=sale(input,user('boss'));assert.equal(result.status,'refunded');assert.equal(result.netAmount,0);assert.equal(result.profit,0);assert.equal(result.amount,1500);assert.equal(result.items[0].returnable,false);
});
test('退款原因、差价金额和重复明细在入库前校验',()=>{
 const userValue=user('boss');const base={requestKey:'key',reason:'退货',items:[{itemId:'i'}]};
 assert.throws(()=>prepare('sales.refund',{...base,reason:''},{},userValue),/退款原因/);
 assert.throws(()=>prepare('sales.refund',{...base,kind:'adjustment'},{},userValue),/金额/);
 assert.throws(()=>prepare('sales.refund',{...base,items:[{itemId:'i'},{itemId:'i'}]},{},userValue),/重复/);
});
