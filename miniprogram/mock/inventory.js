const {PERM,UNIT_STATUS,SENSITIVE_FIELDS}=Object.assign({},require('../constants/roles'),require('../constants/status'));
const {validateValues}=require('../utils/template');
// 必须在顶层普通 require：写在展开语法里，开发者工具「忽略未使用文件」的
// 静态依赖分析识别不到，mock/stocktake.js 不会进包，整个 mock 层会加载失败。
const createStocktake=require('./stocktake');
module.exports=function(db,{fail,requirePermission,clone,paginate,currentRole,staffUnit,validateFiles}){
 let seq=0;db.inventoryLedger=db.inventoryLedger||[];
 const uid=()=> 'inventory_'+Date.now()+'_'+ ++seq;
 const find=id=>db.units.find(u=>u.id===id)||fail(404,'设备不存在');
 const visible=key=>!SENSITIVE_FIELDS[key]||SENSITIVE_FIELDS[key].includes(currentRole());
 const read=()=>requirePermission(PERM.INVENTORY_VIEW);
 const amount=v=>{if(!/^\d{1,12}(\.\d{1,2})?$/.test(String(v)))fail(400,'价格须为非负金额，最多两位小数');return Number(v);};
 const note=(action,u,reason)=>db.auditLogs.unshift({id:uid(),time:new Date().toISOString(),operator:currentRole(),action,detail:u.id,reason});
 const ledger=(u,from,to,docType,reason)=>db.inventoryLedger.unshift({id:uid(),unitId:u.id,time:new Date().toISOString(),from,to,docType,doc:uid(),operator:currentRole(),reason});
 function form(u){const snap=u.templateSnapshot||{version:1,fields:[]};const fields=snap.fields.filter(f=>f.key!=='supplier'&&visible(f.key)&&(!f.visibility.includes('internal')||visible('internalNote')));const view=staffUnit(u);const values=Object.fromEntries((view.parameters||[]).filter(p=>fields.some(f=>f.key===p.key)).map(p=>[p.key,p.value]));return{unitId:u.id,name:u.name,templateVersion:snap.version,inspectionVersion:u.inspectionVersion||1,fields:clone(fields),values,hiddenKeys:fields.filter(f=>f.type==='image'&&!(values[f.key]||[]).length&&(u.attributes[f.key]||[]).length).map(f=>f.key)};}
 /** 单台详情契约（GET/改价/复检一致）：有借还权限且设备在未完结借还单中时带 loan */
 function unitDetail(raw){const u=staffUnit(raw);let canLoan=true;try{requirePermission(PERM.LOAN_MANAGE);}catch(e){canLoan=false;}const o=canLoan&&(db.loanTransactions||[]).find(o=>o.items.some(i=>i.unitId===raw.id&&i.status!=='closed'));if(o)u.loan={id:o.id,no:o.no,type:o.type};return u;}
 return[
 ...createStocktake(db,{fail,requirePermission,clone,paginate,currentRole,staffUnit}),
 ['GET','/units',d=>{read();let rows=db.units;if(d.status){if(!UNIT_STATUS[d.status])fail(400,'库存状态无效');rows=rows.filter(u=>u.status===d.status);}if(d.modelId)rows=rows.filter(u=>u.modelId===d.modelId);
 if(d.keyword){const key=String(d.keyword);if(/^\d+$/.test(key)&&key.length!==15&&!visible('fullImei'))fail(400,'串码查询请扫描完整 IMEI');rows=rows.filter(u=>u.name.includes(key)||u.id===key||u.imei1===key||u.imei2===key);}
 if(d.imei)rows=rows.filter(u=>u.imei1===d.imei||u.imei2===d.imei);
 if(d.ageingOver!==undefined){if(!/^\d+$/.test(String(d.ageingOver)))fail(400,'库龄无效');rows=rows.filter(u=>u.ageDays>=Number(d.ageingOver));}
 if(d.minPrice!==undefined)rows=rows.filter(u=>u.retail>=amount(d.minPrice));if(d.maxPrice!==undefined)rows=rows.filter(u=>u.retail<=amount(d.maxPrice));
 const counts={all:db.units.length};db.units.forEach(u=>counts[u.status]=(counts[u.status]||0)+1);
 const owned=db.units.filter(u=>u.status==='in_stock'),total=k=>Math.round(owned.reduce((n,u)=>n+Number(u[k]||0),0)*100)/100;
 const stock={inStock:owned.length,retailTotal:total('retail'),...(visible('cost')?{costTotal:total('cost')}:{})};
 return{...paginate(rows.map(staffUnit),d),counts,summary:stock};}],
 ['PATCH','/units/share-flags',d=>{read();requirePermission(PERM.SHARE);const ids=Array.isArray(d.unitIds)?[...new Set(d.unitIds)]:[];if(Object.keys(d).some(k=>!['unitIds','shareAgent'].includes(k))||typeof d.shareAgent!=='boolean'||!ids.length||ids.length>100)fail(400,'请选择 1～100 台设备并指定开关');const units=ids.map(find);if(d.shareAgent&&units.some(u=>u.status!=='in_stock'))fail(409,'只有在库可售设备能开启代理转发，请刷新后重选');units.forEach(u=>{u.flags={...u.flags,shareAgent:d.shareAgent};note('批量调整代理转发',u,'');});return{updated:units.length,shareAgent:d.shareAgent};}],
 ['GET','/units/:id',(d,h,p)=>{read();return unitDetail(find(p.id));}],
 ['PATCH','/units/:id/price',(d,h,p)=>{read();requirePermission(PERM.PRICE_EDIT);const u=find(p.id);if(u.status!=='in_stock'||d.priceVersion!==(u.priceVersion||1))fail(409,'状态或价格已更新，请刷新');if(!d.reason||!d.reason.trim())fail(400,'请填写改价原因');const keys=['retail','wholesale','agentBase'].filter(k=>d[k]!==undefined);if(!keys.length||Object.keys(d).some(k=>!['retail','wholesale','agentBase','priceVersion','reason'].includes(k)))fail(400,'改价参数无效');const after=Object.fromEntries(keys.map(k=>[k,amount(d[k])]));Object.assign(u,after,{priceVersion:(u.priceVersion||1)+1});note('修改库存价格',u,d.reason);return unitDetail(u);}],
 ['PATCH','/units/:id/share-flags',(d,h,p)=>{read();requirePermission(PERM.SHARE);const u=find(p.id);if(!d||Object.keys(d).some(k=>!['showInShop','sharePeer','shareAgent'].includes(k)||typeof d[k]!=='boolean'))fail(400,'共享参数无效');const after={...u.flags,...d};if(u.status!=='in_stock'&&Object.values(after).some(Boolean))fail(409,'只有在库可售设备能分享');u.flags=after;note('调整库存共享范围',u,'');return clone(after);}],
 ['GET','/units/:id/ledger',(d,h,p)=>{read();find(p.id);return clone(paginate(db.inventoryLedger.filter(l=>l.unitId===p.id),d));}],
 ['GET','/units/:id/recheck-form',(d,h,p)=>{read();requirePermission(PERM.ACCEPTANCE);const u=find(p.id);if(u.status!=='recheck')fail(409,'设备不在待复检状态');return form(u);}],
 ['POST','/units/:id/recheck',(d,h,p)=>{read();requirePermission(PERM.ACCEPTANCE);const u=find(p.id);if(u.status!=='recheck'||d.inspectionVersion!==(u.inspectionVersion||1))fail(409,'复检状态或版本已更新');if(!['pass','fail'].includes(d.result)||!d.reason||!d.reason.trim())fail(400,'请填写复检结论和原因');const fields=(u.templateSnapshot||{}).fields||[], input=d.attributes||{},values=clone(u.attributes||{});if(typeof input!=='object'||Array.isArray(input))fail(400,'复检参数无效');for(const k of Object.keys(input)){const f=form(u).fields.find(f=>f.key===k);if(!f)fail(403,'无权修改复检字段');values[k]=f.type==='image'?validateFiles(input[k],f.visibility.includes('internal')?'internal':'public'):input[k];}const error=validateValues(fields,values);if(error)fail(400,error);if(d.result==='pass'&&values.refurbishment==='正在整备')fail(400,'整备尚未完成');u.attributes=values;u.status=d.result==='pass'?'in_stock':'recheck';u.inspectionVersion=(u.inspectionVersion||1)+1;for(const k of ['storage','color','grade','battery','version'])u[k]=values[k];ledger(u,'recheck',u.status,'recheck',d.reason);note('库存复检',u,d.reason);return unitDetail(u);}],
 ['GET','/units/:id/label',(d,h,p)=>{read();requirePermission(PERM.LABEL_PRINT);const u=find(p.id);return{unitId:u.id,name:u.name,storage:u.storage,grade:u.grade,retail:u.retail,qrcodeText:u.id,imeiMasked:staffUnit(u).imeiMasked};}],
 ];
};
