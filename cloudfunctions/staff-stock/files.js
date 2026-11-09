/** files.stored_name 在 PG 下为 bucket/object；只为旧 stock.view 允许读取的附件签名。 */
const {fail,secret}=require('./shared/gateway');
async function resolveFiles(value,user) {
  const groups=new Map();
  function visit(x){
    if(!x||typeof x!=='object')return;
    if(Array.isArray(x.attached))for(const f of x.attached){
      if(f.scope!=='public'&&!(user.staffNo&&(f.owner_id===user.id||['boss','manager','purchaser'].includes(user.role))))continue;
      const parts=/^([A-Za-z0-9_-]+)\/(.+)$/.exec(f.stored_name||'');
      if(!parts)fail(503,'附件尚未迁移到云存储');
      const [,bucket,key]=parts; if(!groups.has(bucket))groups.set(bucket,new Map());
      const g=groups.get(bucket);if(!g.has(key))g.set(key,[]);g.get(key).push(f);
    }
    for(const [k,v]of Object.entries(x))if(k!=='attached')Array.isArray(v)?v.forEach(visit):visit(v);
  }
  visit(value);
  const origin=`https://${process.env.TCB_ENV||process.env.SCF_NAMESPACE}.api.tcloudbasegateway.com`;
  for(const [bucket,keys]of groups) {
    const entries=[...keys];
    for(let i=0;i<entries.length;i+=500){
      const part=entries.slice(i,i+500);
      const res=await fetch(`${origin}/v1/storages/object/sign/${encodeURIComponent(bucket)}`,{method:'POST',headers:{Authorization:`Bearer ${secret('CLOUDBASE_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:300,paths:part.map(([k])=>k)})});
      if(!res.ok)fail(503,'附件链接获取失败，请重试');
      const urls=await res.json();
      if(!Array.isArray(urls)||urls.length!==part.length)fail(503,'附件链接响应无效');
      for(let j=0;j<part.length;j++){
        const r=urls[j];if(r.error||!(r.fullSignedURL||r.signedURL))fail(503,'附件不存在或无法签名');
        const url=r.fullSignedURL||new URL(r.signedURL,origin).href;
        for(const f of part[j][1])f.resolved_url=url;
      }
    }
  }
}
module.exports={resolveFiles};
