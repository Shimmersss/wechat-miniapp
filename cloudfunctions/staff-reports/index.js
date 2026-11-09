const started = process.hrtime.bigint();
const { createHandler, rpc, fail } = require("./shared/gateway");
const { requireUser } = require("./shared/identity");
const { prepare } = require("./shared/report-input");
const { view } = require("./shared/report-view");
const { resolveFiles } = require("./shared/stock-files");
const storage = require("./shared/report-storage");
const definitions = [
  ...[
    "overview",
    "visits",
    "trend",
    "visit-trend",
    "breakdown",
    "ageing",
    "agent-earnings",
  ].map((a) => ["GET", "/stats/" + a, a]),
  ["GET", "/staff/dashboard", "dashboard"],
  ["GET", "/audit-logs/filters", "audit.filters"],
  ["GET", "/audit-logs", "audit.list"],
  ["POST", "/stats/export", "export.create"],
  ["GET", "/stats/exports/:id", "export.get"],
];
exports.main = require("./shared/startup-timing")(
  createHandler(
    definitions.map(([method, path, a]) => [
      method,
      path,
      async (ctx) => {
        const u = await requireUser(ctx);
        if (!u.staffNo) fail(403, "仅员工可操作");
        const has = (...ps) => ps.some((p) => u.permissions.includes(p));
        if (
          a.startsWith("audit.")
            ? !has("audit:view")
            : a.startsWith("export.")
              ? !has("data:export") || !has("stats:view", "dashboard:view")
              : a === "agent-earnings"
                ? !has("agent:review", "agent:settle")
                : a === "dashboard"
                  ? !has("dashboard:view")
                  : !has("stats:view", "dashboard:view")
        )
          fail(403, "无权限执行该操作");
        if (a === "ageing" && !has("inventory:view"))
          fail(403, "无库存查看权限");
        if (
          a === "export.create" &&
          !(await rpc("agent_rate_limit", {
            p_actor: u.id,
            p_kind: "reports.export",
            p_max: 10,
          }))
        )
          fail(429, "请求频繁，请稍后再试");
        const { d, p } = prepare(a, ctx.data, ctx.params);
        if (a.startsWith("export.")) {
          const r = await rpc("api_report_export", {
            p_action: a.slice(7),
            p_id: p.id || null,
            p_data: d,
            p_user: u,
            p_request_id: ctx.requestId,
          });
          return a === "export.create"
            ? storage.metadata(r)
            : storage.content(r, u);
        }
        const r = await rpc("api_reports", {
          p_action: a,
          p_id: null,
          p_data: d,
          p_user: u,
          p_request_id: ctx.requestId,
        });
        if (a === "ageing") await resolveFiles(r, u);
        return view(a, r, u, d);
      },
    ]),
  ),
  started,
);
