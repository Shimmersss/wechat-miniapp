const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('访问队列保留发生时来源，分组上传与失败原标识重试',async()=>{
 let source='',retry=true;const calls=[];
 const track={module:{exports:{}},require:name=>name.endsWith('config/index')?{storageKeys:{visitorId:'visitor'}}:name==='./channel'?{getHeaderValue:()=>source}:{visit:{report:async(data,s)=>{calls.push({data,s});if(s==='A'&&retry)throw new Error('network');}}},wx:{getStorageSync:()=> 'visitor_fixture'},Date,Math};
 vm.runInNewContext(fs.readFileSync('miniprogram/utils/track.js','utf8'),track);const t=track.module.exports;
 source='A';t.pageView('pages/shop/index');source='B';t.pageView('packages/shop/product/index');source='';t.event('share');await t.flush();assert.deepEqual(calls.map(c=>c.s),['A','B','']);assert.ok(calls.every(c=>c.data.events[0].sourceShareId===undefined));const id=calls[0].data.events[0].eventId;retry=false;await t.flush();assert.equal(calls.at(-1).s,'A');assert.equal(calls.at(-1).data.events[0].eventId,id);
});
