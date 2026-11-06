const test=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
test('真实微信 AppID 不进版本库：project.config.json 为占位，被跟踪文件里不出现 wx 开头的 AppID',()=>{
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'project.config.json'),'utf8')).appid,'touristappid');
 const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(f=>f&&/\.(js|json|md|sh|wxml|wxs|html|txt|ya?ml)$/.test(f));
 const hits=files.filter(f=>{try{return /\bwx[0-9a-f]{16}\b/.test(fs.readFileSync(path.join(root,f),'utf8'));}catch(e){return false;}});
 assert.deepEqual(hits,[],'这些文件含真实 AppID，请改写到 project.private.config.json：'+hits.join(', '));
});
