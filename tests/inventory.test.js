const test=require('node:test'),assert=require('node:assert/strict');let role='boss';global.wx={getStorageSync:()=>role};const db=require('../miniprogram/mock/data'),mock=require('../miniprogram/mock');const call=(url,method='GET',data={})=>mock.handle({url,method,data});
test('库存 mock：改价版本、分享状态、复检与盘点历史真正保存',async()=>{
 const unit=db.units.find(u=>u.status==='in_stock'), id=unit.id;
 let r=await call('/units/'+id);const version=r.data.priceVersion;
 assert.equal((await call('/units/'+id+'/price','PATCH',{retail:'1234.56',priceVersion:version,reason:'验证改价'})).code,0);
 assert.equal((await call('/units/'+id)).data.retail,1234.56);
 assert.equal((await call('/units/'+id+'/price','PATCH',{retail:1,priceVersion:version,reason:'旧版本'})).code,409);
 assert.equal((await call('/units/'+id+'/share-flags','PATCH',{showInShop:false})).data.showInShop,false);
 const snapshot={version:1,fields:[{key:'refurbishment',label:'整备',type:'select',required:true,visibility:['internal'],options:['正在整备','整备完成']}]};
 unit.templateSnapshot=snapshot;unit.attributes={refurbishment:'正在整备'};unit.status='recheck';unit.flags={showInShop:false,sharePeer:false,shareAgent:false};
 r=await call('/units/'+id+'/recheck-form');assert.equal(r.code,0);
 assert.equal((await call('/units/'+id+'/recheck','POST',{inspectionVersion:r.data.inspectionVersion,result:'pass',reason:'验证复检',attributes:{refurbishment:'整备完成'}})).code,0);
 assert.equal((await call('/units/'+id)).data.status,'in_stock');assert.equal((await call('/units/'+id+'/ledger')).data.total,1);
 // 盘点单：开单快照、边扫边勾、重复不计、范围外与未知记异常、结束生成结果、差异处理只追加不改库存
 const other=db.units.find(u=>u.status==='in_stock'&&u.id!==id),sold=db.units.find(u=>u.status==='sold');
 const start={requestKey:'fixture-stocktake',statuses:['in_stock']};
 r=await call('/stocktake-sessions','POST',start);assert.equal(r.code,0);const sid=r.data.id,expected=r.data.expectedCount;assert.ok(expected>=2);
 assert.equal((await call('/stocktake-sessions','POST',start)).data.id,sid);
 assert.equal((await call('/stocktake-sessions','POST',{...start,note:'不同内容'})).code,409);
 assert.equal((await call('/stocktake-sessions','POST',{requestKey:'bad-scope',statuses:['sold']})).code,400);
 r=await call('/stocktake-sessions/'+sid+'/scans','POST',{code:id});assert.equal(r.data.result,'matched');assert.equal(r.data.scannedCount,1);
 if(unit.imei1){r=await call('/stocktake-sessions/'+sid+'/scans','POST',{code:unit.imei1});assert.equal(r.data.result,'duplicate');assert.equal(r.data.scannedCount,1);}
 r=await call('/stocktake-sessions/'+sid+'/scans','POST',{code:'UNKNOWN'});assert.equal(r.data.result,'unknown');
 if(sold){r=await call('/stocktake-sessions/'+sid+'/scans','POST',{code:sold.id});assert.equal(r.data.result,'out_of_scope');assert.match(r.data.message,/已售/);}
 assert.equal((await call('/stocktake-sessions/'+sid+'/scans','POST',{code:'UNKNOWN'})).data.result,'duplicate');
 assert.equal((await call('/stocktake-sessions/'+sid+'/units',"GET",{state:'pending'})).data.total,expected-1);
 assert.equal((await call('/stocktake-sessions/'+sid+'/units',"GET",{state:'extra'})).data.total,sold?2:1);
 other.status='loaned_out';// 盘点期间离店
 r=await call('/stocktake-sessions/'+sid+'/close','POST');assert.equal(r.code,0);const recordId=r.data.id;
 other.status='in_stock';
 assert.equal(r.data.matched,1);assert.ok(r.data.changed.some(c=>c.id===other.id&&c.to==='loaned_out'));assert.ok(!r.data.missingIds.includes(other.id));
 assert.equal(r.data.missing.length,expected-2);assert.equal(r.data.openCount,r.data.missing.length+r.data.extra.length);
 assert.equal((await call('/stocktake-sessions/'+sid+'/close','POST')).data.id,recordId);
 assert.equal((await call('/stocktake-sessions/'+sid+'/scans','POST',{code:other.id})).code,409);
 assert.equal((await call('/stocktakes')).data.total,1);assert.equal((await call('/stocktakes/'+recordId)).data.id,recordId);
 if(r.data.missing.length){const target=r.data.missing[0].id,before=db.units.find(u=>u.id===target).status;
  assert.equal((await call('/stocktakes/'+recordId+'/resolutions','POST',{type:'unit',target,resolution:'handled',note:'x'})).code,400);
  r=await call('/stocktakes/'+recordId+'/resolutions','POST',{type:'unit',target,resolution:'lost',note:'确认丢失'});assert.equal(r.data.missing[0].resolution.resolution,'lost');
  assert.equal(db.units.find(u=>u.id===target).status,before);}
 r=await call('/stocktakes/'+recordId+'/resolutions','POST',{type:'extra',target:'0',resolution:'handled',note:'已核实'});assert.equal(r.data.extra[0].resolution.label,'已处理');
 const cancelled=(await call('/stocktake-sessions','POST',{requestKey:'fixture-cancel'})).data;
 assert.equal((await call('/stocktake-sessions/'+cancelled.id+'/cancel','POST',{reason:''})).code,400);
 assert.equal((await call('/stocktake-sessions/'+cancelled.id+'/cancel','POST',{reason:'范围选错'})).data.status,'cancelled');
 assert.equal((await call('/stocktake-sessions',"GET",{status:'open'})).data.total,0);
 role='sales';assert.equal((await call('/units/'+id+'/price','PATCH',{retail:1})).code,403);assert.equal((await call('/stocktake-sessions')).code,403);assert.equal((await call('/stocktakes')).code,403);
 role='customer';assert.equal((await call('/units/'+id)).code,403);
});
test('库存 mock：在库汇总只算 in_stock，成本总额按角色裁剪',async()=>{
 role='boss';const owned=db.units.filter(u=>u.status==='in_stock');
 let r=await call('/units',"GET",{status:'sold'});assert.equal(r.code,0);
 assert.equal(r.data.summary.inStock,owned.length);
 assert.equal(r.data.summary.retailTotal,Math.round(owned.reduce((n,u)=>n+u.retail,0)*100)/100);
 assert.equal(r.data.summary.costTotal,Math.round(owned.reduce((n,u)=>n+u.cost,0)*100)/100);
 role='sales';r=await call('/units');assert.equal(r.code,0);
 assert.equal(r.data.summary.inStock,owned.length);assert.equal(r.data.summary.costTotal,undefined);
 role='boss';
});
test('库存 mock：批量代理转发整批校验，非在库不能开启',async()=>{
 role='boss';const ok=db.units.filter(u=>u.status==='in_stock').slice(0,2).map(u=>u.id);
 let r=await call('/units/share-flags','PATCH',{unitIds:ok,shareAgent:false});assert.equal(r.code,0);assert.equal(r.data.updated,ok.length);
 assert.ok(ok.every(id=>db.units.find(u=>u.id===id).flags.shareAgent===false));
 const off=db.units.find(u=>!ok.includes(u.id)),status=off.status;off.status='repairing';
 r=await call('/units/share-flags','PATCH',{unitIds:[ok[0],off.id],shareAgent:true});off.status=status;
 assert.equal(r.code,409);assert.equal(db.units.find(u=>u.id===ok[0]).flags.shareAgent,false);
 assert.equal((await call('/units/share-flags','PATCH',{unitIds:[],shareAgent:true})).code,400);
 role='warehouse';assert.equal((await call('/units/share-flags','PATCH',{unitIds:ok,shareAgent:true})).code,403);role='boss';
});
