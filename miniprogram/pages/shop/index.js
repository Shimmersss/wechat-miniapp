const {createPage}=require('../../utils/page');
const api=require('../../api/index');
const channel=require('../../utils/channel');
const {ROUTES}=require('../../utils/router');
const {EMPTY_FILTERS,brandTiles,toQuery}=require('../../utils/shop-filter');
createPage({
 data:{tiles:brandTiles(),filters:EMPTY_FILTERS,filterRaised:false,list:[],page:1,hasMore:true,loading:false,error:'',scoped:false},
 onLoad(){this._context=channel.getHeaderValue();return this.refresh();},
 onShow(){const source=channel.getHeaderValue();if(source!==this._context){this._context=source;this._units=(this._units||0)+1;this.setData({loading:false,filters:EMPTY_FILTERS,list:[]});return this.refresh();}},
 onHide(){const filter=this.selectComponent('#filter');if(filter)filter.close();},
 onUnload(){this._units=(this._units||0)+1;this._home=(this._home||0)+1;},
 onPullDownRefresh(){return this.refresh().finally(()=>wx.stopPullDownRefresh());},
 refresh(){this.setData({error:'',scoped:!!channel.getHeaderValue()});return Promise.all([this.loadHome(),this.loadUnits(true)]);},
 onReachBottom(){if(this.data.hasMore)this.loadUnits(false);},
 async loadHome(){const revision=this._home=(this._home||0)+1;try{const r=await api.shop.home();if(revision===this._home)this.setData({tiles:brandTiles(r.brands)});}catch(e){if(revision===this._home)this.setData({error:e.message});}},
 async loadUnits(reset){
 if(this.data.loading&&!reset)return;
 const revision=this._units=(this._units||0)+1,page=reset?1:this.data.page+1;
 this.setData({loading:true,error:'',...(reset?{list:[]}:{} )});
 try{const r=await api.shop.units({...toQuery(this.data.filters),page,pageSize:20});if(revision!==this._units)return;const list=reset?r.list:this.data.list.concat(r.list);this.setData({list,page,hasMore:list.length<r.total});}
 catch(e){if(revision===this._units)this.setData({error:e.message});}finally{if(revision===this._units)this.setData({loading:false});}
 },
 /** 品牌入口再点一次取消；品牌和型号互斥，选品牌时清掉型号 */
 onBrandTap(e){const {value}=e.currentTarget.dataset,brand=this.data.filters.brand===value?'':value;this.setData({filters:{...this.data.filters,brand,modelId:'',modelName:''}});return this.loadUnits(true);},
 onFilterChange(e){this.setData({filters:e.detail});return this.loadUnits(true);},
 /** 面板展开时隐藏底栏；下拉面板先把筛选栏滚到吸顶位置，全屏层把层级提到搜索框之上 */
 onFilterOverlay(e){
  const {open,full}=e.detail,tabBar=this.getTabBar&&this.getTabBar();
  if(tabBar&&tabBar.setHidden)tabBar.setHidden(open);
  this.setData({filterRaised:!!full});
  if(open&&!full)wx.pageScrollTo({selector:'#filter-anchor',offsetTop:-(112*wx.getWindowInfo().windowWidth/750),duration:150});
 },
 onBrowseAll(){channel.clear();this._context='';this.setData({filters:EMPTY_FILTERS});return this.refresh();},
 onSearchTap(){this.$go(ROUTES.SEARCH);},
 onUnitSelect(e){this.$go(ROUTES.PRODUCT,{id:e.detail.id});},
 onShareAppMessage(){return{title:'夏目数码 · 让价格透明 · 让产品放心',path:ROUTES.SHOP};}
});
