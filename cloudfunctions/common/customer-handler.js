const { currentUser } = require("./identity");
const { rpc, fail, hash } = require("./gateway");
const input = require("./request-input");
const visit = require("./visit-input");
const { view } = require("./request-view");
const { resolveFiles } = require("./stock-files");
async function handle(action, ctx) {
  if (action === "options") return input.options();
  const u = await currentUser(ctx);
  if (action !== "visits" && !u) fail(401, "请先登录");
  if (
    action.startsWith("staff.") &&
    (!u.staffNo || !u.permissions.includes("consult:manage"))
  )
    fail(403, "仅有顾客跟进权限的员工可操作");
  const limit =
    action === "visits" ? 60 : action.endsWith(".create") ? 10 : null;
  if (
    limit &&
    !(await rpc("agent_rate_limit", {
      p_actor: u?.id || hash("customer-rate:" + ctx.openid),
      p_kind: action === "visits" ? "visits.batch" : action,
      p_max: limit,
    }))
  )
    fail(429, "请求频繁，请稍后再试");
  if (action === "visits") {
    const d = visit.prepare(ctx.data, ctx.headers);
    return rpc("api_visits", { p_data: d, p_user: u });
  }
  const { d, p } = input.prepare(action, ctx.data, ctx.params, ctx.headers);
  if (
    action === "order.create" &&
    (!Number.isInteger(Number(process.env.AGENT_LOCK_MINUTES || 30)) ||
      Number(process.env.AGENT_LOCK_MINUTES || 30) < 5 ||
      Number(process.env.AGENT_LOCK_MINUTES || 30) > 1440)
  )
    fail(503, "代理下单锁库时长配置无效");
  const r = await rpc("api_customer_requests", {
    p_action: action,
    p_id: p.id || null,
    p_data: d,
    p_user: u,
    p_request_id: ctx.requestId,
    p_config: {
      ...input.config(),
      lockMinutes: Number(process.env.AGENT_LOCK_MINUTES || 30),
    },
  });
  await resolveFiles(r, u);
  return view(action, r, u, d);
}
module.exports = { handle };
