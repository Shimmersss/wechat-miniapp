const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const track=require('../../../utils/track');
const channel=require('../../../utils/channel');
const poster=require('../../../utils/poster');
const {ROUTES}=require('../../../utils/router');
createPage({
 data:{shareId:'',unitId:'',channel:'customer',share:null,posterPath:'',loading:false,drawing:false,error:'',albumDenied:false},
 onLoad(query){channel.captureFromLaunch({query});this.setData({shareId:query.s||'',unitId:query.unitId||'',channel:query.channel||'customer'});return this.load();},
 onUnload(){this._revision=(this._revision||0)+1;},
 async load(){const revision=this._revision=(this._revision||0)+1;this.setData({loading:true,error:'',share:null,posterPath:'',drawing:false});try{let id=this.data.shareId;if(!id){if(!this.data.unitId)throw new Error('缺少分享设备');id=(await api.share.createLink({unitId:this.data.unitId,channel:this.data.channel})).shareId;if(revision!==this._revision)return;this.setData({shareId:id});}const share=await api.share.poster(id);if(revision===this._revision)this.setData({share});}catch(e){if(revision===this._revision)this.setData({error:e.message});}finally{if(revision===this._revision)this.setData({loading:false});}},
 async drawPoster(){if(this.data.drawing||!this.data.share)return '';const revision=this._revision;this.setData({drawing:true,error:''});try{const data=await api.share.poster(this.data.shareId);if(revision!==this._revision)return '';this.setData({share:data});const posterPath=await poster.draw(this,data,this.data.brand);if(revision!==this._revision)return '';this.setData({posterPath});return posterPath;}catch(e){if(revision===this._revision)this.setData({error:e.message||e.errMsg||'海报生成失败'});return '';}finally{if(revision===this._revision)this.setData({drawing:false});}},
 async onSave(){if(this.data.drawing)return;const filePath=await this.drawPoster();if(!filePath)return;try{await new Promise((resolve,reject)=>wx.saveImageToPhotosAlbum({filePath,success:resolve,fail:reject}));this.setData({albumDenied:false});track.event('poster_save',{unitId:this.data.unitId||undefined});this.$toast('已保存到相册','success');}catch(e){const denied=/auth|deny|denied/.test(e.errMsg||'');this.setData({albumDenied:denied,error:denied?'未获得相册权限，请在设置中开启后重试。':e.errMsg||'海报保存未完成'});}},
 onOpenSettings(){wx.openSetting({});},
 async onCopy(){if(!this.data.share)return;try{const r=await api.share.copywriting(this.data.shareId);wx.setClipboardData({data:r.text});}catch(e){this.$toast(e.message);}},
 onShareAppMessage(){const s=this.data.share;return{title:'夏目数码',path:ROUTES.SHOP,...(s?{promise:api.share.resolve(s.shareId).then(r=>({title:r.title,path:r.path,imageUrl:r.imageUrl}))}:{})};}
});
