const { fail } = require('./gateway');
const { validateFields, validateSpecs, normalizeSpecs } = require('./template');
const { isImei, normalizeSerial, serialError, noSerialReasonError } = require('./validate');
const { UNIT_STATUS, PURCHASE_STATUS, STOCKTAKE_SCOPE, STOCKTAKE_DEFAULT_SCOPE, CARRIERS } = require('./status');
function text(v, label, max=100, optional=false) {
  if (optional && (v === undefined || v === '')) return '';
  if (typeof v !== 'string' || !v.trim() || v.trim().length>max) fail(400, `${label}格式无效`);
  return v.trim();
}
function integer(v,label,min=1,max=1000) {
  if (!['number','string'].includes(typeof v) || !/^\d+$/.test(String(v).trim()) || !Number.isSafeInteger(Number(v)) || Number(v)<min || Number(v)>max) fail(400,`${label}需为 ${min}～${max} 的整数`);
  return Number(v);
}
function money(v) {
  if (!['number','string'].includes(typeof v) || !/^\d{1,12}(\.\d{1,2})?$/.test(String(v).trim()) || Number(v)>999999999999.99) fail(400,'金额需为非负金额，最多两位小数');
  return String(v).trim();
}
function object(v,label) { if (!v || typeof v!=='object' || Array.isArray(v)) fail(400,`${label}格式无效`); return v; }
function rows(v,label) { if (!Array.isArray(v) || !v.length || v.length>100) fail(400,`${label}需为1～100项`); v.forEach(x=>object(x,label)); }
function choice(v,allowed,label) { if (!allowed.includes(v)) fail(400,`${label}无效`); }
function date(v) { text(v,'日期',10); if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v) fail(400,'日期格式无效'); }
function prepare(action, input, params, user) {
  const d={...object(input,'参数')}, p={...params};
  // 动态参数在函数层拦截无效 UUID；分类、模板、型号使用原来的字符串 ID。
  if (p.id && !/^(categories|models|templates)\./.test(action) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)) fail(400,'记录标识格式无效');
  if (/\.list$|\.versions$|\.ledger$|sessions.units/.test(action)) {
    p.page=integer(d.page||1,'页码',1,1000000); p.pageSize=integer(d.pageSize||20,'每页数量',1,1000); p.limit=p.pageSize; p.offset=(p.page-1)*p.pageSize;
  }
  if (action==='templates.publish') {
    const err=validateFields(d.fields); if(err) fail(400,err);
    integer(d.baseVersion,'模板版本',1,1000000);
    if (d.descriptionPresets!==undefined) {
      const v=d.descriptionPresets;
      if(!v||typeof v!=='object'||['peer','customer'].some(k=>!Array.isArray(v[k])||v[k].length>6||v[k].some(s=>typeof s!=='string'||!s.trim()||s.length>200))) fail(400,'每类快捷描述最多6句，每句1～200字');
      d.descriptionPresets=Object.fromEntries(['peer','customer'].map(k=>[k,v[k].map(s=>s.trim())]));
    }
  }
  if (/categories\.(create|update)/.test(action) && d.identifierMode!==undefined) choice(d.identifierMode,['imei','serial','serial_imei'],'串码方式');
  if (/models\.(create|update)/.test(action)) {
    ['name','brandLabel','series','category'].forEach(k=>text(d[k],k,k==='name'?100:k==='category'?60:50));
    if (d.brandId !== undefined) d.brandId = text(d.brandId, '品牌', 50);
    const err=validateSpecs(d.specs); if(err) fail(400,err);
    if (d.specs!==undefined) d.specs=normalizeSpecs(d.specs);
    const tacs=d.tacs||[];
    if(!Array.isArray(tacs)||tacs.length>100||tacs.some(t=>typeof t!=='string'||!/^\d{8}$/.test(t))||new Set(tacs).size!==tacs.length) fail(400,'TAC 必须为不重复的八位数字');
    d.tacs=tacs; if(tacs.length) text(d.tacSource,'TAC 核验来源',200);
  }
  if (action === 'models.series') {
    d.category = text(d.category, '分类', 60);
    d.brand = text(d.brand, '品牌', 50);
  }
  if (action === 'models.delete') p.id = text(p.id, '型号', 60);
  if (action === 'models.list' || action === 'models.brands') {
    if (d.category !== undefined) d.category = text(d.category, '分类', 60);
    if (d.brand !== undefined && d.brand !== '') d.brand = text(d.brand, '品牌', 50); else delete d.brand;
    if (d.keyword !== undefined && d.keyword !== '') d.keyword = text(d.keyword, '搜索内容', 50); else delete d.keyword;
  }
  if (action === 'models.identify') {
    d.imei = text(d.imei, 'IMEI', 15);
    if (!isImei(d.imei)) fail(400, 'IMEI 格式或校验位无效');
  }
  if (/suppliers\.(create|update)/.test(action) && d.active!==undefined && typeof d.active!=='boolean') fail(400,'供应商状态无效');
  if(action==='suppliers.list' && d.active!==undefined) choice(String(d.active),['true','false'],'供应商状态');
  if(/purchase\.(create|update)/.test(action)) {
    rows(d.lines,'采购明细'); date(d.expectedAt);
    d.lines=d.lines.map(x=>{integer(x.quantity,'采购数量',1,1000);money(x.unitCost);if(x.attributes!==undefined)object(x.attributes,'采购规格');return x;});
    if(d.freight!==undefined)money(d.freight);
  }
  if(action==='purchase.list' && d.status) choice(d.status,Object.keys(PURCHASE_STATUS),'采购状态');
  if(action==='purchase.shipment') {
    choice(d.carrier,CARRIERS.map(c=>c.value),'承运商');
    if(typeof d.trackingNo!=='string'||!/^[A-Za-z0-9]{8,40}$/.test(d.trackingNo)) fail(400,'运单号无效');
  }
  if(action==='acceptance.submit') {
    rows(d.items,'验收设备');if(integer(d.declaredCount,'本次实收数量',1,100)!==d.items.length)fail(400,'实收数量与逐台扫码数量不一致');
    d.items.forEach(x=>choice(x.result,['pass','fail'],'验收结论'));
  }
  if(action==='acceptance.resolve') choice(d.action,['return','dispute','reinspect'],'异常处理方式');
  if (action === 'pricing.suggest') { d.cost = money(d.cost); for (const k of ['targetProfit','retailProfit','wholesaleProfit','agentProfit']) if (d[k] !== undefined) d[k] = money(d[k]); }
  if(action==='inbound.batch') rows(d.units,'入库设备');
  if(action==='inbound.single' || action==='inbound.batch') {
    const common=action==='inbound.single'?d:object(d.common||{},'公共参数');
    const seen=new Set();
    for(const row of action==='inbound.single'?[d]:d.units) {
      const x={...common,...row};
      for(const v of [x.imei1,x.imei2].filter(Boolean)) {if(!isImei(v))fail(400,'IMEI 格式或校验位无效'); if(seen.has(v))fail(400,'本次提交存在重复串码');seen.add(v);}
      // 序列号与原因的最终校验在库内按分类串码方式完成；这里先拦格式和本批重复
      if(x.serialNo!==undefined&&x.serialNo!==''){if(typeof x.serialNo!=='string')fail(400,'序列号格式无效');const err=serialError(x.serialNo);if(err)fail(400,err);const sn='SN:'+normalizeSerial(x.serialNo);if(seen.has(sn))fail(400,'本次提交存在重复序列号');seen.add(sn);}
      if(x.noSerialReason!==undefined&&x.noSerialReason!==''){if(typeof x.noSerialReason!=='string')fail(400,'无序列号原因格式无效');const err=noSerialReasonError(x.noSerialReason);if(err)fail(400,err);}
    }
    if(action==='inbound.single'&&d.quantity!==undefined) d.quantity=integer(d.quantity,'入库数量',1,100);
    if(action==='inbound.batch'&&common.quantity!==undefined) fail(400,'批量入库不支持按数量入库');
  }
  if(action==='inbound.checkSerial') {
    d.modelId=text(d.modelId,'型号',60);d.serialNo=text(d.serialNo,'序列号',40);
    const err=serialError(d.serialNo);if(err)fail(400,err);
  }
  if(action==='units.list') {
    if(d.status)choice(d.status,Object.keys(UNIT_STATUS),'库存状态');
    if(d.ageingOver!==undefined)integer(d.ageingOver,'库龄',0,36500);
    for(const k of ['minPrice','maxPrice']) if(d[k]!==undefined)d[k]=money(d[k]);
    if(d.minPrice!==undefined&&d.maxPrice!==undefined&&Number(d.minPrice)>Number(d.maxPrice))fail(400,'最低价不能高于最高价');
    if(d.keyword){d.keyword=text(d.keyword,'搜索内容',100);if(/^\d+$/.test(d.keyword)&&d.keyword.length!==15&&!user.visibleFields.includes('fullImei'))fail(400,'串码查询请扫描完整 IMEI');}
    if(d.lotId!==undefined&&(typeof d.lotId!=='string'||!/^[0-9a-f-]{36}$/i.test(d.lotId)))fail(400,'批次标识无效');
    if(d.noSerial!==undefined){if(!['true',true].includes(d.noSerial))fail(400,'筛选参数无效');d.noSerial=true;}
    if(d.category!==undefined)d.category=text(d.category,'分类',60);
  }
  if(action==='units.price') {
    const keys=['retail','wholesale','agentBase'].filter(k=>d[k]!==undefined);
    if(!keys.length||Object.keys(d).some(k=>!['retail','wholesale','agentBase','reason','priceVersion'].includes(k)))fail(400,'改价参数无效');
    keys.forEach(k=>d[k]=money(d[k])); text(d.reason,'改价原因',500);
  }
  if (action === 'units.edit') {
    const allowed = ['editVersion', 'reason', 'cost', 'condition', 'attributes', 'peerDesc', 'customerDesc', 'internalNote'];
    if (Object.keys(d).some(key => !allowed.includes(key)) || !/^[a-f0-9]{64}$/.test(d.editVersion || ''))
      fail(400, '设备编辑参数无效');
    d.reason = text(d.reason, '修改原因', 500);
    if (d.cost !== undefined) d.cost = money(d.cost);
    if (d.condition !== undefined) choice(d.condition, ['used', 'new'], '新旧状态');
    if (d.attributes !== undefined) object(d.attributes, '机况参数');
    for (const [key, label] of [['peerDesc', '同行描述'], ['customerDesc', '顾客描述'], ['internalNote', '内部备注']]) {
      if (d[key] !== undefined) d[key] = text(typeof d[key] === 'string' ? d[key].trim() : d[key], label, 4000, true);
    }
  }
  if(action==='units.void') {
    if(Object.keys(d).some(k=>k!=='reason'))fail(400,'删除参数无效');
    d.reason=text(d.reason,'删除原因',200);
  }
  if(action==='units.flags.batch') {
    if(Object.keys(d).some(k=>!['unitIds','shareAgent'].includes(k))||typeof d.shareAgent!=='boolean'||!Array.isArray(d.unitIds)||!d.unitIds.length||d.unitIds.length>100||d.unitIds.some(k=>typeof k!=='string'||!/^[0-9a-f-]{36}$/i.test(k)))fail(400,'请选择1～100台设备并指定开关');
  }
  if(action==='units.recheck') {choice(d.result,['pass','fail'],'复检结论');integer(d.inspectionVersion,'复检版本',1,1000000);if(d.attributes!==undefined)object(d.attributes,'复检参数');}
  if(action==='units.restock') {
    d.reason=text(d.reason,'重新入库原因',500);
    if(typeof d.restockToken!=='string'||!/^\d{0,20}$/.test(d.restockToken)) fail(400,'设备流水标识无效');
  }
  if(action==='sessions.create') {
    const statuses=d.statuses===undefined?STOCKTAKE_DEFAULT_SCOPE:d.statuses;
    if(!Array.isArray(statuses)||!statuses.length||statuses.some(s=>!STOCKTAKE_SCOPE.includes(s)))fail(400,'盘点范围只能选择在店内的库存状态');
    d.statuses=[...new Set(statuses)].sort(); d.modelId=d.modelId?text(d.modelId,'型号',60):null; d.category=d.category?text(d.category,'分类',60):null;
    if(d.modelId&&d.category)fail(400,'型号和分类只能选一种范围');d.note=text(d.note,'盘点说明',200,true);
  }
  if(action==='sessions.list'&&d.status)choice(d.status,['open','closed','cancelled'],'盘点单状态');
  if(action==='sessions.units'&&d.state)choice(d.state,['pending','scanned','extra'],'清单类型');
  if(action==='records.resolve') {choice(d.type,['unit','extra'],'差异类型');choice(d.resolution,d.type==='unit'?['pending','found','lost']:['pending','handled'],'处理结果');text(d.note,'处理说明',200);}
  if(action==='sales.quote'||action==='sales.create') {
    rows(d.items,'销售设备');const seen=new Set();
    d.items=d.items.map(x=>{const unitId=text(x.unitId,'设备编号',36);if(seen.has(unitId))fail(400,'销售设备重复');seen.add(unitId);const channel=x.channel||'retail';choice(channel,['retail','wholesale','agent'],'销售渠道');if(x.price!==undefined)money(x.price);return {unitId,channel,priceVersion:x.priceVersion,...(x.price!==undefined?{price:x.price}:{})};}).sort((a,b)=>a.unitId.localeCompare(b.unitId));
    if(action==='sales.create'){choice(d.payMethod,['微信','支付宝','现金','银行卡','分期'],'付款方式');if(d.paymentConfirmed!==true)fail(400,'请确认实际收款并选择付款方式');}
  }
  if(action==='sales.list') {
    if(d.status)choice(d.status,['paid','partially_refunded','refunded'],'销售状态');
    for(const k of ['from','to'])if(d[k])date(d[k]);
    if(d.keyword)d.keyword=text(d.keyword,'搜索',100);
    if(d.sellerId)text(d.sellerId,'销售员',36);
  }
  if(action==='sales.refund') {
    text(d.reason,'退款原因',500);text(d.requestKey,'提交标识',80);
    choice(d.kind||'return',['return','adjustment'],'退款类型');rows(d.items,'退款项目');
    const seen=new Set();
    for(const x of d.items){const id=text(x.itemId,'销售明细',36);if(seen.has(id))fail(400,'退款明细重复');seen.add(id);if(x.amount!==undefined)money(x.amount);else if(d.kind==='adjustment')fail(400,'差价退款需填写退款金额');}
  }
  return {d,p};
}
module.exports={prepare,text,money,integer};
