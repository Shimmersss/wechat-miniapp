const {money}=require('./format');
const invoke=(name,options,scope)=>new Promise((resolve,reject)=>wx[name]({...options,success:resolve,fail:reject},scope));
function lines(ctx,text,width,count){const result=[];let line='';for(const char of String(text||'').replace(/\s+/g,' ')){if(ctx.measureText(line+char).width>width&&line){result.push(line);line='';if(result.length===count){result[count-1]=result[count-1].slice(0,-1)+'…';return result;}}line+=char;}if(line)result.push(line);return result;}
function query(page){return new Promise((resolve,reject)=>{const q=wx.createSelectorQuery().in(page);q.select('#poster-canvas').fields({node:true,size:true});['surface','ink','gold','muted'].forEach(key=>q.select('.poster-'+key).fields({computedStyle:['color']}));q.exec(result=>result&&result[0]?.node&&result.slice(1).every(r=>r?.color)?resolve(result):reject(new Error('海报画布尚未就绪')));});}
function image(canvas,src){return new Promise((resolve,reject)=>{const img=canvas.createImage();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('海报图片读取失败'));img.src=src;});}
async function draw(page,data,brand){
 if(!data.qrcode||data.qrcodeStatus!=='ready')throw new Error(data.message||'暂无法生成可扫码海报');
 const [node,...palette]=await query(page),canvas=node.node,ctx=canvas.getContext('2d'),[surface,ink,gold,muted]=palette.map(p=>p.color),width=680,height=1240;
 const fs=wx.getFileSystemManager(),codePath=wx.env.USER_DATA_PATH+'/poster-code-'+data.shareId+(data.qrcode.mime==='image/jpeg'?'.jpg':'.png');
 await new Promise((resolve,reject)=>fs.writeFile({filePath:codePath,data:data.qrcode.base64,encoding:'base64',success:resolve,fail:reject}));
 const code=await image(canvas,codePath);let cover=null;
 if(data.imageUrl){const local=await invoke('getImageInfo',{src:data.imageUrl});cover=await image(canvas,local.path);}
 canvas.width=width;canvas.height=height;ctx.fillStyle=surface;ctx.fillRect(0,0,width,height);ctx.fillStyle=gold;ctx.font='bold 32px sans-serif';ctx.fillText(brand.name,36,60);ctx.fillStyle=muted;ctx.font='18px sans-serif';ctx.fillText(brand.slogan,36,94);
 if(cover){const scale=Math.max(608/cover.width,480/cover.height),w=cover.width*scale,h=cover.height*scale;ctx.save();ctx.beginPath();ctx.rect(36,124,608,480);ctx.clip();ctx.drawImage(cover,36+(608-w)/2,124+(480-h)/2,w,h);ctx.restore();}
 else{ctx.fillStyle=ink;ctx.font='28px sans-serif';ctx.fillText('查看小程序内设备资料',36,360);}
 ctx.fillStyle=ink;ctx.font='bold 30px sans-serif';const title=data.units.length===1?data.units[0].name:data.title;lines(ctx,title,600,2).forEach((t,i)=>ctx.fillText(t,36,656+i*40));
 ctx.font='22px sans-serif';const u=data.units[0];ctx.fillStyle=muted;ctx.fillText(data.units.length===1?[u.storage,u.color,u.grade].filter(Boolean).join(' · '):data.units.length+'台设备 · 扫码查看完整合集',36,748);
 if(data.units.length===1){ctx.fillStyle=gold;ctx.font='bold 44px sans-serif';ctx.fillText('¥'+money(data.price),36,822);ctx.font='18px sans-serif';ctx.fillText(data.channel==='peer'?'同行授权价':'顾客零售价',36,856);}
 ctx.fillStyle=ink;ctx.font='22px sans-serif';lines(ctx,data.units.length===1?u.desc:'一机一档 · 价格及可售状态以打开小程序时为准',350,4).forEach((t,i)=>ctx.fillText(t,36,922+i*32));
 ctx.drawImage(code,428,912,216,216);ctx.fillStyle=muted;ctx.font='17px sans-serif';ctx.fillText(data.channel==='peer'?'授权同行扫码查看':'扫码查看最新机况',428,1154);
 const expiry=new Date(data.expireAt),expiryText=Number.isFinite(+expiry)?new Date(+expiry+28800000).toISOString().slice(0,16).replace('T',' '):'';ctx.fillText('分享有效至 '+expiryText,36,1196);
 const output=await invoke('canvasToTempFilePath',{canvas,width,height,destWidth:width,destHeight:height,fileType:'png'},page);return output.tempFilePath;
}
module.exports={draw};
