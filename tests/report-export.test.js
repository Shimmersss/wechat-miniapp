const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};const mock=require('../miniprogram/mock');const call=(url,method='GET',data={})=>mock.handle({url,method,data});
test('导出mock真实生成CSV，理由与权限、幂等和内容接口',async()=>{
 const d={requestKey:'report_fixture',range:'day',reason:'验证导出'};assert.equal((await call('/stats/export','POST',{...d,reason:''})).code,400);
 const r=await call('/stats/export','POST',d);assert.equal(r.code,0);assert.equal((await call('/stats/export','POST',d)).data.id,r.data.id);
 const content=await call('/stats/exports/'+r.data.id);assert.equal(content.code,0);assert.ok(content.data.csv.startsWith('\uFEFF'));assert.ok(content.data.csv.includes('销售单号'));
 role='manager';assert.equal((await call('/stats/exports/'+r.data.id)).code,404);role='sales';assert.equal((await call('/stats/export','POST',d)).code,403);
});
