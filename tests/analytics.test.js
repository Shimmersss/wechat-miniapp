const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};const mock=require('../miniprogram/mock');const call=(url,method='GET',data={})=>mock.handle({url,method,data});
test('统计mock无固定数字，访问重试去重、空销售和图表契约一致',async()=>{
 const data={visitorId:'visitor_test',events:[{eventId:'event_test',type:'pv',route:'pages/shop/index'}]};
 assert.equal((await call('/visits/batch','POST',data)).data.accepted,1);assert.equal((await call('/visits/batch','POST',data)).data.accepted,0);
 const visits=(await call('/stats/visits')).data;assert.equal(visits.uv,1);assert.equal(visits.pv,1);assert.equal(visits.consults,0);
 const overview=(await call('/stats/overview')).data;assert.equal(overview.qty,0);assert.equal(overview.amount,0);
 assert.equal((await call('/stats/trend')).data.list.length,1);assert.equal((await call('/stats/visit-trend')).data.list[0].uv,1);
 assert.ok(Array.isArray((await call('/stats/breakdown')).data.list));assert.equal((await call('/staff/dashboard')).data.visits.uv,1);
 role='sales';assert.equal((await call('/stats/overview')).data.profit,undefined);role='customer';assert.equal((await call('/stats/visits')).code,403);
});
