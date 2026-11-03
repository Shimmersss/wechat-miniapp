const {PERM,SENSITIVE_FIELDS}=require('../constants/roles');
module.exports=function(db,{fail,requirePermission,currentRole}){
 const records=[],keys={};let seq=0;
 const can=key=>!SENSITIVE_FIELDS[key]||SENSITIVE_FIELDS[key].includes(currentRole());
 const authorize=()=>{requirePermission(PERM.EXPORT);requirePermission(PERM.STATS_VIEW,PERM.DASHBOARD_VIEW);};
 const cell=v=>{if(typeof v==='number')return String(v);let s=String(v??'');if(/^\s*[=+@-]/.test(s)||/^[\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
 const metadata=r=>({id:r.id,filename:'夏目数码_销售退款_'+r.id+'.csv',expiresAt:r.expiresAt,rows:r.rows.length});
 function owned(target){const r=records.find(r=>r.id===target&&r.owner===currentRole());if(!r)fail(404,'导出记录不存在');if(Date.parse(r.expiresAt)<=Date.now())fail(410,'下载已过期，请重新导出');return r;}
 return[
 ['POST','/stats/export',d=>{
 authorize();if(!d.reason||!d.reason.trim()||!d.requestKey)fail(400,'请填写导出原因和提交标识');const key=currentRole()+':'+d.requestKey,signature=JSON.stringify({range:d.range,from:d.from,to:d.to,reason:d.reason});
 if(keys[key]){const r=owned(keys[key]);if(r.signature!==signature)fail(409,'导出标识冲突');return metadata(r);}
 const today=new Date(Date.now()+28800000).toISOString().slice(0,10);let start=Date.parse(today+'T00:00:00+08:00'),end=start+86400000;
 if(d.range==='week')start-=((new Date(start+28800000).getUTCDay()+6)%7)*86400000;
 if(d.range==='month')start=Date.parse(today.slice(0,8)+'01T00:00:00+08:00');
 if(d.from&&d.to){start=Date.parse(d.from+'T00:00:00+08:00');end=Date.parse(d.to+'T00:00:00+08:00')+86400000;}
 const rows=[];for(const o of db.salesTransactions||[]){
 if(Date.parse(o.createdAt)>=start&&Date.parse(o.createdAt)<end)for(const i of o.items)rows.push({time:o.createdAt,kind:'收款',no:o.no,name:i.name,spec:i.spec,store:i.store,qty:1,returned:0,amount:i.cents/100,refund:0,cost:i.costCents/100,profit:(i.cents-i.costCents)/100});
 for(const refund of o.refunds)if(Date.parse(refund.time)>=start&&Date.parse(refund.time)<end)for(const ri of refund.rows){const i=o.items.find(i=>i.id===ri.itemId),cost=refund.kind==='return'?-ri.costCents/100:0;rows.push({time:refund.time,kind:refund.kind==='return'?'退货退款':'差价退款',no:o.no,name:i.name,spec:i.spec,store:i.store,qty:0,returned:refund.kind==='return'?1:0,amount:-ri.amountCents/100,refund:ri.amountCents/100,cost,profit:-ri.amountCents/100-cost});}}
 if(rows.length>10000)fail(400,'明细超过10000行，请缩小范围');
 const r={id:'report_'+Date.now()+'_'+ ++seq,owner:currentRole(),signature,rows,costAccess:can('cost'),profitAccess:can('profit'),expiresAt:new Date(Date.now()+900000).toISOString()};records.push(r);keys[key]=r.id;db.auditLogs.unshift({id:r.id,time:new Date().toISOString(),operator:currentRole(),action:'导出销售退款报表',detail:rows.length+'行',reason:d.reason});return metadata(r);
 }],
 ['GET','/stats/exports/:id',(d,h,p)=>{authorize();const r=owned(p.id),columns=[['time','北京时间'],['kind','业务'],['no','销售单号'],['name','型号快照'],['spec','规格快照'],['store','门店快照'],['qty','销售台次'],['returned','退货台次'],['amount','收入净额（元）'],['refund','退款金额（元）'],...(r.costAccess&&can('cost')?[['cost','净成本（元）']]:[]),...(r.profitAccess&&can('profit')?[['profit','净毛利（元）']]:[])];return{...metadata(r),csv:'\uFEFF'+[columns.map(c=>cell(c[1])).join(','),...r.rows.map(row=>columns.map(c=>cell(row[c[0]])).join(','))].join('\r\n')+'\r\n'};}]
 ];
};
