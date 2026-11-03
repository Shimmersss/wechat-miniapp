const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};
const mock=require('../miniprogram/mock'),db=require('../miniprogram/mock/data');const call=(url,method='GET',data={})=>mock.handle({url,method,data});
test('销售mock实际扣库与退款，不回假成功；版本、权限、快照和幂等',async()=>{
 const unit=db.units.find(u=>u.status==='in_stock'),id=unit.id;
 const row={unitId:id,priceVersion:1},payload={requestKey:'test-sale',items:[row],payMethod:'现金',paymentConfirmed:true};
 role='sales';assert.equal((await call('/sales/quote','POST',{items:[{...row,price:'1'}]})).code,403);
 let r=await call('/sales/quote','POST',{items:[row]});assert.equal(r.code,0);assert.equal(r.data.total,unit.retail);
 r=await call('/sales-orders','POST',payload);assert.equal(r.code,0);const order=r.data;assert.equal(order.profit,undefined);assert.equal(unit.status,'sold');
 assert.equal((await call('/sales-orders','POST',payload)).data.id,order.id);assert.equal((await call('/sales-orders','POST',{...payload,requestKey:'another'})).code,409);
 role='boss';const before=(await call('/sales-orders/'+order.id)).data;unit.retail=1;assert.equal((await call('/sales-orders/'+order.id)).data.amount,before.amount);
 const refund={requestKey:'test-refund',kind:'return',reason:'验证退货',items:[{itemId:order.items[0].id}]};
 r=await call('/sales-orders/'+order.id+'/refund','POST',refund);assert.equal(r.code,0);assert.equal(r.data.status,'refunded');assert.equal(unit.status,'recheck');
 assert.equal((await call('/sales-orders/'+order.id+'/refund','POST',refund)).data.refunds.length,1);
 assert.equal((await call('/sales-orders/'+order.id+'/refund','POST',{...refund,requestKey:'duplicate'})).code,409);
 role='customer';assert.equal((await call('/sales-orders/'+order.id)).code,403);
});
