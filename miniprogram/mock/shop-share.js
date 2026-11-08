const {PERM,SENSITIVE_FIELDS,STAFF_ROLES}=require('../constants/roles');
module.exports=function(db,{fail,currentRole,requirePermission,paginate,publicUnit,agents}){
 const flagOf=channel=>channel==='peer'?'sharePeer':channel==='agent'?'shareAgent':'showInShop';
 const links=db.shareLinks=db.shareLinks||[];let sequence=0;
 const peer=role=>role==='peer'||(STAFF_ROLES.includes(role)&&SENSITIVE_FIELDS.wholesalePrice.includes(role));
 const owner=()=> 'mock_'+currentRole();
 function resolve(id){
 const s=links.find(s=>s.shareId===id);if(!s||!s.active)fail(404,'分享不存在或已撤销');if(s.expiresAt<=Date.now())fail(410,'分享已过期');if(s.channel==='peer'&&!peer(currentRole()))fail(403,'此分享仅供已授权同行查看');if(s.channel==='agent'&&!agents.isActive(s.ownerId))fail(410,'代理资格已变更，分享失效');
 const units=s.snapshots.map(i=>{const u=db.units.find(u=>u.id===i.id);if(!u||u.status!=='in_stock'||!u.flags[flagOf(s.channel)])fail(410,'分享中的设备已下架或不可售');if((u.priceVersion||1)!==i.priceVersion)fail(410,'商品价格已变化，请重新分享');return publicUnit(u,{channel:s.channel,price:i.price});});return{...s,units};
 }
 function metadata(s){const single=s.units.length===1,u=s.units[0];return{shareId:s.shareId,channel:s.channel,path:(single?'/packages/shop/product/index':'/packages/shop/collection/index')+'?s='+s.shareId,title:single?u.name+' '+u.storage+' ¥'+u.price:'夏目数码 · '+s.units.length+'台精选设备',price:single?u.price:undefined,imageUrl:u.cover,expireAt:new Date(s.expiresAt).toISOString(),units:s.units};}
 function context(h){return h&&h['X-Channel']?resolve(h['X-Channel']):null;}
 function eligible(h){const c=context(h),channel=c?c.channel:currentRole()==='peer'?'peer':'customer';return{c,channel,units:db.units.filter(u=>u.status==='in_stock'&&u.flags[flagOf(channel)]&&(!c||c.snapshots.some(i=>i.id===u.id)))};}
 /** 成色/电池下限/价格区间，只按公开视图里的取值筛选（与服务端一致） */
 function factFilters(d){const set=v=>v!==undefined&&v!=='',amount=(v,label)=>{if(!/^\d{1,9}(\.\d{1,2})?$/.test(String(v)))fail(400,label+'须为非负金额，最多两位小数');return Number(v);};
 const grade=set(d.grade)?String(d.grade):'',min=set(d.priceMin)?amount(d.priceMin,'最低价'):null,max=set(d.priceMax)?amount(d.priceMax,'最高价'):null;let battery=null;
 if(set(d.batteryMin)){if(!/^\d{1,3}$/.test(String(d.batteryMin))||Number(d.batteryMin)>100)fail(400,'电池健康须为0～100的整数');battery=Number(d.batteryMin);}
 if(min!==null&&max!==null&&min>max)fail(400,'最低价不能高于最高价');if(!grade&&min===null&&max===null&&battery===null)return null;
 return u=>(!grade||u.grade===grade)&&(min===null||u.price>=min)&&(max===null||u.price<=max)&&(battery===null||(Number.isFinite(u.battery)&&u.battery>=battery));}
 function view(u,c,channel){return publicUnit(u,{channel,price:c?c.snapshots.find(i=>i.id===u.id).price:undefined});}
 return{resolve,routes:[
 ['POST','/share/links',d=>{
 const channel=d.channel||'customer',role=currentRole();if(!['customer','peer','agent'].includes(channel))fail(400,'分享渠道无效');if(channel==='agent'&&!agents.canShare())fail(403,'仅已审核通过的代理可生成代理分享');if(channel==='peer'&&!peer(role))fail(403,'无同行分享权限');if(STAFF_ROLES.includes(role))requirePermission(PERM.SHARE);
 const ids=d.unitIds||[d.unitId];if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length)fail(400,'请选择1～50台不重复设备');
 const snapshots=ids.map(id=>{const u=db.units.find(u=>u.id===id);if(!u||u.status!=='in_stock'||!u.flags[flagOf(channel)])fail(409,'所选设备不可对外分享');if(channel==='agent'){const markup=agents.markupOf(owner(),id);return{id,priceVersion:u.priceVersion||1,markup,price:(Math.round(u.agentBase*100)+markup)/100};}return{id,priceVersion:u.priceVersion||1,price:channel==='peer'?u.wholesale:u.retail};});
 const shareId=(Date.now().toString(36).padStart(10,'0')+(++sequence).toString(36).padStart(6,'0')).slice(-16);const s={shareId,channel,ownerId:owner(),active:true,createdAt:Date.now(),expiresAt:Date.now()+72*3600000,snapshots};links.push(s);return metadata(resolve(shareId));
 }],
 ['GET','/shop/shares/:id',(d,h,p)=>metadata(resolve(p.id))],
 ['PATCH','/share/links/:id/revoke',(d,h,p)=>{const s=links.find(s=>s.shareId===p.id&&s.ownerId===owner());if(!s)fail(404,'分享不存在');if(!d.reason||!d.reason.trim())fail(400,'请填写撤销说明');s.active=false;return{revoked:true};}],
 ['GET','/share/links/:id/copywriting',(d,h,p)=>{const s=resolve(p.id);return{text:s.units.map(u=>u.name+' '+u.storage+' '+u.color+' ¥'+u.price+'\n'+(u.desc||'')).join('\n\n'),shareId:s.shareId};}],
 ['GET','/share/links/:id/poster',(d,h,p)=>({...metadata(resolve(p.id)),qrcode:null,qrcodeStatus:'unconfigured',message:'暂无法生成可扫码海报，请使用小程序卡片分享'})],
 ['GET','/shop/home',(d,h)=>{const {units}=eligible(h),brands=[...new Set(units.map(u=>u.brand))];return{todayStock:units.length,brands:[{value:'all',label:'全部'},...brands.map(b=>(db.brands||[]).find(i=>i.value===b)||{value:b,label:b})],banners:[]};}],
 ['GET','/shop/units',(d,h)=>{let {units,c,channel}=eligible(h);if(d.brand&&d.brand!=='all')units=units.filter(u=>u.brand===d.brand);if(d.category)units=units.filter(u=>(u.category||db.models.find(m=>m.id===u.modelId)?.category)===d.category);if(d.modelId)units=units.filter(u=>u.modelId===d.modelId);if(d.condition)units=units.filter(u=>u.condition===d.condition);if(d.keyword)units=units.filter(u=>(u.name+u.storage+u.color).toLowerCase().includes(String(d.keyword).toLowerCase()));if(d.sort&&!['price_asc','price_desc'].includes(d.sort))fail(400,'排序方式无效');const facts=factFilters(d),rows=units.map(u=>view(u,c,channel)),matched=facts?rows.filter(facts):rows;if(d.sort)matched.sort((a,b)=>(d.sort==='price_asc'?a.price-b.price:b.price-a.price));return paginate(matched,d);}],
 ['GET','/shop/units/:id',(d,h,p)=>{const {units,c,channel}=eligible(h),u=units.find(u=>u.id===p.id);if(!u)fail(404,'商品不存在或已下架');return view(u,c,channel);}]
 ]};
};
