/** 为员工库存/销售或公开商品中的附件判权，随后批量签名。 */
const {rpc,fail}=require('./gateway');
const storage=require('./pg-storage');
async function resolveFiles(value,user) {
 const u=user||{},rows=[],ids=new Set();
 function visit(x){if(!x||typeof x!=='object')return;
  if(Array.isArray(x.attached)){
   rows.push(x);
   for(const f of x.attached){
    const eligible=f.scope==='public'||(u.staffNo&&(((x.receiptAccess===true&&f.field_key==='salesReceipts')||(x.loanAccess===true&&f.field_key==='loanPhotos')||(x.repairAccess===true&&f.field_key==='repairPhotos'))||f.owner_id===u.id||['boss','manager','purchaser'].includes(u.role)));
    if(eligible)ids.add(f.id);
   }
  }
  for(const [k,v]of Object.entries(x))if(k!=='attached')Array.isArray(v)?v.forEach(visit):visit(v);
 }
 visit(value);if(!ids.size){for(const x of rows)x.attached=[];return;}
 const authorized=new Map(),all=[...ids];
 for(let i=0;i<all.length;i+=500){for(const f of await rpc('api_files_authorized',{p_ids:all.slice(i,i+500),p_user:user||null}))authorized.set(f.id,f);}
 const posterIds=[...new Set([...authorized.values()].map(f=>f.poster_id).filter(Boolean))];
 const posters=new Map();
 for(let i=0;i<posterIds.length;i+=500){
  for(const f of await rpc('api_files_authorized',{p_ids:posterIds.slice(i,i+500),p_user:user||null})){
   if(f.scope==='public'&&f.mime.startsWith('image/')&&f.upload_purpose==='unit_poster')posters.set(f.id,f);
  }
 }
 const groups=new Map();
 function queue(stored, target, key){
  const match=/^([A-Za-z0-9_-]+)\/(.+)$/.exec(stored||'');
  if(!match)fail(503,'附件尚未迁移到云存储');
  if(!groups.has(match[1]))groups.set(match[1],new Map());
  const group=groups.get(match[1]);
  if(!group.has(match[2]))group.set(match[2],[]);
  group.get(match[2]).push({target,key});
 }
 for(const row of rows){
  row.attached=row.attached.filter(f=>ids.has(f.id)&&authorized.has(f.id));
  for(const file of row.attached){
   const record=authorized.get(file.id);
   queue(record.stored_name,file,'resolved_url');
   const poster=posters.get(record.poster_id);
   if(poster&&record.scope==='public'&&record.mime==='video/mp4'&&poster.owner_id===record.owner_id){
    queue(poster.stored_name,file,'poster_url');
   }
  }
 }
 for(const [bucket,keys]of groups){const entries=[...keys];for(let i=0;i<entries.length;i+=500){
  const part=entries.slice(i,i+500),urls=await storage.json('object/sign/'+encodeURIComponent(bucket),{body:{expiresIn:300,paths:part.map(([k])=>k)}});
  if(!Array.isArray(urls)||urls.length!==part.length)fail(503,'附件链接响应无效');
  const byPath=new Map(urls.map(r=>[r.path,r]));
  for(const [key,files]of part){const r=byPath.get(key);if(!r||r.error||!(r.fullSignedURL||r.signedURL))fail(503,'附件不存在或无法签名');const url=r.fullSignedURL||new URL(r.signedURL,storage.origin()).href;for(const {target,key: field} of files)target[field]=url;}
 }}
}
module.exports={resolveFiles};
