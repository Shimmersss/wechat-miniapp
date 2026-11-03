const {createPage}=require('../../utils/page');
const api=require('../../api/index');
const channel=require('../../utils/channel');
const {ROUTES}=require('../../utils/router');
createPage({
 data:{brands:[],activeBrand:'all',list:[],page:1,hasMore:true,loading:false,error:'',scoped:false},
 onLoad(){this._context=channel.getHeaderValue();return this.refresh();},
 onShow(){const source=channel.getHeaderValue();if(source!==this._context){this._context=source;this._units=(this._units||0)+1;this.setData({loading:false,activeBrand:'all',list:[]});return this.refresh();}},
 onUnload(){this._units=(this._units||0)+1;this._home=(this._home||0)+1;},
 onPullDownRefresh(){return this.refresh().finally(()=>wx.stopPullDownRefresh());},
 refresh(){this.setData({error:'',scoped:!!channel.getHeaderValue()});return Promise.all([this.loadHome(),this.loadUnits(true)]);},
 onReachBottom(){if(this.data.hasMore)this.loadUnits(false);},
 async loadHome(){const revision=this._home=(this._home||0)+1;try{const r=await api.shop.home();if(revision===this._home)this.setData({brands:r.brands});}catch(e){if(revision===this._home)this.setData({error:e.message,brands:[]});}},
 async loadUnits(reset){
 if(this.data.loading&&!reset)return;
 const revision=this._units=(this._units||0)+1,page=reset?1:this.data.page+1;
 this.setData({loading:true,error:'',...(reset?{list:[]}:{} )});
 try{const r=await api.shop.units({brand:this.data.activeBrand,page,pageSize:20});if(revision!==this._units)return;const list=reset?r.list:this.data.list.concat(r.list);this.setData({list,page,hasMore:list.length<r.total});}
 catch(e){if(revision===this._units)this.setData({error:e.message});}finally{if(revision===this._units)this.setData({loading:false});}
 },
 onBrandTap(e){this.setData({activeBrand:e.currentTarget.dataset.value});return this.loadUnits(true);},
 onBrowseAll(){channel.clear();this._context='';this.setData({activeBrand:'all'});return this.refresh();},
 onSearchTap(){this.$go(ROUTES.SEARCH);},
 onUnitSelect(e){this.$go(ROUTES.PRODUCT,{id:e.detail.id});},
 onShareAppMessage(){return{title:'夏目数码 · 让价格透明 · 让产品放心',path:ROUTES.SHOP};}
});
