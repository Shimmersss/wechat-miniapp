/** 仅从白名单组装响应；绝不把原始 PG 行交给客户端。与 server/src/stock.js 保持一致。 */
const { SENSITIVE_FIELDS, PERM } = require('./roles');
const { fail } = require('./gateway');
const canSee=(u,k)=>k==='agentBase'?['boss','manager','purchaser'].includes(u.role):!SENSITIVE_FIELDS[k]||u.visibleFields.includes(k);
const mask=(v)=>`${v.slice(0,2)}****${v.slice(-4)}`;
const maskCode=(u,v)=>!canSee(u,'fullImei')&&/^\d{15}$/.test(v)?mask(v):v;
function unit(row,u) {
  const a=row.attributes||{}, fields=row.template_snapshot?.fields||[], attached=row.attached||[];
  const visible=f=>f.scope==='public'||(u.staffNo&&(f.owner_id===u.id||['boss','manager','purchaser'].includes(u.role)));
  // 链接由 files.js 判权后向 PG Storage 签名；不公开内部对象路径。
  const fileView=f=>{if(!f.resolved_url)fail(503,'附件链接尚未迁移到云开发');return {fileId:f.id,scope:f.scope,mime:f.mime,mediaType:f.mime.startsWith('video/')?'video':'image',url:f.resolved_url};};
  const publicFiles=attached.filter(f=>f.field_key==='publicImages');
  const receipt=[...new Map(attached.filter(f=>f.scope==='internal'&&visible(f)).map(f=>[f.id,f])).values()];
  const r={id:row.id,modelId:row.model_id,name:row.name,brand:row.brand,category:row.category_id,status:row.status,ownership:row.ownership,condition:row.condition_type,imeiMasked:mask(row.imei1),storage:a.storage,color:a.color,grade:a.grade,battery:a.battery,version:a.version,retail:Number(row.retail),flags:row.share_flags,peerDesc:row.peer_desc,customerDesc:row.customer_desc,createdAt:row.created_at,ageDays:Math.max(0,Math.floor((Date.now()-new Date(row.created_at).getTime())/86400000)),images:publicFiles.filter(f=>f.mime.startsWith('image/')).map(f=>fileView(f).url),publicImages:publicFiles.map(fileView),priceVersion:row.price_version};
  if(canSee(u,'fullImei')){r.imei1=row.imei1;r.imei2=row.imei2;}
  if(canSee(u,'cost'))r.cost=Number(row.cost);
  if(canSee(u,'supplier')){r.supplier=row.supplier_name||'';r.supplierId=row.supplier_id;}
  if(canSee(u,'internalNote'))r.internalNote=row.internal_note;
  if(canSee(u,'wholesalePrice'))r.wholesale=Number(row.wholesale);
  if(canSee(u,'agentBase'))r.agentBase=Number(row.agent_base);
  if(receipt.length)r.receiptImages=receipt.map(fileView);
  r.parameters=fields.filter(f=>canSee(u,f.key)&&(!f.visibility.includes('internal')||canSee(u,'internalNote'))&&!(f.key==='receipt'&&!receipt.length)).map(f=>({key:f.key,label:f.label,type:f.type,value:f.type==='image'?attached.filter(x=>x.field_key===f.key&&visible(x)).map(fileView):a[f.key]})).filter(f=>f.value!==undefined);
  r.availableActions=row.status==='recheck'&&u.permissions.includes(PERM.ACCEPTANCE)?['recheck']:[];
  if(row.loan&&u.permissions.includes(PERM.LOAN_MANAGE))r.loan=row.loan;
  if(row.scannedAt!==undefined){r.scannedAt=row.scannedAt;r.scanner=row.scanner||'';}
  return r;
}
function purchase(row,u) {
  const shipments=(row.shipments||[]).map(s=>({id:s.id,carrier:s.carrier,trackingNo:s.tracking_no,status:s.status,shippedAt:s.shipped_at,signedAt:s.signed_at}));
  const r={id:row.id,no:row.no,status:row.status,qty:row.quantity,owner:row.owner||'',expectedAt:row.expected_at,createdAt:row.created_at,shipments,shipment:shipments[0]||null,tracks:[],remark:row.remark};
  if(canSee(u,'supplier')){r.supplier=row.supplier_name||'';r.supplierId=row.supplier_id;}
  if(canSee(u,'cost')){r.amount=Number(row.amount);r.freight=Number(row.freight);}
  if(row.lines)r.lines=row.lines.map(l=>({id:l.id,modelId:l.model_id,modelName:l.name,templateId:l.template_id,attributes:l.expected_attributes,quantity:l.quantity,received:l.received_count,accepted:l.accepted_count,rejected:l.rejected_count,remaining:l.quantity-l.received_count,...(canSee(u,'cost')?{unitCost:Number(l.unit_cost)}:{})}));
  if(row.exceptions)r.exceptions=row.exceptions.map(a=>({id:a.id,lineId:a.purchase_line_id,modelId:a.model_id,modelName:a.name,imeiMasked:mask(a.imei1),...(canSee(u,'fullImei')?{imei1:a.imei1,imei2:a.imei2}:{}),reason:a.reason,resolution:a.resolution,observedModel:a.attributes?._observedModel||''}));
  return r;
}
function record(row,u,detail=true) {
  const r=row.result, resolutions=new Map();
  const labels={pending:'待查',found:'已找到',lost:'确认丢失',handled:'已处理'};
  for(const x of row.resolutions)resolutions.set(`${x.target_type}:${x.target}`,{resolution:x.resolution,label:labels[x.resolution],note:x.note,operator:x.operator||'',time:x.created_at});
  const settled=k=>resolutions.has(k)&&resolutions.get(k).resolution!=='pending';
  const result={id:row.id,time:row.created_at,operator:row.operator||'',scope:row.scope,sessionId:row.session_id||null,expectedCount:r.expectedCount,scannedCount:r.scannedCount,matched:r.matched,missingCount:r.missingIds.length,extraCount:r.extra.length,changedCount:(r.changed||[]).length,openCount:r.missingIds.filter(id=>!settled('unit:'+id)).length+r.extra.filter((_,i)=>!settled('extra:'+i)).length};
  if(detail)Object.assign(result,{missingIds:r.missingIds,matchedIds:r.matchedIds||[],missing:row.missing.map(x=>({...unit(x,u),resolution:resolutions.get('unit:'+x.id)||null})),changed:(r.changed||[]).map(c=>{const x=row.changedUnits.find(x=>x.id===c.unitId);return {id:x.id,name:x.name,imeiMasked:mask(x.imei1),from:c.from,to:c.to};}),extra:r.extra.map((e,i)=>({key:String(i),code:maskCode(u,e.code),unitId:e.unitId||null,reason:e.reason,resolution:resolutions.get('extra:'+i)||null}))});
  return result;
}
function sale(row,u,detail=false) {
  const items=row.items, refunds=row.refunds||[];
  const refundCents=refunds.reduce((n,x)=>n+Math.round(Number(x.amount)*100),0);
  const reverseCents=items.reduce((n,x)=>n+Math.round(Number(x.reversed||0)*100),0);
  const r={id:row.id,no:row.no,status:items.length&&items.every(i=>i.returned)?'refunded':refunds.length?'partially_refunded':'paid',seller:row.seller,sellerId:row.seller_id,payMethod:row.pay_method,customer:row.customer,phone:row.phone,remark:row.remark,createdAt:row.created_at,amount:Number(row.amount),refundAmount:refundCents/100,netAmount:(Math.round(Number(row.amount)*100)-refundCents)/100,unitName:items.map(i=>i.name).join('、'),quantity:items.length,items:items.map(i=>({id:i.id,unitId:i.unit_id,modelId:i.model_id,name:i.name,spec:i.spec,store:i.store,price:Number(i.price),refunded:Number(i.refunded||0),returnable:!i.returned,channel:i.channel,...(canSee(u,'cost')?{cost:Number(i.cost)}:{})})),refunds:refunds.map(x=>({...x,amount:Number(x.amount)}))};
  if(canSee(u,'profit')&&u.permissions.includes(PERM.PROFIT_VIEW))r.profit=(Math.round(Number(row.amount)*100)-refundCents-Math.round(Number(row.cost_total)*100)+reverseCents)/100;
  if(row.attribution){const a=row.attribution;Object.assign(r,{customerRequestId:a.customer_request_id,source:a.source});if(u.permissions.includes(PERM.CONSULT_MANAGE))Object.assign(r,{shareId:a.share_id,shareOwnerId:a.share_owner_id});}
  if(detail){
    const finance=u.permissions.includes(PERM.AGENT_REVIEW)||u.permissions.includes(PERM.AGENT_SETTLE);
    r.agentSources=(row.agentSources||[]).map(x=>({orderId:x.orderId,unitId:x.unitId,agentName:x.agentName,sharePrice:Number(x.sharePrice),...(finance?{markup:Number(x.markup),earnings:x.earnings.map(e=>({...e,amount:Number(e.amount)}))}:{})}));
    r.receipts=(row.attached||[]).map(f=>{if(!f.resolved_url)fail(503,'收款凭证链接获取失败');return {fileId:f.id,scope:f.scope,mime:f.mime,mediaType:f.mime.startsWith('video/')?'video':'image',url:f.resolved_url,addedAt:f.addedAt,addedBy:f.addedBy};});
  }
  return r;
}
function view(action,r,p,u) {
  const paged=(rows)=>({list:rows,total:Number(r.total),page:p.page,pageSize:p.pageSize});
  if(action==='units.list'){const summary={...r.summary};if(!canSee(u,'cost'))delete summary.costTotal;return {...paged(r.rows.map(x=>unit(x,u))),counts:r.counts,summary};}
  if(['units.get','units.price','units.recheck','sales.lookup'].includes(action))return unit(r,u);
  if(action==='units.recheckForm') {
    if(r.status!=='recheck')fail(409,'设备不在待复检状态');const visible=unit(r,u);
    const fields=(r.template_snapshot.fields||[]).filter(f=>f.key!=='supplier'&&canSee(u,f.key)&&(!f.visibility.includes('internal')||canSee(u,'internalNote')));
    const values=Object.fromEntries(visible.parameters.filter(x=>fields.some(f=>f.key===x.key)).map(x=>[x.key,x.value]));
    return {unitId:r.id,name:r.name,templateVersion:r.template_snapshot.version,inspectionVersion:Number(r.inspectionVersion),fields,values,hiddenKeys:fields.filter(f=>f.type==='image'&&!values[f.key]?.length&&r.attributes[f.key]?.length).map(f=>f.key)};
  }
  if(action==='models.list') {
    const brands=[];for(const row of r){let b=brands.find(b=>b.id===row.brand);if(!b){b={id:row.brand,name:row.brandLabel,series:[]};brands.push(b);}let s=b.series.find(s=>s.name===row.series);if(!s){s={name:row.series,models:[]};b.series.push(s);}s.models.push(row);}return brands;
  }
  if(action==='purchase.list')return {...paged(r.rows.map(x=>purchase(x,u))),summary:r.summary};
  if(['purchase.create','purchase.update','purchase.get'].includes(action))return purchase(r,u);
  if(action==='purchase.acceptance'){const x=purchase(r,u);return {poId:x.id,no:x.no,status:x.status,lines:x.lines,exceptions:x.exceptions,items:[],expectedTotal:x.qty,remaining:x.lines.reduce((n,l)=>n+l.remaining,0),canAccept:['arrived','accepting','exception'].includes(x.status)};}
  if(action==='pricing.presets')return canSee(u,'cost')?r:[];
  if(action==='sessions.units')return paged(r.rows.map(x=>x.model_id?unit(x,u):{...x,code:maskCode(u,x.code)}));
  if(action==='sessions.scan')return {...r,code:maskCode(u,r.code),unit:r.unit?unit(r.unit,u):null};
  if(action==='records.list')return paged(r.rows.map(x=>record(x,u,false)));
  if(['records.get','records.resolve','sessions.close'].includes(action))return record(r,u);
  if(action==='sales.list')return paged(r.rows.map(x=>sale(x,u)));
  if(['sales.get','sales.refund','sales.receipts'].includes(action))return sale(r,u,true);
  if(action==='sales.create')return sale(r,u);
  if(r && Object.hasOwn(r,'rows'))return paged(r.rows);
  return r;
}
module.exports={view,canSee,unit,purchase,record,sale};
