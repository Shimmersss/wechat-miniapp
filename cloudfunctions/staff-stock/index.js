const { createHandler, rpc, fail } = require('./shared/gateway');
const { requireUser } = require('./shared/identity');
const { PERM } = require('./shared/roles');
const { prepare, money, text } = require('./input');
const { view, canSee } = require('./view');
const { resolveFiles } = require('./files');
// 每个内层数组表示一组可替代权限；外层数组中的每组都必须满足。
const readModels=[PERM.TEMPLATE_MANAGE,PERM.INBOUND,PERM.PURCHASE_MANAGE,PERM.ACCEPTANCE,PERM.INVENTORY_VIEW];
const readTemplate=readModels.filter(p=>p!==PERM.INVENTORY_VIEW);
const inv=[PERM.INVENTORY_VIEW], count=[PERM.STOCKTAKE,PERM.INVENTORY_VIEW];
const routes=[];
function add(method,path,action,permissions) {
  routes.push([method,path,async ctx=>{
    const user=await requireUser(ctx);
    if(!user.staffNo)fail(403,'仅员工可执行该操作');
    for(const group of permissions.map(x=>Array.isArray(x)?x:[x])) if(!group.some(p=>user.permissions.includes(p)))fail(403,'无权限执行该操作');
    if(action.startsWith('suppliers.')||action==='purchase.create'||action==='purchase.update'||(action==='purchase.list'&&ctx.data.supplierId)) {
      if(!user.permissions.includes(PERM.SUPPLIER_VIEW)||!canSee(user,'supplier'))fail(403,'无权限查看供应商');
    }
    const {d,p}=prepare(action,ctx.data,ctx.params,user);
    if(action==='pricing.suggest') {
      const cents=v=>{const [w,f='']=money(v).split('.');return BigInt(w)*100n+BigInt(f.padEnd(2,'0'));};
      const total=cents(d.cost)+cents(d.targetProfit??0);
      if(total>99999999999999n)fail(400,'金额合计超出允许范围');
      const discount=cents(process.env.WHOLESALE_DISCOUNT||"0");
      const peer=total-discount<cents(d.cost)?cents(d.cost):total-discount;
      return {retail:Number(total)/100,wholesale:Number(peer)/100,agentBase:Number(peer)/100};
    }
    const result=await rpc('api_stock',{p_action:action,p_params:p,p_data:d,p_user:user,p_request_id:ctx.requestId});
    await resolveFiles(result,user);
    return view(action,result,p,user);
  }]);
}
add('GET','/catalog/categories','categories.list',[readModels]);
add('POST','/catalog/categories','categories.create',[PERM.TEMPLATE_MANAGE]);
add('PUT','/catalog/categories/:id','categories.update',[PERM.TEMPLATE_MANAGE]);
add('GET','/models/tree','models.list',[readModels]);
add('GET','/models/:id/form','models.form',[readTemplate]);
add('POST','/models','models.create',[PERM.TEMPLATE_MANAGE]);
add('PUT','/models/:id','models.update',[PERM.TEMPLATE_MANAGE]);
add('GET','/templates','templates.list',[PERM.TEMPLATE_MANAGE]);
add('GET','/templates/:id/versions','templates.versions',[PERM.TEMPLATE_MANAGE]);
add('POST','/templates/:id/versions','templates.publish',[PERM.TEMPLATE_MANAGE]);
add('GET','/templates/:id','templates.get',[readTemplate]);
add('GET','/suppliers','suppliers.list',[PERM.SUPPLIER_VIEW]);
add('POST','/suppliers','suppliers.create',[PERM.PURCHASE_MANAGE,PERM.SUPPLIER_VIEW]);
add('PUT','/suppliers/:id','suppliers.update',[PERM.PURCHASE_MANAGE,PERM.SUPPLIER_VIEW]);
add('GET','/purchase-orders','purchase.list',[[PERM.PURCHASE_MANAGE,PERM.ACCEPTANCE]]);
add('POST','/purchase-orders','purchase.create',[PERM.PURCHASE_MANAGE,PERM.SUPPLIER_VIEW]);
add('PUT','/purchase-orders/:id','purchase.update',[PERM.PURCHASE_MANAGE,PERM.SUPPLIER_VIEW]);
add('GET','/purchase-orders/:id','purchase.get',[[PERM.PURCHASE_MANAGE,PERM.ACCEPTANCE]]);
add('POST','/purchase-orders/:id/shipments','purchase.shipment',[PERM.PURCHASE_MANAGE]);
add('GET','/purchase-orders/:id/acceptance','purchase.acceptance',[PERM.ACCEPTANCE]);
add('POST','/purchase-orders/:id/acceptance','acceptance.submit',[PERM.ACCEPTANCE]);
add('POST','/shipments/:id/receive','shipment.receive',[[PERM.PURCHASE_MANAGE,PERM.ACCEPTANCE]]);
add('GET','/shipments/:id/tracks','shipment.tracks',[[PERM.PURCHASE_MANAGE,PERM.ACCEPTANCE]]);
add('POST','/acceptances/:id/resolve','acceptance.resolve',[PERM.ACCEPTANCE]);
add('POST','/inbound/identify-model','models.identify',[PERM.INBOUND]);
add('POST','/inbound/check-imei','inbound.check',[[PERM.INBOUND,PERM.ACCEPTANCE]]);
add('POST','/inbound/units','inbound.single',[PERM.INBOUND,PERM.ACCEPTANCE]);
add('POST','/inbound/batch','inbound.batch',[PERM.INBOUND,PERM.ACCEPTANCE]);
add('POST','/pricing/suggest','pricing.suggest',[PERM.INBOUND]);
add('GET','/pricing/cost-presets','pricing.presets',[PERM.INBOUND]);
add('GET','/units','units.list',inv);
add('PATCH','/units/share-flags','units.flags.batch',[PERM.SHARE,...inv]);
add('GET','/units/:id','units.get',inv);
add('PATCH','/units/:id/price','units.price',[PERM.PRICE_EDIT,...inv]);
add('PATCH','/units/:id/share-flags','units.flags',[PERM.SHARE,...inv]);
add('GET','/units/:id/ledger','units.ledger',inv);
add('GET','/units/:id/label','units.label',[PERM.LABEL_PRINT,...inv]);
add('GET','/units/:id/recheck-form','units.recheckForm',[PERM.ACCEPTANCE,...inv]);
add('POST','/units/:id/recheck','units.recheck',[PERM.ACCEPTANCE,...inv]);
add('GET','/stocktakes','records.list',count);
add('GET','/stocktakes/:id','records.get',count);
add('POST','/stocktakes/:id/resolutions','records.resolve',count);
add('GET','/stocktake-sessions','sessions.list',count);
add('POST','/stocktake-sessions','sessions.create',count);
add('GET','/stocktake-sessions/:id','sessions.get',count);
add('GET','/stocktake-sessions/:id/units','sessions.units',count);
add('POST','/stocktake-sessions/:id/scans','sessions.scan',count);
add('POST','/stocktake-sessions/:id/close','sessions.close',count);
add('POST','/stocktake-sessions/:id/cancel','sessions.cancel',count);
add('GET','/sales/lookup','sales.lookup',[PERM.SALES_CREATE]);
add('POST','/sales/quote','sales.quote',[PERM.SALES_CREATE]);
add('POST','/sales-orders','sales.create',[PERM.SALES_CREATE]);
exports.main=createHandler(routes);
