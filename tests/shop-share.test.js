const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};
const mock=require('../miniprogram/mock'),db=require('../miniprogram/mock/data');
const call=(url,method='GET',data={},share='')=>mock.handle({url,method,data,header:{'X-Channel':share}});
test('分享mock保存真实记录与渠道，禁止伪造代理前缀，合集/版本/撤销/访问归因一致',async()=>{
 const a=db.units.find(u=>u.status==='in_stock'&&u.flags.showInShop&&u.flags.sharePeer),b=db.units.find(u=>u.id!==a.id&&u.status==='in_stock'&&u.flags.showInShop);
 const s=(await call('/share/links','POST',{unitId:a.id,channel:'customer'})).data;assert.match(s.path,/\?s=[A-Za-z0-9_-]{16}$/);assert.equal(s.units[0].cost,undefined);assert.equal(s.units[0].imei1,undefined);
 role='customer';assert.equal((await call('/shop/shares/'+s.shareId)).data.units[0].price,a.retail);assert.equal((await call('/shop/units/'+a.id,'GET',{},'agent_fake')).code,404);assert.equal((await call('/share/links','POST',{unitId:a.id,channel:'peer'})).code,403);
 role='sales';const peer=(await call('/share/links','POST',{unitId:a.id,channel:'peer'})).data;role='customer';assert.equal((await call('/shop/shares/'+peer.shareId)).code,403);role='peer';assert.equal((await call('/shop/shares/'+peer.shareId)).data.units[0].price,a.wholesale);
 await call('/visits/batch','POST',{visitorId:'sharing_visitor',events:[{eventId:'sharing_event',type:'pv',route:'packages/shop/product/index'}]},peer.shareId);
 role='boss';assert.equal((await call('/stats/visits')).data.bySource.peer,1);
 const collection=(await call('/share/links','POST',{unitIds:[a.id,b.id]})).data;assert.ok(collection.path.startsWith('/packages/shop/collection/'));assert.equal(collection.units.length,2);
 await call('/share/links/'+s.shareId+'/revoke','PATCH',{reason:'撤销旧分享'});assert.equal((await call('/shop/shares/'+s.shareId)).code,404);
 await call('/units/'+a.id+'/price','PATCH',{retail:String(a.retail+1),priceVersion:a.priceVersion||1,reason:'更新价格'});assert.equal((await call('/shop/shares/'+collection.shareId)).code,410);
});
