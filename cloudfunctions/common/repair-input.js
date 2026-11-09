const {fail,hash}=require('./gateway');
const {text,integer,money}=require('./stock-input');
const {isPhone,isImei}=require('./validate');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const uuid=v=>{const s=text(v,'记录标识',36);if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s))fail(400,'记录标识无效');return s;};
function date(v){const s=text(v,'日期',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)fail(400,'日期格式无效');return s;}
function photos(v){if(v===undefined)return [];if(!Array.isArray(v)||v.length>9)fail(400,'每组附件最多9张');const ids=v.map(f=>uuid(f?.fileId));if(new Set(ids).size!==ids.length)fail(400,'附件重复');return ids.map(fileId=>({fileId}));}
const keys={create:['requestKey','kind','unitId','model','identifier','customer','phone','fault','engineerId','expectedAt','photos'],update:['customer','phone','fault','engineerId','expectedAt','diagnosis','waitingParts','photos'],quote:['amount'],confirm:['quoteVersion','confirmed'],issue:['partId','quantity'],return_parts:['issueId','quantity'],payment:['kind','amount','method','confirmed','proof'],transition:['to','result','pickupName','pickupProof','warrantyDays']};
function prepare(action,input,id,user){
 if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'提交参数无效');const d={...input};if(id)uuid(id);
 if(keys[action]){
  const allowed=action==='create'?keys.create:['requestKey','version','reason',...keys[action]];if(Object.keys(d).some(k=>!allowed.includes(k)))fail(400,'提交参数无效；不保存开机密码');
  d.signature=hash(JSON.stringify(canonical(action==='create'?{actor:user.id,...input}:{action,actor:user.id,...input})));d.requestKey=text(d.requestKey,'提交标识',100);
  if(action!=='create'){d.version=integer(d.version,'版本',1,2147483647);d.reason=text(d.reason,'处理说明',500);}
 }
 if(['list','board','parts.list','parts.ledger'].includes(action)){d.page=integer(d.page||1,'页码',1,1000000);d.pageSize=action==='board'?200:integer(d.pageSize||20,'每页数量',1,1000);d.offset=(d.page-1)*d.pageSize;if(d.keyword)d.keyword=text(d.keyword,'搜索',100);}
 if(['list','board'].includes(action)&&d.status&&!['pending_check','checking','pending_confirm','repairing','pending_pickup','completed','cancelled'].includes(d.status))fail(400,'维修状态无效');
 if(d.engineerId)d.engineerId=uuid(d.engineerId);
 if(action==='create'){
  d.kind=d.kind||'external';if(!['external','inventory'].includes(d.kind))fail(400,'维修来源无效');d.fault=text(d.fault,'故障',2000);
  if(d.kind==='inventory')d.unitId=uuid(d.unitId);else{if(d.unitId)fail(400,'外部送修不得关联本店库存');d.model=text(d.model,'设备型号',120);d.customer=text(d.customer,'联系人',100);d.phone=text(d.phone,'联系电话',30);if(!isPhone(d.phone))fail(400,'请填写11位联系电话');d.identifier=text(d.identifier,'IMEI/序列号',80,true).toUpperCase();if(/^\d{15}$/.test(d.identifier)&&!isImei(d.identifier))fail(400,'IMEI校验位无效');}
 }
 if(['create','update'].includes(action)){
  for(const [k,max]of [['fault',2000],['diagnosis',2000],['customer',100],['phone',30]])if(d[k]!==undefined)d[k]=text(d[k],k,max);
  if(d.phone!==undefined&&!isPhone(d.phone))fail(400,'联系电话格式无效');if(d.expectedAt)d.expectedAt=date(d.expectedAt);
  if(d.waitingParts!==undefined&&typeof d.waitingParts!=='boolean')fail(400,'待配件标记无效');d.photos=photos(d.photos);
 }
 if(['quote','payment'].includes(action))d.amount=money(d.amount);
 if(['issue','return_parts','parts.receive'].includes(action))d.quantity=integer(d.quantity,'数量',1,1000000);
 if(action==='issue')d.partId=uuid(d.partId);if(action==='return_parts')d.issueId=uuid(d.issueId);
 if(action==='confirm'){if(d.quoteVersion!==undefined&&typeof d.quoteVersion!=='number')fail(409,'请核对当前报价版本');}
 if(action==='payment')d.proof=photos(d.proof);
 if(action==='transition')d.pickupProof=photos(d.pickupProof);
 if(action==='transition'&&d.to==='completed')d.warrantyDays=integer(d.warrantyDays,'维修质保天数',0,3650);
 if(action==='parts.create'){d.sku=text(d.sku,'配件SKU',80);d.name=text(d.name,'配件名称',120);d.unit=text(d.unit||'件','计量单位',20);}
 if(action==='parts.receive'){
  d.unitCost=money(d.unitCost);d.reason=text(d.reason,'入库说明',500);d.requestKey=text(d.requestKey,'提交标识',100);d.version=integer(d.version,'版本',1,2147483647);
  d.signature=hash(JSON.stringify(canonical({target:id,qty:d.quantity,price:Number(BigInt(d.unitCost.split('.')[0])*100n+BigInt((d.unitCost.split('.')[1]||'').padEnd(2,'0'))),reason:d.reason,version:d.version})));
 }
 if(action==='stats'){
  const DAY=86400000,today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),now=Date.parse(today+'T00:00:00+08:00');let start=now,end=now+DAY;
  if(d.from||d.to){if(!d.from||!d.to)fail(400,'请同时填写起止日期');start=Date.parse(date(d.from)+'T00:00:00+08:00');end=Date.parse(date(d.to)+'T00:00:00+08:00')+DAY;if(end<=start||end-start>366*DAY)fail(400,'统计范围需为1～366天');}
  else{const range=d.range||'day';if(!['day','week','month'].includes(range))fail(400,'统计周期无效');if(range==='week')start=now-((new Date(now+8*3600000).getUTCDay()+6)%7)*DAY;if(range==='month')start=Date.parse(today.slice(0,8)+'01T00:00:00+08:00');}
  d.start=new Date(start).toISOString();d.end=new Date(end).toISOString();
 }
 return d;
}
module.exports={prepare};
