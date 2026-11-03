const {PERM,SENSITIVE_FIELDS}=require('../constants/roles');
module.exports=function(db,{fail,requirePermission,paginate,clone,currentRole,staffUnit,customerRequests}){
 let seq=0;const orders=db.salesTransactions=db.salesTransactions||[],requests={},refundKeys={};const uid=()=> 'sale_'+Date.now()+'_'+ ++seq;
 const visible=k=>!SENSITIVE_FIELDS[k]||SENSITIVE_FIELDS[k].includes(currentRole());
 const read=()=>requirePermission(PERM.SALES_CREATE,PERM.REFUND,PERM.STATS_VIEW);
 const money=x=>{if(!/^\d{1,12}(\.\d{1,2})?$/.test(String(x)))fail(400,'金额须为非负金额，最多两位小数');return Math.round(Number(x)*100);};
 const find=id=>orders.find(o=>o.id===id)||fail(404,'订单不存在');
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.keys(v).sort().reduce((o,k)=>{o[k]=canonical(v[k]);return o;},{}):v;
 const digest=d=>JSON.stringify(canonical(d));
 function view(o){
  const refunded=o.refunds.reduce((n,r)=>n+r.cents,0),reversed=o.refunds.filter(r=>r.kind==='return').reduce((n,r)=>n+r.rows.reduce((sum,i)=>sum+i.costCents,0),0);
  const result={...clone(o),amount:o.cents/100,refundAmount:refunded/100,netAmount:(o.cents-refunded)/100,quantity:o.items.length,status:o.items.every(i=>i.returned)?'refunded':o.refunds.length?'partially_refunded':'paid',profit:(o.cents-refunded-o.costCents+reversed)/100,unitName:o.items.map(i=>i.name).join('、'),
   items:o.items.map(i=>({id:i.id,unitId:i.unitId,modelId:i.modelId,name:i.name,spec:i.spec,store:i.store,price:i.cents/100,refunded:i.refunded/100,returnable:!i.returned,channel:i.channel,...(visible('cost')?{cost:i.costCents/100}:{})})),
   refunds:o.refunds.map(r=>({id:r.id,kind:r.kind,reason:r.reason,time:r.time,amount:r.cents/100}))};
  delete result.cents;delete result.costCents;if(!visible('profit'))delete result.profit;return result;
 }
 function plan(d){
  if(!Array.isArray(d.items)||!d.items.length||d.items.length>100)fail(400,'销售需1～100台设备');const seen=new Set();
  return d.items.map(i=>{if(seen.has(i.unitId))fail(400,'设备重复');seen.add(i.unitId);const u=db.units.find(u=>u.id===i.unitId)||fail(404,'设备不存在');
   if(u.status!=='in_stock'||(u.ownership&&u.ownership!=='own')||i.priceVersion!==(u.priceVersion||1))fail(409,'设备状态或价格已变化');
   const channel=i.channel||'retail';if(!['retail','wholesale'].includes(channel))fail(400,'销售渠道无效');if(channel==='wholesale'&&!visible('wholesalePrice'))fail(403,'无权限使用批发价');
   const base=money(channel==='wholesale'?u.wholesale:u.retail),cents=i.price===undefined?base:money(i.price);if(cents!==base)requirePermission(PERM.PRICE_EDIT);return{u,base,cents,channel};
  });
 }
 function note(action,id,reason){db.auditLogs.unshift({id:uid(),time:new Date().toISOString(),operator:currentRole(),action,detail:id,reason});}
 function ledger(u,from,to,docType,doc,reason){db.inventoryLedger=db.inventoryLedger||[];db.inventoryLedger.unshift({id:uid(),unitId:u.id,time:new Date().toISOString(),from,to,docType,doc,operator:currentRole(),reason});}
 return[
 ['GET','/sales/lookup',d=>{requirePermission(PERM.SALES_CREATE);const u=db.units.find(u=>[u.id,u.imei1,u.imei2].includes(d.code));if(!u||u.status!=='in_stock'||(u.ownership&&u.ownership!=='own'))fail(409,'未找到可售设备');return staffUnit(u);}],
 ['POST','/sales/quote',d=>{requirePermission(PERM.SALES_CREATE);const rows=plan(d);return{total:rows.reduce((n,i)=>n+i.cents,0)/100,items:rows.map(i=>({unitId:i.u.id,price:i.cents/100,basePrice:i.base/100,priceVersion:i.u.priceVersion||1,channel:i.channel}))};}],
 ['POST','/sales-orders',d=>{
  requirePermission(PERM.SALES_CREATE);if(typeof d.requestKey!=='string'||!d.requestKey||d.requestKey.length>80)fail(400,'请填写提交标识');const signature=digest(d);
  if(requests[d.requestKey]){const prior=requests[d.requestKey];if(prior.signature!==signature)fail(409,'提交标识冲突');return view(prior.order);}
  if(!['微信','支付宝','现金','银行卡','分期'].includes(d.payMethod)||d.paymentConfirmed!==true)fail(400,'请确认实际收款');
  const rows=plan(d);if(rows.some(i=>i.base!==i.cents)&&(!d.priceReason||!d.priceReason.trim()))fail(400,'请填写成交改价原因');
  const referral=customerRequests.forSale(d,rows);
  const total=rows.reduce((n,i)=>n+i.cents,0),cost=rows.reduce((n,i)=>n+money(i.u.cost),0);if(total>99999999999999||cost>99999999999999)fail(400,'合计超出范围');
  const o={id:uid(),no:'SO'+uid(),seller:currentRole(),sellerId:'mock_'+currentRole(),payMethod:d.payMethod,customer:d.customer||'',phone:d.phone||'',remark:d.remark||'',createdAt:new Date().toISOString(),cents:total,costCents:cost,refunds:[],items:rows.map(i=>({id:uid(),unitId:i.u.id,modelId:i.u.modelId||'',name:i.u.name,spec:[i.u.storage,i.u.color,i.u.grade].join(' / '),store:(i.u.attributes||{}).store||'',cents:i.cents,costCents:money(i.u.cost),channel:i.channel,refunded:0,returned:false}))};
  rows.forEach(i=>{i.u.status='sold';i.u.flags={showInShop:false,sharePeer:false,shareAgent:false};ledger(i.u,'in_stock','sold','sales_order',o.id,d.priceReason||'已收款');});customerRequests.recordSale(referral,o);orders.unshift(o);requests[d.requestKey]={signature,order:o};note('销售收款出库',o.id,d.priceReason||'');return view(o);
 }],
 ['GET','/sales-orders',d=>{read();let rows=orders.map(view);if(d.status)rows=rows.filter(o=>o.status===d.status);if(d.sellerId)rows=rows.filter(o=>o.sellerId===d.sellerId);if(d.keyword)rows=rows.filter(o=>o.no.includes(d.keyword)||o.customer.includes(d.keyword));if(d.from)rows=rows.filter(o=>o.createdAt>=new Date(d.from+'T00:00:00+08:00').toISOString());if(d.to)rows=rows.filter(o=>Date.parse(o.createdAt)<Date.parse(d.to+'T00:00:00+08:00')+86400000);return clone(paginate(rows,d));}],
 ['GET','/sales-orders/:id',(d,h,p)=>{read();return view(find(p.id));}],
 ['POST','/sales-orders/:id/refund',(d,h,p)=>{
  requirePermission(PERM.REFUND);const o=find(p.id);if(!d.requestKey||typeof d.requestKey!=='string'||d.requestKey.length>80)fail(400,'提交标识无效');const signature=digest({...d,orderId:o.id});if(refundKeys[d.requestKey]){if(refundKeys[d.requestKey]!==signature)fail(409,'退款标识冲突');return view(o);}
  if(!['return','adjustment'].includes(d.kind)||!d.reason||!d.reason.trim()||!Array.isArray(d.items)||!d.items.length)fail(400,'退款内容无效');
  const seen=new Set(),planned=d.items.map(row=>{const i=o.items.find(i=>i.id===row.itemId);if(!i||seen.has(i.id))fail(400,'退款项目无效');seen.add(i.id);if(i.returned)fail(409,'设备已退货');const u=db.units.find(u=>u.id===i.unitId);if(!u||u.status!=='sold')fail(409,'原销售设备状态不符');const amount=row.amount===undefined&&d.kind==='return'?i.cents-i.refunded:money(row.amount);if(amount>i.cents-i.refunded||(d.kind==='adjustment'&&amount===0))fail(400,'超过剩余可退金额');return{i,u,amount};});
  const refund={id:uid(),kind:d.kind,reason:d.reason,time:new Date().toISOString(),cents:planned.reduce((n,p)=>n+p.amount,0),rows:planned.map(p=>({itemId:p.i.id,amountCents:p.amount,costCents:p.i.costCents}))};
  planned.forEach(p=>{p.i.refunded+=p.amount;if(d.kind==='return'){p.i.returned=true;p.u.status='recheck';p.u.flags={showInShop:false,sharePeer:false,shareAgent:false};ledger(p.u,'sold','recheck','refund',refund.id,d.reason);}});o.refunds.push(refund);refundKeys[d.requestKey]=signature;note('销售退款',o.id,d.reason);return view(o);
 }]
 ];
};
