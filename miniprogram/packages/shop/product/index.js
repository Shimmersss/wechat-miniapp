const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const track = require('../../../utils/track');
const channel = require('../../../utils/channel');
const { ROUTES } = require('../../../utils/router');
const PRICE_LABEL = { retail: '零售价', wholesale: '同行价', agent: '代理分享价' };
createPage({
  data: {id:'', shareId:'', unit:null, share:null, priceLabel:'', current:0, loading:false, error:'', similar:[]},
  onLoad(query) {
    channel.captureFromLaunch({query});
    this.setData({id:query.id||'',shareId:query.s||channel.getHeaderValue()});
    return this.load();
  },
  onShow(){if(this.data.unit&&!this.data.loading)return this.load();},
  trackExtra(){return this.data.id?{unitId:this.data.id}:{};},
  async load(){
    const revision=this._revision=(this._revision||0)+1;
    this.setData({loading:true,error:'',unit:null,share:null,similar:[]});
    try{
      let unit,share=null;
      if(this.data.shareId){share=await api.share.resolve(this.data.shareId);unit=this.data.id?share.units.find(u=>u.id===this.data.id):share.units.length===1?share.units[0]:null;if(!unit)throw new Error('请从分享合集选择设备');}
      else {if(!this.data.id)throw new Error('缺少设备编号');unit=await api.shop.unit(this.data.id);}
      if(revision!==this._revision)return;
      this.setData({unit,id:unit.id,priceLabel:PRICE_LABEL[unit.priceType]||'',share});
      wx.setNavigationBarTitle({title:unit.name});
      if(!share)this.loadSimilar(unit,revision);
    }catch(e){if(revision===this._revision)this.setData({error:e.message||'商品加载失败'});}
    finally{if(revision===this._revision)this.setData({loading:false});}
  },
  /** 相似在售：同型号优先，不足再补同品牌；分享进入时只看分享内设备，不推荐 */
  async loadSimilar(unit,revision){
    const MAX=4,picked=[],add=list=>list.forEach(u=>{if(u.id!==unit.id&&picked.length<MAX&&!picked.some(p=>p.id===u.id))picked.push(u);});
    try{
      if(unit.modelId)add((await api.shop.units({modelId:unit.modelId,page:1,pageSize:MAX+1})).list);
      if(picked.length<MAX&&unit.brand)add((await api.shop.units({brand:unit.brand,page:1,pageSize:MAX*2})).list);
    }catch(e){return;}
    if(revision===this._revision)this.setData({similar:picked});
  },
  onSimilarSelect(e){this.$go(ROUTES.PRODUCT,{id:e.detail.id});},
  onUnload(){this._revision=(this._revision||0)+1;},
  onSwiperChange(e){this.setData({current:e.detail.current});},
  onPreview(e){wx.previewImage({urls:this.data.unit.images,current:e.currentTarget.dataset.src});},
  onConsult(){if(!this.data.unit)return;track.event('consult_click',{unitId:this.data.id});this.$go(ROUTES.CONSULT,{unitId:this.data.id});},
  onAppointment(){if(this.data.unit)this.$go(ROUTES.CONSULT,{unitId:this.data.id,mode:'appointment'});},
  /** 代理链接：下单短时锁库，门店确认成交（框架文档 7.3） */
  onOrder(){if(this.data.unit&&this.data.unit.priceType==='agent'){track.event('agent_order_click',{unitId:this.data.id});this.$go(ROUTES.CONSULT,{unitId:this.data.id,mode:'order'});}},
  onPoster(){if(this.data.unit)this.$go(ROUTES.POSTER,this.data.share?{s:this.data.share.shareId}:{unitId:this.data.id,channel:this.data.unit.priceType==='wholesale'?'peer':'customer'});},
  onBrowseShop(){channel.clear();this.$go(ROUTES.SHOP);},
  onShareAppMessage(){
    if(!this.data.unit)return{title:'夏目数码',path:ROUTES.SHOP};
    const existing=this.data.share;
    const promise=(existing?api.share.resolve(existing.shareId):api.share.createLink({unitId:this.data.id,channel:this.data.unit.priceType==='wholesale'?'peer':'customer'})).then(s=>({title:s.title,path:s.path,imageUrl:s.imageUrl}));
    track.event('share',{unitId:this.data.id});
    return{title:'夏目数码',path:ROUTES.SHOP,promise};
  }
});
