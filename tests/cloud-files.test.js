const test=require('node:test');
const assert=require('node:assert/strict');
const {upload}=require('../miniprogram/utils/request');
const withTiming=require('../cloudfunctions/common/startup-timing');
function wxMock({status=200,finishCode=0,processing=false,foreignBuffer=false}={}){
 const calls=[];let completed=0;
 global.wx={getStorageSync:k=>k==='xm_token'?'employee-token':'',getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),getFileSystemManager:()=>({readFile:o=>o.success({data:foreignBuffer?require('node:vm').runInNewContext('new Uint8Array([1,2,3]).buffer'):new Uint8Array([1,2,3]).buffer})}),showToast(){},cloud:{init(){},callFunction(o){calls.push(o);o.success({result:o.data.path.endsWith('upload-intent')?{code:0,data:{uploadId:'id',uploadUrl:'https://storage.test/signed?token=limited'}}:processing&&completed++===0?{code:0,data:{processing:true,processedBytes:1,totalBytes:3}}:{code:finishCode,message:finishCode?'核验失败':'ok',data:finishCode?null:{fileId:'id',scope:'internal',url:'https://storage.test/read'}}});}},request(o){calls.push(o);assert.equal(o.method,'PUT');assert.equal(o.header.Authorization,undefined);assert.equal(Object.values(o.header).includes('employee-token'),false);o.success({statusCode:status});}};
 return calls;
}
test('云上传只给受限地址传原始字节，登记完成前不返回文件',async()=>{
 const calls=wxMock();const f=await upload({filePath:'/temp/image.png',scope:'internal'});assert.equal(f.fileId,'id');assert.equal(calls.length,3);assert.equal(calls[0].name,'files');assert.equal(calls[0].data.data.scope,'internal');assert.equal(calls[0].data.data.size,3);assert.equal(calls[1].data.byteLength,3);assert.equal(calls[2].data.path,'/files/id/complete');
});
test('二进制传输失败不继续登记；核验失败不假装成功',async()=>{
 const calls=wxMock({status:500});await assert.rejects(upload({filePath:'/temp/a',scope:'internal'}),/传输失败/);assert.equal(calls.length,2);
 wxMock({finishCode:400});await assert.rejects(upload({filePath:'/temp/b',scope:'internal'}),/核验失败/);
});
test('timing只在development返回，production与未配置环境均不返回',async()=>{
 const original=process.env.NODE_ENV;
 try{for(const env of ['production','test','']){process.env.NODE_ENV=env;const handler=withTiming(async()=>({code:0,data:{ok:true}}),process.hrtime.bigint());assert.equal(Object.hasOwn(await handler(), 'timing'),false);}
 process.env.NODE_ENV='development';const handler=withTiming(async()=>({code:0}),process.hrtime.bigint());assert.equal((await handler()).timing.coldStart,true);assert.equal((await handler()).timing.coldStart,false);
 }finally{if(original===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=original;}
});

test('分段核验响应不当作文件成功，继续到最后登记完成',async()=>{const calls=wxMock({processing:true});const file=await upload({filePath:'/temp/chunk',scope:'internal'});assert.equal(file.fileId,'id');assert.equal(calls.length,4);});

test('微信文件系统跨JS上下文返回的ArrayBuffer仍可上传',async()=>{wxMock({foreignBuffer:true});assert.equal((await upload({filePath:'/temp/native',scope:'internal'})).fileId,'id');});

test('云代理复合前缀优先路由，未知管理接口明确失败',async()=>{
 const {request}=require('../miniprogram/utils/request');const calls=wxMock();
 for(const url of ['/shop/shares/abcdefghijklmnop','/admin/agents','/admin/agent-orders','/admin/agent-earnings']){await request({url,showError:false});assert.equal(calls.at(-1).name,'agent');}
 for(const url of ['/shop/contact-options','/shop/consults','/shop/appointments','/shop/orders','/shop/requests','/customer-requests','/visits/batch']){await request({url,showError:false});assert.equal(calls.at(-1).name,'customer');}
 for(const url of ['/stats/overview','/audit-logs/filters','/staff/dashboard']){await request({url,showError:false});assert.equal(calls.at(-1).name,'staff-reports');}
 for(const url of ['/staff','/roles','/staff/example/unbind']){await request({url,showError:false});assert.equal(calls.at(-1).name,'staff-admin');}
 await request({url:'/shop/units',showError:false});assert.equal(calls.at(-1).name,'shop');
 await assert.rejects(request({url:'/admin/unimplemented',showError:false}),e=>e.code===501);
});
