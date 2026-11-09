const started = process.hrtime.bigint();
const { createHandler, rpc, fail } = require("./shared/gateway");
const { requireUser } = require("./shared/identity");
const { prepare, rules } = require("./shared/staff-input");
const { view } = require("./shared/staff-view");
const routes = [
  ["GET", "/staff", "list"],
  ["POST", "/staff", "create"],
  ["PATCH", "/staff/:id", "update"],
  ["POST", "/staff/:id/unbind", "unbind"],
  ["GET", "/roles", "roles.list"],
  ["PUT", "/roles/:key", "roles.update"],
];
exports.main = require("./shared/startup-timing")(
  createHandler(
    routes.map(([method, path, a]) => [
      method,
      path,
      async (ctx) => {
        const u = await requireUser(ctx);
        if (!u.staffNo || !u.permissions.includes("staff:manage"))
          fail(403, "仅有员工管理权限的员工可操作");
        if (a === "roles.update" && u.role !== "boss")
          fail(403, "仅老板可调整角色权限");
        const { d, p } = prepare(a, ctx.data, ctx.params);
        const r = await rpc("api_staff_admin", {
          p_action: a,
          p_id: p.id || null,
          p_key: p.key || null,
          p_data: d,
          p_user: u,
          p_rules: rules,
          p_request_id: ctx.requestId,
        });
        return view(a, r, u, d);
      },
    ]),
  ),
  started,
);
