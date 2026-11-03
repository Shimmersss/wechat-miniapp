/** 代理 mock：与服务端同规则（加价归代理、固定金额上限、链接下单锁库、按分享价成交记收益、退货冲回、线下转账标记） */
const {PERM,STAFF_ROLES}=require('../constants/roles');
const {isPhone}=require('../utils/validate');
module.exports=function(db,{fail,currentRole,requirePermission,paginate,clone,publicUnit}){
 const agents=db.agentProfiles=db.agentProfiles||[{userId:'mock_agent',status:'active',name:'张代理',phone:'13800001234',region:'深圳',inviterId:null,inviteCode:'XM8K2Q',markupMax:500,reviewRemark:'',appliedAt:'2026-11-01T02:00:00.000Z',version:2}];
 const settings=db.agentSettings=db.agentSettings||{defaultMarkupMax:300,version:1};
 const markups=db.agentMarkups=db.agentMarkups||{},orders=db.agentOrders=db.agentOrders||[],earnings=db.agentEarnings=db.agentEarnings||[];
 const LOCK_MINUTES=30;let seq=0;const uid=p=>p+'_'+Date.now()+'_'+ ++seq;
 const owner=()=> 'mock_'+currentRole(),cents=x=>{if(!/^\d{1,12}(\.\d{1,2})?$/.test(String(x)))fail(400,'金额须为非负金额，最多两位小数');return Math.round(Number(x)*100);};
 const mask=n=>n?n.slice(0,1)+'*'.repeat(Math.max(1,n.length-1)):'',maskPhone=p=>p?p.slice(0,3)+'****'+p.slice(-4):'';
 const find=id=>agents.find(a=>a.userId===id);
 const active=id=>{const a=find(id);return a&&a.status==='active'?a:null;};
 const me=()=>{if(STAFF_ROLES.includes(currentRole()))fail(403,'仅已审核通过的代理可使用');return active(owner())||fail(403,'仅已审核通过的代理可使用');};
 const note=(action,detail,reason='')=>db.auditLogs.unshift({id:uid('log'),time:new Date().toISOString(),operator:currentRole(),action,detail,reason});
 const shareable=u=>u&&u.status==='in_stock'&&(!u.ownership||u.ownership==='own')&&u.flags.shareAgent===true;
 const markupOf=(agentId,unitId)=>markups[agentId+':'+unitId]||0;
 const ledger=(u,from,to,doc,reason)=>{db.inventoryLedger=db.inventoryLedger||[];db.inventoryLedger.unshift({id:uid('lg'),unitId:u.id,time:new Date().toISOString(),from,to,docType:'agent_order',doc,operator:currentRole(),reason});};
 function view(a){if(!a)return{status:'none'};const inviter=a.inviterId?find(a.inviterId):null;return clone({status:a.status,name:a.name,phone:a.phone,region:a.region,appliedAt:a.appliedAt,...(a.status==='active'?{markupMax:a.markupMax,inviteCode:a.inviteCode}:{}),...(a.status==='rejected'?{reviewRemark:a.reviewRemark}:{}),...(inviter?{inviterName:inviter.name}:{})});}
 function adminView(a){const inviter=a.inviterId?find(a.inviterId):null;return clone({id:a.userId,status:a.status,name:a.name,phone:a.phone,region:a.region,inviterId:a.inviterId,inviterName:inviter?inviter.name:null,inviteCode:a.inviteCode||null,markupMax:a.markupMax===undefined?null:a.markupMax,reviewRemark:a.reviewRemark,appliedAt:a.appliedAt,version:a.version});}
 function unitView(a,u){const m=markupOf(a.userId,u.id),share=cents(u.agentBase)+m,p=publicUnit(u,{channel:'agent'});return{id:u.id,name:p.name,storage:p.storage,color:p.color,grade:p.grade,cover:p.cover,retail:u.retail,markup:m/100,markupMin:0,markupMax:a.markupMax,sharePrice:share/100,aboveRetail:share>cents(u.retail),priceVersion:u.priceVersion||1};}
 function releaseExpired(){orders.filter(o=>o.status==='locked'&&o.lockExpiresAt<=Date.now()).forEach(o=>unlock(o,'下单锁定到期自动释放'));}
 function unlock(o,reason){if(o.status!=='locked')return false;o.status='released';o.releaseReason=reason;const u=db.units.find(u=>u.id===o.unitId);if(u&&u.status==='locked'){u.status='in_stock';ledger(u,'locked','in_stock',o.requestId,reason);}return true;}
 function orderView(o,internal){const r=(db.customerRequests||[]).find(r=>r.id===o.requestId)||{},a=find(o.agentId);return clone({id:o.requestId,unitId:o.unitId,name:r.unit?r.unit.name:'',storage:r.unit?r.unit.storage:'',status:o.status,requestStatus:r.status,sharePrice:o.sharePrice/100,markup:o.markup/100,lockExpiresAt:new Date(o.lockExpiresAt).toISOString(),releaseReason:o.releaseReason||'',createdAt:o.createdAt,customerName:internal?r.name:mask(r.name),customerPhone:internal?r.phone:maskPhone(r.phone),...(internal?{agentId:o.agentId,agentName:a?a.name:null,saleOrderId:o.saleOrderId||null,agentBase:o.agentBase/100}:{})});}
 function earningView(e,internal){const r=(db.customerRequests||[]).find(r=>r.id===e.requestId)||{},a=find(e.agentId);return clone({id:e.id,kind:e.kind,amount:(e.kind==='reversal'?-1:1)*e.amount/100,status:e.status,orderId:e.requestId,name:r.unit?r.unit.name:'',createdAt:e.createdAt,settledAt:e.settledAt||null,...(internal?{saleOrderId:e.saleOrderId,agentId:e.agentId,agentName:a?a.name:null,settleReason:e.settleReason||''}:{})});}
 function totals(agentId){const rows=earnings.filter(e=>!agentId||e.agentId===agentId),sum=s=>rows.filter(e=>e.status===s).reduce((n,e)=>n+(e.kind==='reversal'?-1:1)*e.amount,0)/100;return{pendingAmount:sum('pending'),settledAmount:sum('settled')};}
 function earningList(d,agentId,internal){let rows=earnings.filter(e=>!agentId||e.agentId===agentId);if(d.status){if(!['pending','settled','reversed'].includes(d.status))fail(400,'收益状态无效');rows=rows.filter(e=>e.status===d.status);}return{...paginate(rows.map(e=>earningView(e,internal)),d),summary:totals(agentId)};}
 const reviewer=()=>{requirePermission(PERM.AGENT_REVIEW);if(!STAFF_ROLES.includes(currentRole()))fail(403,'仅员工可操作');};
 function list(d,status){let rows=agents.slice();const s=d.status||status;if(s){if(!['pending','active','rejected','disabled'].includes(s))fail(400,'代理状态无效');rows=rows.filter(a=>a.status===s);}if(d.keyword)rows=rows.filter(a=>(a.name+a.phone+a.region).includes(d.keyword));return paginate(rows.map(adminView),d);}

 // ---------- 供分享 / 咨询 / 收银 mock 调用 ----------
 function lock(r,share,unitId){
  if(!share||share.channel!=='agent')fail(400,'仅代理分享链接支持下单');if(share.ownerId===owner())fail(400,'不能通过自己的分享链接下单');
  const u=db.units.find(u=>u.id===unitId),item=share.snapshots.find(i=>i.id===unitId);if(!item)fail(404,'商品不在本分享内');if(!shareable(u))fail(409,'该设备已被锁定或售出');if((u.priceVersion||1)!==item.priceVersion)fail(410,'商品价格已变化，请重新获取分享');
  const o={requestId:r.id,agentId:share.ownerId,unitId,shareId:share.shareId,agentBase:cents(u.agentBase),markup:item.markup||0,sharePrice:Math.round(item.price*100),priceVersion:item.priceVersion,lockExpiresAt:Date.now()+LOCK_MINUTES*60000,status:'locked',createdAt:new Date().toISOString()};
  if(o.agentBase+o.markup!==o.sharePrice)fail(410,'代理价已变化，请重新获取分享');orders.unshift(o);u.status='locked';ledger(u,'in_stock','locked',r.id,'代理链接下单锁定 '+LOCK_MINUTES+' 分钟');
 }
 const orderOf=requestId=>orders.find(o=>o.requestId===requestId);
 function release(requestId,reason){const o=orderOf(requestId);return o?unlock(o,reason):false;}
 function saleItem(requestId,unitId){releaseExpired();const o=orderOf(requestId||'');if(!o||o.unitId!==unitId)fail(400,'代理订单与设备不符');if(o.status!=='locked')fail(409,'代理订单锁定已释放，不能按代理价成交');return o;}
 function recordSale(requestId,saleOrderId){const o=orderOf(requestId);o.status='sold';o.saleOrderId=saleOrderId;earnings.unshift({id:uid('earn'),agentId:o.agentId,requestId,saleOrderId,kind:'earning',amount:o.markup,status:'pending',createdAt:new Date().toISOString()});note('代理订单成交记收益',requestId);}
 function onReturn(saleOrderId,unitId,refundId){const e=earnings.find(e=>e.saleOrderId===saleOrderId&&e.kind==='earning'&&orderOf(e.requestId)?.unitId===unitId);if(!e)return;if(e.status==='pending'){e.status='reversed';e.settleReason='退货冲回 '+refundId;}else if(e.status==='settled'&&!earnings.some(x=>x.reversalOf===e.id))earnings.unshift({id:uid('earn'),agentId:e.agentId,requestId:e.requestId,saleOrderId,kind:'reversal',amount:e.amount,reversalOf:e.id,status:'pending',createdAt:new Date().toISOString()});}
 function requestView(requestId,internal){const o=orderOf(requestId);if(!o)return null;return{status:o.status,sharePrice:o.sharePrice/100,priceVersion:o.priceVersion,lockExpiresAt:new Date(o.lockExpiresAt).toISOString(),...(internal?{markup:o.markup/100,agentId:o.agentId,agentName:find(o.agentId)?.name||null}:{})};}
 function pending(perms){const out={};if(perms.includes(PERM.AGENT_REVIEW))out.applications=agents.filter(a=>a.status==='pending').length;if(perms.some(p=>[PERM.SALES_CREATE,PERM.AGENT_REVIEW].includes(p))){releaseExpired();out.lockedOrders=orders.filter(o=>o.status==='locked').length;}if(perms.includes(PERM.AGENT_SETTLE))out.pendingEarnings=earnings.filter(e=>e.status==='pending').length;return out;}
 const canShare=()=>!!active(owner())&&!STAFF_ROLES.includes(currentRole());

 return{lock,release,saleItem,recordSale,onReturn,requestView,pending,shareable,markupOf,canShare,isActive:id=>!!active(id),routes:[
 ['POST','/agent/applications',d=>{
  if(STAFF_ROLES.includes(currentRole()))fail(403,'员工账号不能申请代理');if(Object.keys(d).some(k=>!['name','phone','region','inviteCode','agreed'].includes(k)))fail(400,'申请参数无效');if(d.agreed!==true)fail(400,'请先阅读并同意代理协议');
  if(!d.name||!d.name.trim()||d.name.length>50||!d.region||!d.region.trim())fail(400,'请填写姓名和所在地区');if(!isPhone(d.phone))fail(400,'请填写11位手机号');
  const prior=find(owner());if(prior&&prior.status==='active')fail(409,'你已经是代理');if(prior&&prior.status==='pending')fail(409,'申请正在审核中');if(prior&&prior.status==='disabled')fail(409,'代理资格已停用，请联系门店');
  let inviter=null;if(d.inviteCode){inviter=agents.find(a=>a.inviteCode===String(d.inviteCode).toUpperCase()&&a.status==='active');if(!inviter||inviter.userId===owner())fail(400,'邀请码无效');}
  const row={userId:owner(),status:'pending',name:d.name.trim(),phone:d.phone,region:d.region.trim(),inviterId:inviter?inviter.userId:null,reviewRemark:'',appliedAt:new Date().toISOString(),version:prior?prior.version+1:1,inviteCode:prior?prior.inviteCode:undefined,markupMax:prior?prior.markupMax:undefined};
  if(prior)Object.assign(prior,row);else agents.push(row);note('提交代理申请',owner());return view(find(owner()));
 }],
 ['GET','/agent/me',()=>STAFF_ROLES.includes(currentRole())?{status:'none'}:view(find(owner()))],
 ['GET','/agent/invite',()=>{const a=me();return{inviteCode:a.inviteCode,members:agents.filter(x=>x.inviterId===a.userId).map(x=>({name:mask(x.name),status:x.status,appliedAt:x.appliedAt}))};}],
 ['GET','/agent/units',d=>{const a=me();let rows=db.units.filter(shareable);if(d.keyword)rows=rows.filter(u=>u.name.includes(d.keyword));return paginate(rows.map(u=>unitView(a,u)),d);}],
 ['PUT','/agent/units/:id/markup',(d,h,p)=>{const a=me();if(Object.keys(d).some(k=>k!=='markup'))fail(400,'加价参数无效');const m=cents(d.markup),u=db.units.find(u=>u.id===p.id);if(!shareable(u))fail(409,'该设备当前不允许代理转发');if(m>Math.round(a.markupMax*100))fail(400,'加价不能超过上限 ¥'+a.markupMax);markups[a.userId+':'+u.id]=m;note('代理设置加价',u.id);return unitView(a,u);}],
 ['GET','/agent/overview',()=>{releaseExpired();const a=me(),mine=orders.filter(o=>o.agentId===a.userId),today=new Date(Date.now()+28800000).toISOString().slice(0,10);return{todayVisitors:0,todayViews:0,todayShares:(db.shareLinks||[]).filter(s=>s.ownerId===a.userId&&s.channel==='agent'&&new Date((s.createdAt||0)+28800000).toISOString().slice(0,10)===today).length,lockedOrders:mine.filter(o=>o.status==='locked').length,soldOrders:mine.filter(o=>o.status==='sold').length,...totals(a.userId),markupMax:a.markupMax};}],
 ['GET','/agent/orders',d=>{releaseExpired();const a=me();let rows=orders.filter(o=>o.agentId===a.userId);if(d.status){if(!['locked','sold','released'].includes(d.status))fail(400,'订单状态无效');rows=rows.filter(o=>o.status===d.status);}return paginate(rows.map(o=>orderView(o,false)),d);}],
 ['GET','/agent/commissions',d=>{const a=me();return earningList(d,a.userId,false);}],
 ['GET','/admin/agent-settings',()=>{requirePermission(PERM.AGENT_REVIEW,PERM.AGENT_SETTLE);return{defaultMarkupMax:settings.defaultMarkupMax,lockMinutes:LOCK_MINUTES,version:settings.version};}],
 ['PUT','/admin/agent-settings',d=>{reviewer();const m=cents(d.defaultMarkupMax);if(!d.reason||!d.reason.trim())fail(400,'请填写调整原因');if(d.version!==settings.version)fail(409,'设置已被他人修改，请刷新');settings.defaultMarkupMax=m/100;settings.version++;note('调整代理默认加价上限','agent_settings',d.reason);return{defaultMarkupMax:settings.defaultMarkupMax,lockMinutes:LOCK_MINUTES,version:settings.version};}],
 ['GET','/admin/agent-applications',d=>{reviewer();return list(d,'pending');}],
 ['GET','/admin/agents',d=>{requirePermission(PERM.AGENT_REVIEW,PERM.AGENT_SETTLE);return list(d,'');}],
 ['POST','/admin/agent-applications/:id/review',(d,h,p)=>{
  reviewer();if(typeof d.approve!=='boolean')fail(400,'请选择通过或拒绝');if(!d.remark||!d.remark.trim())fail(400,'请填写审核说明');const a=find(p.id)||fail(404,'申请不存在');if(a.status!=='pending'||a.version!==d.version)fail(409,'申请已处理或已更新，请刷新');
  if(d.approve){const max=d.markupMax===undefined||d.markupMax===null||d.markupMax===''?Math.round(settings.defaultMarkupMax*100):cents(d.markupMax);Object.assign(a,{status:'active',markupMax:max/100,inviteCode:a.inviteCode||Math.random().toString(36).slice(2,10).toUpperCase().padEnd(8,'X')});}else a.status='rejected';
  a.reviewRemark=d.remark.trim();a.version++;note(d.approve?'通过代理申请':'拒绝代理申请',a.userId,d.remark);return adminView(a);
 }],
 ['PATCH','/admin/agents/:id',(d,h,p)=>{reviewer();if(!d.reason||!d.reason.trim())fail(400,'请填写调整原因');const a=find(p.id);if(!a||!['active','disabled'].includes(a.status))fail(404,'代理不存在');if(a.version!==d.version)fail(409,'代理资料已更新，请刷新');if(d.status!==undefined&&!['active','disabled'].includes(d.status))fail(400,'代理状态无效');if(d.status)a.status=d.status;if(d.markupMax!==undefined)a.markupMax=cents(d.markupMax)/100;a.version++;note('调整代理资格或加价上限',a.userId,d.reason);return adminView(a);}],
 ['GET','/admin/agent-orders',d=>{requirePermission(PERM.AGENT_REVIEW,PERM.AGENT_SETTLE,PERM.SALES_CREATE);releaseExpired();let rows=orders.slice();if(d.status){if(!['locked','sold','released'].includes(d.status))fail(400,'订单状态无效');rows=rows.filter(o=>o.status===d.status);}if(d.agentId)rows=rows.filter(o=>o.agentId===d.agentId);return paginate(rows.map(o=>orderView(o,true)),d);}],
 ['GET','/admin/agent-earnings',d=>{requirePermission(PERM.AGENT_SETTLE,PERM.AGENT_REVIEW);return earningList(d,d.agentId||null,true);}],
 ['POST','/admin/agent-earnings/settle',d=>{requirePermission(PERM.AGENT_SETTLE);if(!STAFF_ROLES.includes(currentRole()))fail(403,'仅员工可操作');if(!d.reason||!d.reason.trim())fail(400,'请填写转账说明');if(!Array.isArray(d.ids)||!d.ids.length||d.ids.length>100)fail(400,'请选择1～100条收益记录');const rows=[...new Set(d.ids)].map(id=>earnings.find(e=>e.id===id)||fail(404,'收益记录不存在'));if(rows.some(e=>e.status!=='pending'))fail(409,'所选记录已转账或已冲回，请刷新');rows.forEach(e=>{e.status='settled';e.settledAt=new Date().toISOString();e.settleReason=d.reason;note('标记代理收益已转账',e.id,d.reason);});return{settled:rows.length};}]
 ]};
};
