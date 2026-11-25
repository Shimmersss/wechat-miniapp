const moduleStarted = process.hrtime.bigint();
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
    if(action==='units.void' && user.role!=='boss')fail(403,'仅老板账号可以删除库存设备');
    for(const group of permissions.map(x=>Array.isArray(x)?x:[x])) if(!group.some(p=>user.permissions.includes(p)))fail(403,'无权限执行该操作');
    if(action.startsWith('suppliers.')||action==='purchase.create'||action==='purchase.update'||(action==='purchase.list'&&ctx.data.supplierId)) {
      if(!user.permissions.includes(PERM.SUPPLIER_VIEW)||!canSee(user,'supplier'))fail(403,'无权限查看供应商');
    }
    const {d,p}=prepare(action,ctx.data,ctx.params,user);
    if (action === 'models.identify') return rpc('api_imei_model_lookup', { p_imei: d.imei });
    if (action === 'units.editForm' || action === 'units.edit') {
      return rpc('api_stock_unit_edit', { p_id: p.id, p_data: action === 'units.edit' ? d : null, p_user: user, p_request_id: ctx.requestId });
    }
    if (action === 'units.restock') {
      return rpc('api_stock_restock',{p_id:p.id,p_data:d,p_user:user,p_request_id:ctx.requestId});
    }
    if(action==='pricing.suggest') {
      return require('./shared/pricing-suggest').suggest(d, process.env.WHOLESALE_DISCOUNT || '0');
    }
    const result=await rpc('api_stock',{p_action:action,p_params:p,p_data:d,p_user:user,p_request_id:ctx.requestId});
    await resolveFiles(result,user);
    return view(action,result,p,user);
  }]);
}
add('GET','/catalog/categories','categories.list',[readModels]);
add('POST','/catalog/categories','categories.create',[PERM.TEMPLATE_MANAGE]);
add('PUT','/catalog/categories/:id','categories.update',[PERM.TEMPLATE_MANAGE]);
add('GET','/models/brands','models.brands',[readModels]);
add('GET','/models/series','models.series',[PERM.TEMPLATE_MANAGE]);
add('GET','/models/tree','models.list',[readModels]);
add('GET','/models/:id/form','models.form',[readTemplate]);
add('POST','/models','models.create',[PERM.TEMPLATE_MANAGE]);
add('PUT','/models/:id','models.update',[PERM.TEMPLATE_MANAGE]);
add('DELETE','/models/:id','models.delete',[PERM.TEMPLATE_MANAGE]);
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
add('POST','/inbound/check-serial','inbound.checkSerial',[[PERM.INBOUND,PERM.ACCEPTANCE]]);
add('POST','/inbound/units','inbound.single',[PERM.INBOUND,PERM.ACCEPTANCE]);
add('POST','/inbound/batch','inbound.batch',[PERM.INBOUND,PERM.ACCEPTANCE]);
add('POST','/pricing/suggest','pricing.suggest',[PERM.INBOUND]);
add('GET','/pricing/cost-presets','pricing.presets',[PERM.INBOUND]);
add('GET','/units','units.list',inv);
add('PATCH','/units/share-flags','units.flags.batch',[PERM.SHARE,...inv]);
add('GET','/units/:id','units.get',inv);
add('DELETE','/units/:id','units.void',inv);
const editUnit = [...inv, [PERM.INBOUND, PERM.PRICE_EDIT]];
add('GET','/units/:id/edit-form','units.editForm',editUnit);
add('PATCH','/units/:id/details','units.edit',editUnit);
add('PATCH','/units/:id/price','units.price',[PERM.PRICE_EDIT,...inv]);
add('PATCH','/units/:id/share-flags','units.flags',[PERM.SHARE,...inv]);
add('GET','/units/:id/ledger','units.ledger',inv);
add('GET','/units/:id/label','units.label',[PERM.LABEL_PRINT,...inv]);
add('GET','/units/:id/recheck-form','units.recheckForm',[PERM.ACCEPTANCE,...inv]);
add('POST','/units/:id/recheck','units.recheck',[PERM.ACCEPTANCE,...inv]);
add('POST','/units/:id/restock','units.restock',[PERM.INBOUND,...inv]);
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
exports.main=require('./shared/startup-timing')(createHandler(routes),moduleStarted);
