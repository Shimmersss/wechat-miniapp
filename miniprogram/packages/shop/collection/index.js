const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const channel=require('../../../utils/channel');
const {ROUTES}=require('../../../utils/router');
createPage({
 data:{shareId:'',share:null,error:'',loading:false},
 onLoad(query){channel.captureFromLaunch({query});this.setData({shareId:query.s||channel.getHeaderValue()});return this.load();},
 onShow(){if(this.data.share&&!this.data.loading)return this.load();},
 onUnload(){this._revision=(this._revision||0)+1;},
 async load(){const revision=this._revision=(this._revision||0)+1;this.setData({loading:true,error:'',share:null});try{if(!this.data.shareId)throw new Error('缺少分享编号');const share=await api.share.resolve(this.data.shareId);if(revision===this._revision)this.setData({share});}catch(e){if(revision===this._revision)this.setData({error:e.message});}finally{if(revision===this._revision)this.setData({loading:false});}},
 onSelect(e){this.$go(ROUTES.PRODUCT,{id:e.detail.id,s:this.data.shareId});},
 onBrowseShop(){channel.clear();this.$go(ROUTES.SHOP);},
 onShareAppMessage(){const s=this.data.share;return{title:'夏目数码',path:ROUTES.SHOP,...(s?{promise:api.share.resolve(s.shareId).then(r=>({title:r.title,path:r.path,imageUrl:r.imageUrl}))}:{})};}
});
