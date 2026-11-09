// 首个调用标记与模块加载时间用于区分真实新实例/热调用；不返回身份、请求头或环境配置。
const moduleStarted = process.hrtime.bigint();
const { createHandler, rpc, fail } = require('./shared/gateway');
const { requireUser } = require('./shared/identity');
const { PERM } = require('./shared/roles');
const { prepare } = require('./shared/stock-input');
const { view } = require('./shared/stock-view');
const { resolveFiles } = require('./shared/stock-files');
const read = [PERM.SALES_CREATE, PERM.REFUND, PERM.STATS_VIEW];
const definitions = [
  ['GET', '/sales/lookup', 'sales.lookup', [PERM.SALES_CREATE]],
  ['POST', '/sales/quote', 'sales.quote', [PERM.SALES_CREATE]],
  ['POST', '/sales-orders', 'sales.create', [PERM.SALES_CREATE]],
  ['GET', '/sales-orders', 'sales.list', read],
  ['GET', '/sales-orders/sellers', 'sales.sellers', read],
  ['GET', '/sales-orders/:id', 'sales.get', read],
  ['POST', '/sales-orders/:id/refund', 'sales.refund', [PERM.REFUND]],
  ['POST', '/sales-orders/:id/receipts', 'sales.receipts', [PERM.SALES_CREATE, PERM.REFUND]],
];
const handler = createHandler(definitions.map(([method,path,action,permissions]) => [method,path,async ctx => {
  const user = await requireUser(ctx);
  if (!user.staffNo || !permissions.some(p => user.permissions.includes(p))) fail(403, '无权限执行该操作');
  const {d,p} = prepare(action, ctx.data, ctx.params, user);
  const result = action === 'sales.receipts'
    ? await rpc('api_sales_receipts', {p_id:p.id,p_data:d,p_user:user,p_request_id:ctx.requestId})
    : await rpc('api_sales', {p_action:action,p_params:p,p_data:d,p_user:user,p_request_id:ctx.requestId});
  await resolveFiles(result,user);
  return view(action,result,p,user);
}]));
exports.main = require('./shared/startup-timing')(handler, moduleStarted);
