const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const {PERM}=require('../../../constants/roles');
const {ROUTES}=require('../../../utils/router');
const {scan,unitCode}=require('../../../utils/scan');
const {confirmSensitive}=require('../../../utils/confirm');
createPage({
 requireStaff:true,permission:PERM.SHARE,
 data:{keyword:'',results:[],selected:[],active:'customer',audiences:[{value:'customer',label:'顾客分享'},{value:'peer',label:'同行分享'},{value:'agent',label:'代理分享'}],share:null,loading:false,searching:false,error:''},
 onLoad(query){if(query.unitId){this.setData({keyword:query.unitId});return this.search();}},
 onUnload(){this._revision=(this._revision||0)+1;this._search=(this._search||0)+1;},
 invalidate(patch={}){this._revision=(this._revision||0)+1;this.setData({...patch,share:null,error:'',loading:false});},
 onKeyword(e){this.setData({keyword:e.detail.value});},
 async onScan(){try{this.setData({keyword:unitCode(await scan())});await this.search();}catch(e){if(!/cancel/.test(e.errMsg||''))this.$toast(e.message||'扫码未完成');}},
 async search(){
 const revision=this._search=(this._search||0)+1;
 this.setData({searching:true,results:[],error:''});
 try{const r=await api.inventory.list({keyword:this.data.keyword.trim(),status:'in_stock',pageSize:50});if(revision===this._search)this.setData({results:r.list});}
 catch(e){if(revision===this._search)this.setData({error:e.message});}
 finally{if(revision===this._search)this.setData({searching:false});}
 },
 onAdd(e){const id=e.currentTarget.dataset.id,u=this.data.results.find(u=>u.id===id);if(!u||this.data.selected.some(u=>u.id===id))return;if(this.data.selected.length>=50)return this.$toast('每个合集最多50台');this.invalidate({selected:this.data.selected.concat([{id:u.id,name:u.name,storage:u.storage,color:u.color,imeiMasked:u.imeiMasked}])});},
 onRemove(e){this.invalidate({selected:this.data.selected.filter(u=>u.id!==e.currentTarget.dataset.id)});},
 onAudienceTap(e){this.invalidate({active:e.currentTarget.dataset.value});},
 async createLink(){
 if(this.data.loading||!this.data.selected.length)return this.$toast('请先选择设备');
 const revision=this._revision=(this._revision||0)+1,channel=this.data.active,unitIds=this.data.selected.map(u=>u.id);
 this.setData({loading:true,share:null,error:''});
 try{const share=await api.share.createLink({unitIds,channel});if(revision===this._revision)this.setData({share});}
 catch(e){if(revision===this._revision)this.setData({error:e.message});}
 finally{if(revision===this._revision)this.setData({loading:false});}
 },
 async onCopy(){if(!this.data.share)return;try{const r=await api.share.copywriting(this.data.share.shareId);wx.setClipboardData({data:r.text});}catch(e){this.$toast(e.message);}},
 onPreview(){const s=this.data.share;if(s)this.$go(s.units.length===1?ROUTES.PRODUCT:ROUTES.COLLECTION,{s:s.shareId});},
 onPoster(){if(this.data.share)this.$go(ROUTES.POSTER,{s:this.data.share.shareId});},
 async onRevoke(){const s=this.data.share;if(!s)return;const c=await confirmSensitive({title:'撤销分享',content:'撤销后此分享链接将不可访问。',needReason:true});if(!c.confirmed)return;try{await api.share.revoke(s.shareId,{reason:c.reason});if(this.data.share?.shareId===s.shareId)this.invalidate();this.$toast('分享已撤销');}catch(e){this.$toast(e.message);}},
 onShareAppMessage(){const s=this.data.share;return{title:'夏目数码',path:ROUTES.SHOP,...(s?{promise:api.share.resolve(s.shareId).then(r=>({title:r.title,path:r.path,imageUrl:r.imageUrl}))}:{})};}
});
