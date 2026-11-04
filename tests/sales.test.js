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

test('收款凭证 mock：开单可选上传、补传需说明且不重复、按销售权限读取、不能跨单复用',async()=>{
 role='sales';const unit=db.units.find(u=>u.status==='in_stock'&&(!u.ownership||u.ownership==='own')),file=mock.registerFile({filePath:'/tmp/receipt.png',scope:'internal'});
 role='boss';const other=mock.registerFile({filePath:'/tmp/boss.png',scope:'internal'});
 role='sales';assert.equal((await call('/sales-orders','POST',{requestKey:'receipt-bad',items:[{unitId:unit.id,priceVersion:unit.priceVersion||1}],payMethod:'现金',paymentConfirmed:true,receipts:[{fileId:other.fileId}]})).code,403);
 const r=await call('/sales-orders','POST',{requestKey:'receipt-ok',items:[{unitId:unit.id,priceVersion:unit.priceVersion||1}],payMethod:'现金',paymentConfirmed:true,receipts:[{fileId:file.fileId}]});assert.equal(r.code,0,r.message);
 assert.deepEqual((await call('/sales-orders/'+r.data.id)).data.receipts.map(x=>x.fileId),[file.fileId]);
 role='warehouse';assert.equal((await call('/files/'+file.fileId)).code,403);role='boss';assert.equal((await call('/files/'+file.fileId)).code,0);
 role='sales';const more=mock.registerFile({filePath:'/tmp/more.png',scope:'internal'}),url='/sales-orders/'+r.data.id+'/receipts';
 assert.equal((await call(url,'POST',{receipts:[{fileId:more.fileId}]})).code,400);
 assert.equal((await call(url,'POST',{receipts:[{fileId:more.fileId}],reason:'补传'})).data.receipts.length,2);
 assert.equal((await call(url,'POST',{receipts:[{fileId:more.fileId}],reason:'补传'})).data.receipts.length,2);
 role='warehouse';assert.equal((await call(url,'POST',{receipts:[{fileId:more.fileId}],reason:'补传'})).code,403);
 role='boss';const sold=(await call('/sales-orders/'+r.data.id)).data;for(let i=0;i<2;i++){const back=await call('/sales-orders/'+r.data.id+'/refund','POST',{requestKey:'receipt-refund',kind:'adjustment',reason:'回包验证',items:[{itemId:sold.items[0].id,amount:'1'}]});assert.equal(back.code,0,back.message);assert.equal(back.data.receipts.length,2);assert.ok(Array.isArray(back.data.agentSources));}
 role='sales';const next=db.units.find(u=>u.status==='in_stock'&&u.id!==unit.id&&(!u.ownership||u.ownership==='own'));
 if(next)assert.equal((await call('/sales-orders','POST',{requestKey:'receipt-reuse',items:[{unitId:next.id,priceVersion:next.priceVersion||1}],payMethod:'现金',paymentConfirmed:true,receipts:[{fileId:file.fileId}]})).code,409);
 role='boss';
});
