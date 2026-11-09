/** 与 server/src/loans.js 的输入规则相同；先对原始请求做稳定摘要，再规范化字段。 */
const {fail,hash}=require('./gateway');
const {text,integer}=require('./stock-input');
const {isPhone,isImei}=require('./validate');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function allowed(d,keys){if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!keys.includes(k)))fail(400,'借还参数无效');}
function uuid(v){const s=text(v,'记录标识',36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s))fail(400,'记录标识无效');return s;}
function rows(v,label){if(!Array.isArray(v)||!v.length||v.length>50)fail(400,label);return v;}
function photos(v,required=false){if(v===undefined)v=[];if(!Array.isArray(v)||v.length>9||(required&&!v.length))fail(400,'交接凭证须为1～9张内部图片');const ids=v.map(f=>uuid(f?.fileId));if(new Set(ids).size!==ids.length)fail(400,'凭证重复');return ids.map(fileId=>({fileId}));}
function prepare(action,input,id,user){
 const d={...input};if(id)uuid(id);
 if(action==='options'||action==='get')return d;
 if(action==='list'){
  d.page=integer(d.page||1,'页码',1,1000000);d.pageSize=integer(d.pageSize||20,'每页数量',1,1000);d.offset=(d.page-1)*d.pageSize;
  if(d.type&&!['loan_out','borrow_in'].includes(d.type))fail(400,'借还类型无效');
  if(d.status&&!['active','overdue','returned_recheck','closed'].includes(d.status))fail(400,'借还状态无效');
  if(d.keyword)d.keyword=text(d.keyword,'搜索',100);return d;
 }
 allowed(input,action==='create'?['requestKey','type','unitIds','devices','counterparty','phone','dueAt','remark','reason','photos','deposit','overdueFee','compensation']:['requestKey','version','reason',action==='return'?'items':'unitIds']);
 for(const k of ['deposit','overdueFee','compensation'])if(d[k]!==undefined&&d[k]!==null&&d[k]!==''&&Number(d[k])!==0)fail(400,'首期不收押金、逾期费与损坏赔偿，请勿填写金额');
 d.signature=hash(JSON.stringify(canonical(action==='create'?{actor:user.id,...input}:{action,actor:user.id,...input})));
 d.requestKey=text(d.requestKey,'提交标识',100);d.reason=text(d.reason,'处理说明',500);
 if(action==='create'){
  d.counterparty=text(d.counterparty,'对方',120);d.phone=text(d.phone,'联系电话',30);d.remark=text(d.remark||'','备注',2000,true);d.dueAt=text(d.dueAt,'日期',10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d.dueAt)||!Number.isFinite(Date.parse(d.dueAt))||new Date(d.dueAt).toISOString().slice(0,10)!==d.dueAt)fail(400,'日期格式无效');
  if(!['loan_out','borrow_in'].includes(d.type)||!isPhone(d.phone))fail(400,'请核对借还类型和11位联系电话');
  if(d.type==='loan_out'&&d.devices!==undefined||d.type==='borrow_in'&&d.unitIds!==undefined)fail(400,'每单须有1～50台且类型与设备匹配');
  d.photos=photos(d.photos);
  if(d.type==='loan_out'){d.unitIds=rows(d.unitIds,'每单须有1～50台').map(uuid);if(new Set(d.unitIds).size!==d.unitIds.length)fail(400,'设备重复');}
  else{
   const seen=new Set();d.devices=rows(d.devices,'每单须有1～50台').map(x=>{allowed(x,['modelId','imei1','imei2','condition','description']);const r={modelId:text(x.modelId,'型号',60),imei1:text(x.imei1,'IMEI1',15),imei2:text(x.imei2||'','IMEI2',15,true),condition:x.condition||'used',description:text(x.description||'','设备交接描述',2000,true)};
    if(!['new','used'].includes(r.condition))fail(400,'设备类型无效');for(const code of [r.imei1,r.imei2].filter(Boolean)){if(!isImei(code)||seen.has(code))fail(400,'借入串码无效或重复');seen.add(code);}return r;});
  }
 }else{
  d.version=integer(d.version,'版本',1,2147483647);
  if(action==='return'){
   const seen=new Set();d.items=rows(d.items,'请选择逐台归还设备').map(x=>{allowed(x,['unitId','condition','damage','photos']);const unitId=uuid(x.unitId);if(seen.has(unitId))fail(400,'设备重复');seen.add(unitId);return {unitId,condition:text(x.condition,'归还外观和功能结论',2000),damage:text(x.damage||'','损坏描述',2000,true),photos:photos(x.photos,true)};});
  }else{d.unitIds=rows(d.unitIds,'请选择已实际通过库存复检的设备').map(uuid);if(new Set(d.unitIds).size!==d.unitIds.length)fail(400,'设备重复');}
 }
 return d;
}
module.exports={prepare};
