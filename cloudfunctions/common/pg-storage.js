/** 只在服务端使用的 PG Storage API；路径来自数据库，不接收客户端 URL。 */
const {fail,secret}=require('./gateway');
const MAX_BYTES=32*1024*1024;
function origin(){const id=process.env.TCB_ENV||process.env.SCF_NAMESPACE;if(!id)fail(503,'无法识别云环境');return `https://${id}.api.tcloudbasegateway.com`;}
function objectPath(bucket,key){return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;}
async function request(path,{method='GET',body,headers={}}={}){
 return fetch(origin()+'/v1/storages/'+path,{method,body,headers:{Authorization:`Bearer ${secret('CLOUDBASE_API_KEY')}`,...headers},signal:AbortSignal.timeout(Number(process.env.STORAGE_TIMEOUT_MS)||12000)});
}
async function json(path,{method='POST',body={},headers={}}={}){
 const r=await request(path,{method,body:JSON.stringify(body),headers:{'Content-Type':'application/json',...headers}});
 const data=await r.json();if(!r.ok){console.error('[storage]',r.status,data.code);fail(503,'云存储暂不可用，请重试');}return data;
}
const CHUNK_BYTES=512*1024;
async function info(bucket,key){const r=await request('object/info/'+objectPath(bucket,key));if(r.status===404)return null;if(!r.ok)fail(503,'读取云存储元信息失败');return r.json();}
async function copy(sourceBucket,sourceKey,destinationBucket,destinationKey,mime='application/octet-stream'){
 if(await info(destinationBucket,destinationKey))return;
 await json('object/copy',{body:{bucketId:sourceBucket,sourceKey,destinationBucket,destinationKey,copyMetadata:false,metadata:{contentType:mime,mimetype:mime,cacheControl:'private,no-store'}}});
}
async function readChunk(bucket,key,offset,total){
 const end=Math.min(offset+CHUNK_BYTES,total)-1;
 const r=await request('object/'+objectPath(bucket,key),{headers:{Range:`bytes=${offset}-${end}`}});
 if(r.status===404)fail(409,'校验对象不存在，请重试');
 const expected=`bytes ${offset}-${end}/${total}`;
 if(!((r.status===206&&r.headers.get('content-range')===expected)||(r.status===200&&offset===0&&total<=CHUNK_BYTES))){await r.body?.cancel();fail(400,'实际文件大小不符或存储不支持分段读取');}
 const reader=r.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>end-offset+1){await reader.cancel();fail(400,'实际文件大小不符');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
 if(size!==end-offset+1)fail(400,'文件分段不完整');
 return Buffer.concat(chunks,size);
}
async function signRead(storedName){
 const m=/^([A-Za-z0-9_-]+)\/(.+)$/.exec(storedName||'');if(!m)fail(503,'该文件尚未迁移到云存储');
 const result=await json('object/sign/'+objectPath(m[1],m[2]),{body:{expiresIn:300}});
 if(!result.fullSignedURL&&!result.signedURL)fail(503,'文件链接获取失败');
 return result.fullSignedURL||new URL(result.signedURL,origin()).href;
}
async function signUpload(id){
 const result=await json('object/upload/sign/'+objectPath('xiamu-staging',id),{headers:{'x-upsert':'false'}});
 if(!result.fullURL&&!result.url)fail(503,'上传链接获取失败');
 return result.fullURL||new URL(result.url,origin()).href;
}
async function removeTemporary(bucket,key){const r=await request('object/'+objectPath(bucket,key),{method:'DELETE'});if(!r.ok&&r.status!==404)console.warn('[storage] temporary cleanup deferred',r.status);}
module.exports={MAX_BYTES,CHUNK_BYTES,origin,objectPath,request,json,info,copy,readChunk,signRead,signUpload,removeTemporary};
