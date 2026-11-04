const {createPage}=require('../../../utils/page'),api=require('../../../api/index');
const {ROUTES}=require('../../../utils/router'),{PERM}=require('../../../constants/roles'),{SALES_STATUS}=require('../../../constants/status');
createPage({
 requireStaff:true,permission:[PERM.SALES_CREATE,PERM.REFUND,PERM.STATS_VIEW],
 data:{list:[],page:1,hasMore:true,loading:false,error:'',keyword:'',from:'',to:'',activeFilter:'',filters:[{value:'',label:'全部'},{value:'paid',label:'已收款'},{value:'partially_refunded',label:'部分退款'},{value:'refunded',label:'已退货'}],sellers:[{id:'',name:'全部销售员'}],sellerIndex:0},
 onLoad(){this.setData({statusMap:SALES_STATUS});this.loadSellers();return this.load(true);},
 loadSellers(){return api.sales.sellers().then(list=>this.setData({sellers:[{id:'',name:'全部销售员'}].concat(list)})).catch(()=>null);},
 onSellerChange(e){this.setData({sellerIndex:Number(e.detail.value)});return this.load(true);},
 onShow(){if(this.loaded)this.load(true);},
 onPullDownRefresh(){this.load(true).finally(()=>wx.stopPullDownRefresh());},
 onReachBottom(){if(this.data.hasMore&&!this.data.loading)this.load(false);},
 onInput(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
 onSearch(){if((this.data.from&&!this.data.to)||(!this.data.from&&this.data.to))return this.$toast('请选择完整起止日期');if(this.data.from>this.data.to)return this.$toast('开始日期不能晚于结束日期');return this.load(true);},
 onClear(){this.setData({from:'',to:'',keyword:'',activeFilter:'',sellerIndex:0});return this.load(true);},
 async load(reset){const revision=this.revision=(this.revision||0)+1,page=reset?1:this.data.page+1;this.setData({loading:true,error:''});try{const res=await api.sales.list({page,pageSize:20,status:this.data.activeFilter,keyword:this.data.keyword,from:this.data.from,to:this.data.to,sellerId:this.data.sellers[this.data.sellerIndex].id});if(revision!==this.revision)return;const list=reset?res.list:this.data.list.concat(res.list);this.setData({list,page,hasMore:list.length<res.total});this.loaded=true;}catch(e){if(revision===this.revision)this.setData({error:e.message});}finally{if(revision===this.revision)this.setData({loading:false});}},
 onFilterTap(e){this.setData({activeFilter:e.currentTarget.dataset.value});return this.load(true);},
 onItemTap(e){this.$go(ROUTES.SALES_DETAIL,{id:e.currentTarget.dataset.id});}
});
