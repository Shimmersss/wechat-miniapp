const {createPage}=require('../../../utils/page');
const api=require('../../../api/index');
const channel=require('../../../utils/channel');
const {ROUTES}=require('../../../utils/router');
const {isPhone}=require('../../../utils/validate');
let sequence=0;
createPage({
 data:{mode:'consult',agent:false,unitId:'',sourceShareId:'',unit:null,form:{content:'',phone:'',name:'',date:'',timeSlot:''},slotIndex:-1,options:null,loading:false,saving:false,error:'',pending:null,result:null},
 onLoad(query){this.setData({unitId:query.unitId||'',sourceShareId:query.unitId?channel.getHeaderValue():'',mode:['appointment','order'].includes(query.mode)?query.mode:'consult'});return this.load();},
 onUnload(){this._revision=(this._revision||0)+1;},
 async load(){const revision=this._revision=(this._revision||0)+1;this.setData({loading:true,error:''});try{const [options,unit]=await Promise.all([api.shop.contactOptions(),this.data.unitId?api.shop.unit(this.data.unitId,this.data.sourceShareId):null]);if(revision!==this._revision)return;const agent=!!unit&&unit.priceType==='agent';this.setData({options,unit,agent,...(this.data.mode==='order'&&!agent?{mode:'consult'}:{})});}catch(e){if(revision===this._revision)this.setData({error:e.message});}finally{if(revision===this._revision)this.setData({loading:false});}},
 locked(){return this.data.saving||!!this.data.pending||!!this.data.result;},
 onMode(e){if(!this.locked())this.setData({mode:e.currentTarget.dataset.value,error:''});},
 onInput(e){if(!this.locked())this.setData({['form.'+e.currentTarget.dataset.field]:e.detail.value});},
 onSlot(e){if(this.locked())return;const index=Number(e.detail.value);this.setData({slotIndex:index,'form.timeSlot':this.data.options.timeSlots[index]});},
 async onSubmit(){
 if(this.locked()||this.data.loading)return;
 const f=this.data.form,appointment=this.data.mode==='appointment',order=this.data.mode==='order';
 if(!this.data.options)return this.$toast('请先加载预约信息');if(!isPhone(f.phone))return this.$toast('请填写11位联系手机号');if(!appointment&&!order&&!f.content.trim())return this.$toast('请填写咨询内容');if(order&&!f.name.trim())return this.$toast('请填写称呼');if(appointment&&(!f.name.trim()||!f.date||!f.timeSlot))return this.$toast('请填写称呼、日期和时段');
 const body={requestKey:'contact_'+Date.now()+'_'+ ++sequence+'_'+Math.random().toString(36).slice(2),...(this.data.unitId?{unitId:this.data.unitId}:{}),content:f.content.trim(),phone:f.phone.trim(),name:f.name.trim(),...(appointment?{date:f.date,timeSlot:f.timeSlot}:{})};
 this.setData({pending:{body,mode:this.data.mode,shareId:this.data.sourceShareId}});return this.onRetry();
 },
 async onRetry(){if(this.data.saving||!this.data.pending)return;this.setData({saving:true,error:''});try{const p=this.data.pending,result=await api.shop[p.mode](p.body,p.shareId);this.setData({result,pending:null});}catch(e){if(Number(e.code)>=400&&Number(e.code)<500)this.setData({pending:null});this.setData({error:e.message||'提交未确认，请原样重试'});}finally{this.setData({saving:false});}},
 onDetail(){if(this.data.result)this.$go(ROUTES.MY_REQUEST_DETAIL,{id:this.data.result.id});},
 onBrowseShop(){channel.clear();this.$go(ROUTES.SHOP);},
 onHistory(){this.$go(ROUTES.MY_REQUESTS);}
});
