const {createHandler,rpc,fail,HttpError}=require('./shared/gateway');
const {currentUser,requireUser}=require('./shared/identity');
const storage=require('./shared/pg-storage');
const {createSHA256}=require('hash-wasm');
function uuid(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))fail(400,'文件标识无效');return value;}
const fileView=async f=>({fileId:f.id,scope:f.scope,mime:f.mime,size:Number(f.byte_size),url:await storage.signRead(f.stored_name)});
async function uploadRpc(ctx,user,action,id,data={}){return rpc('api_file_upload',{p_action:action,p_id:id,p_data:data,p_user:user,p_request_id:ctx.requestId});}
async function intent(ctx){
 const user=await requireUser(ctx),d=ctx.data;
 if(!Number.isInteger(d.size)||d.size<1||d.size>storage.MAX_BYTES)fail(d.size>storage.MAX_BYTES?413:400,'文件须为1～32MB');
 const result=await uploadRpc(ctx,user,'intent',null,d);
 if(result.file)return {file:await fileView(result.file)};
 if(result.upload.status==='failed'||Date.parse(result.upload.expires_at)<=Date.now())fail(409,'上传已失效，请重试');
 return {uploadId:result.upload.id,uploadUrl:await storage.signUpload(result.upload.id),method:'PUT'};
}
async function complete(ctx){
 const user=await requireUser(ctx),id=uuid(ctx.params.id);
 const state=await uploadRpc(ctx,user,'begin',id);
 if(state.file)return fileView(await rpc('api_file_read',{p_id:id,p_user:user}));
 let upload=state.upload;const lease=upload.lease;
 const progress=data=>rpc('api_file_progress',{p_id:id,p_lease:lease,p_data:data,p_user:user});
 try{
  // 校验区每次用新的租约编号生成对象名。客户端没有这个区的写入签名，内容固定后才开始散列。
  if(!upload.sealed_key){
   if(!await storage.info('xiamu-staging',id))fail(409,'文件尚未上传，请重试');
   const sealedKey=id+'-'+lease;
   await storage.copy('xiamu-staging',id,'xiamu-sealed',sealedKey);
   upload=await progress({stage:'seal',sealedKey});
  }
  if(upload.verified_bytes<upload.expected_size){
   const bytes=await storage.readChunk('xiamu-sealed',upload.sealed_key,upload.verified_bytes,upload.expected_size);
   let mime=upload.detected_mime;
   if(upload.verified_bytes===0){
    const {fileTypeFromBuffer}=await import('file-type');let type;
    try{type=await fileTypeFromBuffer(bytes);}catch(e){if(e.name==='EndOfStreamError')fail(400,'文件内容不完整');throw e;}
    if(!type||!['image/jpeg','image/png','image/webp','video/mp4'].includes(type.mime))fail(400,'仅支持 JPEG、PNG、WebP 或 MP4');
    if(upload.scope==='internal'&&type.mime==='video/mp4')fail(400,'内部凭证请上传图片');
    mime=type.mime;
   }
   const hasher=await createSHA256();if(upload.hash_state)hasher.load(Buffer.from(upload.hash_state,'base64'));else hasher.init();
   hasher.update(bytes);
   const next=upload.verified_bytes+bytes.length,done=next===upload.expected_size;
   const hashState=Buffer.from(hasher.save()).toString('base64'),sha256=done?hasher.digest('hex'):undefined;
   upload=await progress({stage:'chunk',from:upload.verified_bytes,offset:next,hashState,mime,sha256});
   if(!done)return {processing:true,uploadId:id,processedBytes:next,totalBytes:upload.expected_size};
  }
  // 正式对象来自已验证的固定快照；大文件只做存储侧复制，不经函数再搬运整份内容。
  await storage.copy('xiamu-sealed',upload.sealed_key,'xiamu-'+upload.scope,upload.sealed_key,upload.detected_mime);
  const result=await uploadRpc(ctx,user,'commit',id,{lease,mime:upload.detected_mime,size:upload.expected_size,sha256:upload.verified_sha});
  const cleanup=await Promise.allSettled([storage.removeTemporary('xiamu-staging',id),storage.removeTemporary('xiamu-sealed',upload.sealed_key)]);
  if(cleanup.some(r=>r.status==='rejected'))console.warn('[storage] temporary cleanup deferred');
  return fileView(result.file);
 }catch(e){
  try{await uploadRpc(ctx,user,'fail',id,{lease,permanent:e instanceof HttpError&&[400,413].includes(e.statusCode),message:e instanceof HttpError?e.message:'核验中断，请重试'});}catch(stateError){console.error('[upload] state update failed',id,stateError.name);}
  throw e;
 }
}

exports.main=createHandler([
 ['POST','/files/upload-intent',intent],
 ['POST','/files/:id/complete',complete],
 ['GET','/files/:id',async ctx=>fileView(await rpc('api_file_read',{p_id:uuid(ctx.params.id),p_user:await currentUser(ctx)}))],
]);
