const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};
const db=require('../miniprogram/mock/data'),mock=require('../miniprogram/mock');const call=(url,method='GET',data={})=>mock.handle({url,method,data});
test('员工与权限 mock：增改停用解绑、老板保护、角色改动即时影响字段可见性、日志筛选',async()=>{
 let r=await call('/staff','POST',{name:'新人',phone:'13700000001',roleKey:'sales',reason:'入职'});assert.equal(r.code,0);const s=r.data;
 assert.equal((await call('/staff','POST',{name:'重复',phone:'13700000001',roleKey:'sales',reason:'入职'})).code,409);
 role='manager';assert.equal((await call('/staff','POST',{name:'越权',phone:'13700000002',roleKey:'boss',reason:'x'})).code,403);
 assert.equal((await call('/staff/st1','PATCH',{status:'disabled',reason:'x',version:1})).code,403);
 assert.equal((await call('/staff/st2','PATCH',{status:'disabled',reason:'自己',version:1})).code,400);
 r=await call('/staff/'+s.id,'PATCH',{roleKey:'warehouse',reason:'调岗',version:s.version});assert.equal(r.data.roleKey,'warehouse');
 assert.equal((await call('/staff/st3/unbind','POST',{reason:'换机',version:1})).data.wechatBound,false);
 assert.equal((await call('/roles/sales','PUT',{permissions:[],visibleFields:[],reason:'x',version:1})).code,403);
 role='sales';const unit=db.units[0];assert.equal((await call('/units/'+unit.id)).data.cost,undefined);assert.equal((await call('/staff')).code,403);
 role='boss';const sales=(await call('/roles')).data.list.find(x=>x.key==='sales');
 assert.equal((await call('/roles/boss','PUT',{...sales,reason:'x'})).code,400);
 r=await call('/roles/sales','PUT',{permissions:sales.permissions,visibleFields:[...sales.visibleFields,'cost'],reason:'允许看成本',version:sales.version});assert.equal(r.code,0);
 role='sales';assert.equal((await call('/units/'+unit.id)).data.cost,unit.cost);
 role='boss';await call('/roles/sales','PUT',{permissions:sales.permissions,visibleFields:sales.visibleFields,reason:'还原',version:sales.version+1});
 role='sales';assert.equal((await call('/units/'+unit.id)).data.cost,undefined);
 role='boss';const logs=(await call('/audit-logs','GET',{action:'调整角色权限与字段可见性'})).data;assert.equal(logs.total,2);assert.equal(logs.list[0].actorName,'老板');
 assert.ok((await call('/audit-logs/filters')).data.actions.includes('新增员工'));
});

test('供应商 mock：保留接口权限但撤销字段权限时，查询和增改均拒绝',async()=>{
 role='boss';const manager=(await call('/roles')).data.list.find(r=>r.key==='manager');
 const supplier=(await call('/suppliers','POST',{name:'字段撤权验证'})).data;
 try {
  assert.equal((await call('/roles/manager','PUT',{permissions:manager.permissions,visibleFields:manager.visibleFields.filter(f=>f!=='supplier'),reason:'验证撤权',version:manager.version})).code,0);
  role='manager';
  assert.equal((await call('/suppliers')).code,403);
  assert.equal((await call('/suppliers','POST',{name:'不应创建'})).code,403);
  assert.equal((await call('/suppliers/'+supplier.id,'PUT',{name:'不应修改'})).code,403);
 } finally {
  role='boss';const current=(await call('/roles')).data.list.find(r=>r.key==='manager');
  await call('/roles/manager','PUT',{permissions:manager.permissions,visibleFields:manager.visibleFields,reason:'还原验证配置',version:current.version});
 }
 role='manager';assert.equal((await call('/suppliers')).code,0);role='boss';
});
