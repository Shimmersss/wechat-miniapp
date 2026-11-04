const test=require('node:test'),assert=require('node:assert/strict');let role='customer';global.wx={getStorageSync:()=>role};
const mock=require('../miniprogram/mock'),db=require('../miniprogram/mock/data');const call=(url,method='GET',data={})=>mock.handle({url,method,data,header:{}});
const ids=async q=>{const r=await call('/shop/units','GET',{pageSize:100,...q});assert.equal(r.code,0,r.message);return r.data.list.map(u=>u.id);};
test('顾客搜索 mock：成色/电池/价格按渠道公开取值筛选，非法条件拒绝',async()=>{
 role='customer';const shop=db.units.filter(u=>u.status==='in_stock'&&u.flags.showInShop);assert.ok(shop.length>=2);
 const u=shop[0],battery=Number(String(u.battery).replace('%',''));
 assert.ok((await ids({grade:u.grade})).includes(u.id));assert.ok((await ids({grade:'不存在成色'})).length===0);
 assert.deepEqual(await ids({priceMin:u.retail,priceMax:u.retail}),shop.filter(x=>x.retail===u.retail).map(x=>x.id));
 assert.ok((await ids({batteryMin:battery})).includes(u.id));assert.ok(!(await ids({batteryMin:battery+1})).includes(u.id)||battery===100);
 for(const bad of [{priceMin:'abc'},{batteryMin:'101'},{priceMin:'10',priceMax:'5'}])assert.equal((await call('/shop/units','GET',bad)).code,400);
 // 模板未对顾客公开电池时，筛选不能命中
 const saved=u.templateSnapshot;u.templateSnapshot={...(saved||{}),fields:[{key:'battery',label:'电池',type:'number',visibility:['internal']}]};
 try{assert.ok(!(await ids({batteryMin:0})).includes(u.id));assert.ok((await ids({})).includes(u.id));}finally{u.templateSnapshot=saved;}
 // 同行按同行价筛选
 const p=db.units.find(x=>x.status==='in_stock'&&x.flags.sharePeer&&x.wholesale<x.retail);
 if(p){role='peer';assert.ok((await ids({priceMax:p.wholesale})).includes(p.id));role='customer';if(p.flags.showInShop)assert.ok(!(await ids({priceMax:p.wholesale})).includes(p.id));}
});
test('分类 mock：型号带 id，已建档型号可精确筛选',async()=>{
 role='customer';const models=(await call('/shop/categories')).data.flatMap(c=>c.brands).flatMap(b=>b.series).flatMap(s=>s.models);
 assert.ok(models.every(m=>typeof m.name==='string'&&'id' in m));const known=models.find(m=>m.id&&db.units.some(u=>u.modelId===m.id&&u.status==='in_stock'&&u.flags.showInShop));
 assert.ok(known);const got=await ids({modelId:known.id});assert.ok(got.length>0);assert.ok(got.every(id=>db.units.find(u=>u.id===id).modelId===known.id));
});
test('销售员筛选 mock：选项来自已有销售单，按 sellerId 过滤',async()=>{
 role='boss';const unit=db.units.find(u=>u.status==='in_stock');
 const r=await call('/sales-orders','POST',{requestKey:'seller-filter',items:[{unitId:unit.id,priceVersion:unit.priceVersion||1}],payMethod:'现金',paymentConfirmed:true});assert.equal(r.code,0,r.message);
 const sellers=(await call('/sales-orders/sellers')).data;assert.ok(sellers.some(s=>s.id==='mock_boss'));
 const list=(await call('/sales-orders','GET',{sellerId:'mock_boss',pageSize:100})).data.list;assert.ok(list.some(o=>o.id===r.data.id));assert.ok(list.every(o=>o.sellerId==='mock_boss'));
 role='customer';assert.equal((await call('/sales-orders/sellers')).code,403);
});
