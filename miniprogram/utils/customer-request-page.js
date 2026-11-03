const api=require('../api/index');
const {PERM}=require('../constants/roles');
const {LABELS,TRANSITIONS}=require('../constants/customer-requests');
const {ROUTES}=require('./router');
const {confirmSensitive}=require('./confirm');
let sequence=0;
const key=()=> 'follow_'+Date.now()+'_'+ ++sequence+'_'+Math.random().toString(36).slice(2);
const sources={natural:'自然访问',customer:'顾客分享',peer:'同行分享',agent:'代理分享'};
function timeLabel(value){const at=Date.parse(value);return Number.isFinite(at)?new Date(at+28800000).toISOString().slice(0,16).replace('T',' '):'--';}
function display(record){return{...record,...(record.agentOrder?{agentOrder:{...record.agentOrder,lockText:timeLabel(record.agentOrder.lockExpiresAt)}}:{}),createdLabel:timeLabel(record.createdAt),timeline:(record.timeline||[]).map(e=>({...e,timeLabel:timeLabel(e.time)}))};}
const staffApi=()=>api.customerRequest;
const methods=internal=>internal?{list:staffApi().list,detail:staffApi().detail,change:staffApi().updateStatus}:{list:api.shop.requests,detail:api.shop.request,change:api.shop.cancelRequest};
const guard=internal=>internal?{requireStaff:true,permission:PERM.CONSULT_MANAGE}:{};
function listPage(internal){return{
 ...guard(internal),data:{internal,sources,labels:LABELS,kinds:[{value:'',label:'全部'},{value:'consult',label:'咨询'},{value:'appointment',label:'预约'},{value:'order',label:'代理下单'}],statuses:[{value:'',label:'全部状态'},...Object.keys(LABELS).map(value=>({value,label:LABELS[value]}))],kind:'',status:'',statusIndex:0,keyword:'',list:[],page:0,more:false,loading:false,error:''},
 onLoad(query){const status=query.status||'';this.setData({status,statusIndex:Math.max(0,this.data.statuses.findIndex(s=>s.value===status))});return this.load(true);},
 onShow(){if(this._loaded&&!this.data.loading)return this.load(true);},
 onUnload(){this._revision=(this._revision||0)+1;},
 onPullDownRefresh(){return this.load(true).finally(()=>wx.stopPullDownRefresh());},
 onReachBottom(){if(this.data.more)return this.load(false);},
 onKind(e){this.setData({kind:e.currentTarget.dataset.value});return this.load(true);},
 onStatus(e){const index=Number(e.detail.value);this.setData({statusIndex:index,status:this.data.statuses[index].value});return this.load(true);},
 onKeyword(e){this.setData({keyword:e.detail.value});},
 onSearch(){return this.load(true);},
 async load(reset=true){if(this.data.loading&&!reset)return;const revision=this._revision=(this._revision||0)+1,page=reset?1:this.data.page+1;this.setData({loading:true,error:'',...(reset?{list:[]}:{} )});try{const r=await methods(internal).list({kind:this.data.kind,status:this.data.status,...(internal?{keyword:this.data.keyword.trim()}:{}),page,pageSize:20});if(revision!==this._revision)return;const list=reset?r.list.map(display):this.data.list.concat(r.list.map(display));this.setData({list,page,more:list.length<r.total});this._loaded=true;}catch(e){if(revision===this._revision)this.setData({error:e.message});}finally{if(revision===this._revision)this.setData({loading:false});}},
 onSelect(e){this.$go(internal?ROUTES.CUSTOMER_REQUEST_DETAIL:ROUTES.MY_REQUEST_DETAIL,{id:e.currentTarget.dataset.id});},
 onNew(){this.$go(ROUTES.CONSULT);}
};}
function detailPage(internal){return{
 ...guard(internal),data:{internal,sources,labels:LABELS,id:'',detail:null,actions:[],actionIndex:0,loading:false,saving:false,error:'',pending:null},
 onLoad(query){this.setData({id:query.id||''});return this.load();},
 onShow(){if(this._loaded&&!this.data.loading&&!this.data.saving&&!this.data.pending)return this.load();},
 onUnload(){this._revision=(this._revision||0)+1;},
 async load(){if(this.data.pending)return;const revision=this._revision=(this._revision||0)+1;this.setData({loading:true,error:''});try{if(!this.data.id)throw new Error('缺少记录编号');const detail=display(await methods(internal).detail(this.data.id));if(revision!==this._revision)return;this.setData({detail,actions:(detail.actions||[]).map(value=>({value,label:LABELS[value]})),actionIndex:0});this._loaded=true;}catch(e){if(revision===this._revision)this.setData({error:e.message,detail:null});}finally{if(revision===this._revision)this.setData({loading:false});}},
 onAction(e){if(!this.data.saving&&!this.data.pending)this.setData({actionIndex:Number(e.detail.value)});},
 async onChange(){if(this.data.saving||this.data.pending||!this.data.detail)return;if(internal&&!this.data.actions.length)return;this.setData({saving:true,error:''});try{const status=internal?this.data.actions[this.data.actionIndex].value:'cancelled',c=await confirmSensitive({title:internal?'确认'+LABELS[status]:'取消本次意向',content:internal?'处理说明仅供员工内部跟进。':'取消后将保留本次记录。',needReason:true});if(!c.confirmed)return;this.setData({pending:{requestKey:key(),version:this.data.detail.version,...(internal?{status}:{}),reason:c.reason}});await this.send();}catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}},
 async send(){try{await methods(internal).change(this.data.id,this.data.pending);this.setData({pending:null});await this.load();}catch(e){if(Number(e.code)>=400&&Number(e.code)<500)this.setData({pending:null});throw e;}},
 async onRetry(){if(this.data.saving||!this.data.pending)return;this.setData({saving:true,error:''});try{await this.send();}catch(e){this.setData({error:e.message});}finally{this.setData({saving:false});}},
 onSale(){if(this.data.detail?.canStartSale&&!this.data.pending&&!this.data.saving)this.$go(ROUTES.POS,{customerRequestId:this.data.id});},
 onOrder(){if(this.data.detail?.salesOrderId)this.$go(ROUTES.SALES_DETAIL,{id:this.data.detail.salesOrderId});}
};}
module.exports={listPage,detailPage};
