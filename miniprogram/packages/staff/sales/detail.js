const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const {PERM}=require('../../../constants/roles');
const {can}=require('../../../utils/permission');
const {SALES_STATUS}=require('../../../constants/status');
const {confirmSensitive}=require('../../../utils/confirm');
const {ROUTES}=require('../../../utils/router');
const events=require('../../../utils/events');
let seq=0;
createPage({
 requireStaff:true,permission:[PERM.SALES_CREATE,PERM.REFUND,PERM.STATS_VIEW],
 data:{id:'',detail:null,error:'',loading:false,saving:false,canRefund:false,editor:null,pending:null,todos:['收款凭证 / 发票','代理订单归因信息（随代理业务接入）']},
 onLoad(q){this.setData({id:q.id,statusMap:SALES_STATUS,canRefund:can(this.data.user,PERM.REFUND)});return this.load();},
 async load(){if(this.data.saving||this.data.pending)return;this.setData({loading:true,error:''});try{this.setData({detail:await api.sales.detail(this.data.id)});}catch(e){this.setData({error:e.message});}finally{this.setData({loading:false});}},
 onPullDownRefresh(){if(this.data.editor||this.data.pending||this.data.saving){wx.stopPullDownRefresh();return;}this.load().finally(()=>wx.stopPullDownRefresh());},
 onRefund(){if(!this.data.canRefund||this.data.saving||this.data.pending)return;this.setData({editor:{kind:'return',items:this.data.detail.items.filter(i=>i.returnable).map(i=>({...i,selected:false,amount:''}))}});},
 onKind(e){if(!this.data.saving&&!this.data.pending)this.setData({'editor.kind':e.currentTarget.dataset.value});},
 onItem(e){if(this.data.saving||this.data.pending)return;const i=this.data.editor.items.findIndex(i=>i.id===e.currentTarget.dataset.id);if(i>=0)this.setData({['editor.items['+i+'].selected']:e.detail.value});},
 onAmount(e){if(this.data.saving||this.data.pending)return;const i=this.data.editor.items.findIndex(i=>i.id===e.currentTarget.dataset.id);if(i>=0)this.setData({['editor.items['+i+'].amount']:e.detail.value});},
 onClose(){if(!this.data.saving&&!this.data.pending)this.setData({editor:null});},
 async onSubmitRefund(){
  if(this.data.saving||this.data.pending||!this.data.editor)return;
  const selected=this.data.editor.items.filter(i=>i.selected),kind=this.data.editor.kind;
  if(!selected.length)return this.$toast('请选择退款设备');
  if(selected.some(i=>(kind==='adjustment'||i.amount!=='')&&!/^\d+(\.\d{1,2})?$/.test(String(i.amount))))return this.$toast('请填写有效退款金额，最多两位小数');
  this.setData({saving:true,error:''});
  try{const confirmation=await confirmSensitive({title:kind==='return'?'确认已办理退货退款':'确认已办理差价退款',content:kind==='return'?'填写退款原因。退货设备将进入复检，不能直接销售。':'填写差价退款原因。设备保持已售状态。',needReason:true});if(!confirmation.confirmed)return;
   this.setData({pending:{requestKey:'refund_'+Date.now()+'_'+ ++seq+'_'+Math.random().toString(36).slice(2),kind,reason:confirmation.reason,items:selected.map(i=>({itemId:i.id,...(i.amount!==''?{amount:i.amount}:{})}))}});await this.send();
  }catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}
 },
 async send(){try{const detail=await api.sales.refund(this.data.id,JSON.parse(JSON.stringify(this.data.pending)));this.setData({detail,pending:null,editor:null});events.emit('inventory:changed',{saleId:detail.id});}catch(e){if(Number(e.code)>=400&&Number(e.code)<500)this.setData({pending:null});throw e;}},
 async onRetry(){if(this.data.saving||!this.data.pending)return;this.setData({saving:true,error:''});try{await this.send();}catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}},
 onUnit(e){this.$go(ROUTES.INVENTORY_DETAIL,{id:e.currentTarget.dataset.id});}
});
