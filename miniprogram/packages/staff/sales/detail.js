const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const {PERM}=require('../../../constants/roles');
const {can}=require('../../../utils/permission');
const {SALES_STATUS,SETTLEMENT_STATUS}=require('../../../constants/status');
const {confirmSensitive}=require('../../../utils/confirm');
const {ROUTES}=require('../../../utils/router');
const events=require('../../../utils/events');
const {upload}=require('../../../utils/request');
let seq=0;
createPage({
 requireStaff:true,permission:[PERM.SALES_CREATE,PERM.REFUND,PERM.STATS_VIEW],
 data:{id:'',detail:null,error:'',loading:false,saving:false,canRefund:false,editor:null,pending:null,canReceipt:false,uploading:false},
 onLoad(q){this.setData({id:q.id,statusMap:SALES_STATUS,settlementMap:SETTLEMENT_STATUS,canRefund:can(this.data.user,PERM.REFUND),canReceipt:can(this.data.user,[PERM.SALES_CREATE,PERM.REFUND])});return this.load();},
 async load(){if(this.data.saving||this.data.pending)return;this.setData({loading:true,error:''});try{this.setData({detail:await api.sales.detail(this.data.id)});}catch(e){this.setData({error:e.message});}finally{this.setData({loading:false});}},
 /** 收款凭证：签名地址有效期短，预览前重新获取 */
 async onPreviewReceipt(e){try{const url=(await api.file.detail(e.currentTarget.dataset.id)).url;wx.previewImage({current:url,urls:[url]});}catch(err){this.$toast(err.message);}},
 /** 补传收款凭证：选图上传为内部凭证，填写说明后关联本单；失败可直接重试，已关联的不会重复记录 */
 async onAddReceipts(){
  if(!this.data.canReceipt||this.data.uploading||this.data.saving||!this.data.detail)return;
  const room=Math.min(9,20-(this.data.detail.receipts||[]).length);if(room<=0)return this.$toast('每张销售单最多20张收款凭证');
  this.setData({uploading:true,error:''});
  try{
   const res=await wx.chooseMedia({count:room,mediaType:['image'],sizeType:['compressed']});
   const files=await Promise.all(res.tempFiles.map(f=>upload({filePath:f.tempFilePath,scope:'internal',bizType:'sales_receipt'})));
   const confirmation=await confirmSensitive({title:'补传收款凭证',content:'填写补传说明，将记录到操作日志',needReason:true});
   if(!confirmation.confirmed)return;
   this.setData({detail:await api.sales.addReceipts(this.data.id,{receipts:files.map(f=>({fileId:f.fileId})),reason:confirmation.reason})});
  }catch(e){if(!/cancel/.test(e.errMsg||''))this.setData({error:e.message||e.errMsg||'凭证未完成上传'});}
  finally{this.setData({uploading:false});}
 },
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
