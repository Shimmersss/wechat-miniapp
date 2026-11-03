const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');
const { UNIT_STATUS } = require('../../../constants/status');
const { scan, unitCode } = require('../../../utils/scan');
const events = require('../../../utils/events');
let sequence = 0;
createPage({
 requireStaff:true, permission:PERM.STOCKTAKE,
 data:{ codes:[], input:'', statuses:['in_stock','locked','repairing','recheck'], choices:Object.keys(UNIT_STATUS).map(value=>({value,label:UNIT_STATUS[value].label,checked:['in_stock','locked','repairing','recheck'].includes(value)})), model:null, result:null, pending:null, saving:false, error:'', history:[], historyPage:0, historyMore:true, historyLoading:false },
 onLoad(query){this.setData({statusMap:UNIT_STATUS,model:query.modelId?{id:query.modelId,name:decodeURIComponent(query.modelName||'所选型号')}:null});this.offModel=events.on('stocktake:model-selected',m=>{const p=getCurrentPages();if(p[p.length-2]===this&&!this.locked())this.setData({model:m});});return this.loadHistory(true);},
 onUnload(){if(this.offModel)this.offModel();},
 locked(){return this.data.saving||!!this.data.pending||!!this.data.result;},
 onInput(e){if(!this.locked())this.setData({input:e.detail.value});},
 onAdd(){if(this.locked())return;const code=unitCode(this.data.input);if(!code||code.length>80)return this.$toast('请输入有效设备编号或串码');if(this.data.codes.includes(code))return this.$toast('已经扫描');if(this.data.codes.length>=1000)return this.$toast('每次最多1000个编号');this.setData({codes:this.data.codes.concat(code),input:''});},
 async onScan(){if(this.locked())return;try{this.setData({input:unitCode(await scan())});this.onAdd();}catch(_){}},
 onRemove(e){if(!this.locked())this.setData({codes:this.data.codes.filter(c=>c!==e.currentTarget.dataset.code)});},
 onStatuses(e){if(!this.locked())this.setData({statuses:e.detail.value,choices:this.data.choices.map(c=>({...c,checked:e.detail.value.includes(c.value)}))});},
 onChooseModel(){if(!this.locked())this.$go(ROUTES.TEMPLATES,{select:'1',from:'stocktake'});},
 onClearModel(){if(!this.locked())this.setData({model:null});},
 async onSubmit(){if(this.locked())return;if(!this.data.codes.length||!this.data.statuses.length)return this.$toast('请添加设备并选择盘点状态范围');const pending={requestKey:'stocktake_'+Date.now()+'_'+ ++sequence+'_'+Math.random().toString(36).slice(2),scannedImeis:this.data.codes.slice(),statuses:this.data.statuses.slice()};if(this.data.model)pending.modelId=this.data.model.id;this.setData({pending});return this.send();},
 async send(){if(this.data.saving||!this.data.pending)return;this.setData({saving:true,error:''});try{const result=await api.inventory.stocktake(this.data.pending);this.setData({result,pending:null});await this.loadHistory(true);}catch(e){this.setData({error:e.message});if(Number(e.code)>=400&&Number(e.code)<500)this.setData({pending:null});}finally{this.setData({saving:false});}},
 onNew(){if(!this.data.saving&&!this.data.pending)this.setData({result:null,codes:[],error:''});},
 async loadHistory(reset){if(this.data.historyLoading)return;this.setData({historyLoading:true});const page=reset?1:this.data.historyPage+1;try{const res=await api.inventory.stocktakes({page,pageSize:20});const history=reset?res.list:this.data.history.concat(res.list);this.setData({history,historyPage:page,historyMore:history.length<res.total});}catch(e){this.setData({error:e.message});}finally{this.setData({historyLoading:false});}},
 onMore(){return this.loadHistory(false);},
 async onRecord(e){if(this.data.saving||this.data.pending)return;this.setData({saving:true,error:''});try{this.setData({result:await api.inventory.stocktakeDetail(e.currentTarget.dataset.id)});}catch(err){this.setData({error:err.message});}finally{this.setData({saving:false});}},
 onUnit(e){this.$go(ROUTES.INVENTORY_DETAIL,{id:e.currentTarget.dataset.id});}
});
