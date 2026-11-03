const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const {scan,unitCode}=require('../../../utils/scan');
const {PERM}=require('../../../constants/roles');
const {can}=require('../../../utils/permission');
const {ROUTES}=require('../../../utils/router');
const {confirmSensitive}=require('../../../utils/confirm');
const events=require('../../../utils/events');
let seq=0;
createPage({
 requireStaff:true,permission:PERM.SALES_CREATE,
 data:{cart:[],total:null,quote:null,quoting:false,loading:false,saving:false,error:'',code:'',payMethods:['微信','支付宝','现金','银行卡','分期'],payIndex:0,customer:'',phone:'',remark:'',canPrice:false,pending:null,order:null,customerRequestId:'',referral:null},
 onLoad(query){this.setData({canPrice:can(this.data.user,PERM.PRICE_EDIT)});this.offPicked=events.on('pos:units-selected',ids=>this.addUnits(ids));if(query.customerRequestId)return this.loadReferral(query.customerRequestId);if(query.unitIds){let ids=String(query.unitIds);try{ids=decodeURIComponent(ids);}catch(_){}return this.addUnits(ids.split(','));}if(query.scan==='1')return this.onScan();if(query.unitId){this.setData({code:query.unitId});return this.onAdd();}},
 async loadReferral(id){this.setData({loading:true,error:'',customerRequestId:id});try{const referral=await api.customerRequest.detail(id);if(!referral.canStartSale)throw new Error('此意向暂不能开单，请回顾客跟进核对');this.setData({referral,customer:referral.name,phone:referral.phone,code:referral.unitId,loading:false});if(referral.kind==='order'){const u=await api.sales.lookup(referral.unitId,id);this.setData({cart:[{...u,channel:'agent',price:'',agentPrice:referral.agentOrder.sharePrice}],code:''});return this.requote();}await this.onAdd();}catch(e){this.setData({error:e.message});}finally{this.setData({loading:false});}},
 onUnload(){this.destroyed=true;this.revision=(this.revision||0)+1;if(this.offPicked)this.offPicked();},
 /** 手动出库：从库存列表多选在库设备后加入收银单；逐台按服务端当前状态与价格核验 */
 onPick(){if(!this.locked())this.$go(ROUTES.INVENTORY,{pick:'pos'});},
 async addUnits(ids){
  if(this.locked())return;const codes=[...new Set((ids||[]).map(s=>String(s).trim()).filter(Boolean))];if(!codes.length)return;this.setData({loading:true,error:''});
  const added=[],failed=[];for(const code of codes){if(this.data.cart.some(i=>i.id===code))continue;try{const u=await api.sales.lookup(code);if(!this.data.cart.some(i=>i.id===u.id)&&!added.some(i=>i.id===u.id))added.push({...u,channel:'retail',price:''});}catch(e){failed.push(code+'：'+e.message);}}
  if(this.destroyed)return;this.setData({cart:this.data.cart.concat(added),loading:false,error:failed.join('；')});if(added.length)await this.requote();
 },
 locked(){return this.data.saving||this.data.loading||!!this.data.pending||!!this.data.order;},
 onInput(e){if(!this.locked())this.setData({[e.currentTarget.dataset.field]:e.detail.value});},
 async onScan(){if(this.locked())return;try{this.setData({code:unitCode(await scan())});return this.onAdd();}catch(_){}},
 async onAdd(){
  if(this.locked())return;const code=this.data.code.trim();if(!code)return this.$toast('请扫码或输入完整设备编号');this.setData({loading:true,error:''});
  try{const u=await api.sales.lookup(code);if(this.data.cart.some(i=>i.id===u.id))return this.$toast('已在收银单中');this.setData({cart:this.data.cart.concat({...u,channel:'retail',price:''}),code:''});await this.requote();}
  catch(e){this.setData({error:e.message});}finally{this.setData({loading:false});}
 },
 items(){return this.data.cart.map(u=>({unitId:u.id,priceVersion:u.priceVersion,channel:u.channel,...(u.price!==''?{price:u.price}:{})}));},
 async requote(){
  const revision=this.revision=(this.revision||0)+1;this.setData({quote:null,total:null,quoting:false,error:''});if(!this.data.cart.length)return;
  this.setData({quoting:true});try{const quote=await api.sales.quote({items:this.items(),...(this.data.customerRequestId?{customerRequestId:this.data.customerRequestId}:{})});if(this.destroyed||revision!==this.revision)return;this.setData({quote,total:quote.total});}
  catch(e){if(revision===this.revision)this.setData({error:e.message});}finally{if(revision===this.revision)this.setData({quoting:false});}
 },
 onRemove(e){if(this.locked())return;this.setData({cart:this.data.cart.filter(u=>u.id!==e.currentTarget.dataset.id)});return this.requote();},
 onPayChange(e){if(!this.locked())this.setData({payIndex:Number(e.detail.value)});},
 onPrice(e){if(this.locked()||!this.data.canPrice)return;const i=this.data.cart.findIndex(u=>u.id===e.currentTarget.dataset.id);if(i<0)return;this.revision=(this.revision||0)+1;this.setData({['cart['+i+'].price']:e.detail.value,quote:null,total:null,quoting:false});},
 onChannel(e){if(this.locked())return;const i=this.data.cart.findIndex(u=>u.id===e.currentTarget.dataset.id);if(i<0)return;const channel=e.detail.value?'wholesale':'retail';this.setData({['cart['+i+'].channel']:channel,['cart['+i+'].price']:''});return this.requote();},
 onQuote(){if(!this.locked())return this.requote();},
 async onRefresh(){
  if(this.locked()||!this.data.cart.length)return;
  this.setData({loading:true,error:''});try{const cart=await Promise.all(this.data.cart.map(async u=>({...await api.sales.lookup(u.id,u.channel==='agent'?this.data.customerRequestId:undefined),channel:u.channel,price:'',agentPrice:u.agentPrice})));this.setData({cart});await this.requote();}catch(e){this.setData({quote:null,total:null,error:e.message});}finally{this.setData({loading:false});}
 },
 async onCheckout(){
  if(this.locked()||this.data.quoting)return;
  if(!this.data.quote||!this.data.cart.length)return this.$toast('请先获取有效报价');
  this.setData({saving:true,error:''});
  try{
   const changed=this.data.quote.items.some(i=>i.price!==i.basePrice);
   const confirmation=await confirmSensitive({title:changed?'确认成交改价与收款':'确认已经收款',content:changed?'填写成交改价原因，确认实际收款后再保存':'请确认已实际收到 ¥'+this.data.quote.total+'，保存后将扣除库存。',needReason:changed});
   if(!confirmation.confirmed)return;
   const pending={requestKey:'sale_'+Date.now()+'_'+ ++seq+'_'+Math.random().toString(36).slice(2),items:this.items(),payMethod:this.data.payMethods[this.data.payIndex],paymentConfirmed:true,customer:this.data.customer,phone:this.data.phone,remark:this.data.remark,...(this.data.customerRequestId?{customerRequestId:this.data.customerRequestId}:{}),...(changed?{priceReason:confirmation.reason}:{})};
   this.setData({pending});await this.send();
  }catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}
 },
 async send(){
  const pending=this.data.pending;if(!pending)return;
  try{const order=await api.sales.create(JSON.parse(JSON.stringify(pending)));this.setData({order,pending:null,cart:[],quote:null,total:null});events.emit('inventory:changed',{saleId:order.id});}
  catch(e){if(Number(e.code)>=400&&Number(e.code)<500)this.setData({pending:null,quote:null,total:null});throw e;}
 },
 async onRetry(){if(this.data.saving||!this.data.pending)return;this.setData({saving:true,error:''});try{await this.send();}catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}},
 onOrder(){if(this.data.order)this.$go(ROUTES.SALES_DETAIL,{id:this.data.order.id});},
 onNew(){if(!this.data.saving&&!this.data.pending)this.setData({order:null,customer:'',phone:'',remark:'',error:'',customerRequestId:'',referral:null});}
});
