const started = process.hrtime.bigint();
const crypto = require("node:crypto");
const { createHandler, rpc, fail, hash } = require("./shared/gateway");
const { currentUser } = require("./shared/identity");
const { prepare } = require("./shared/agent-input");
const { view } = require("./shared/agent-view");
const { resolveFiles } = require("./shared/stock-files");
const routes = [
  ["POST", "/agent/applications", "apply"],
  ["GET", "/agent/me", "me"],
  ...["overview", "invite", "units", "orders", "commissions"].map((a) => [
    "GET",
    "/agent/" + a,
    a,
  ]),
  ["PUT", "/agent/units/:id/markup", "markup"],
  ["GET", "/admin/agent-settings", "admin.settings"],
  ["PUT", "/admin/agent-settings", "admin.settings.update"],
  ["GET", "/admin/agent-applications", "admin.applications.list"],
  ["GET", "/admin/agents", "admin.agents.list"],
  ["POST", "/admin/agent-applications/:id/review", "admin.review"],
  ["PATCH", "/admin/agents/:id", "admin.update"],
  ["GET", "/admin/agent-orders", "admin.orders"],
  ["GET", "/admin/agent-earnings", "admin.earnings"],
  ["POST", "/admin/agent-earnings/settle", "admin.settle"],
  ["POST", "/share/links", "share.create"],
  ["GET", "/shop/shares/:id", "share.get"],
  ["PATCH", "/share/links/:id/revoke", "share.revoke"],
  ["GET", "/share/links/:id/copywriting", "share.copy"],
  ["GET", "/share/links/:id/poster", "share.poster"],
  ["POST", "/shop/orders", "order.create"],
  ["GET", "/shop/requests", "requests"],
  ["GET", "/shop/requests/:id", "request.get"],
  ["PATCH", "/shop/requests/:id/cancel", "order.cancel"],
  ["GET", "/customer-requests", "admin.requests"],
  ["GET", "/customer-requests/:id", "admin.request.get"],
  ["PATCH", "/customer-requests/:id/status", "admin.request.status"],
];
const qrCache = new Map(),
  qrPending = new Map();
const code = require("./shared/wechat-code").wechatCode({
  wx: {
    appId: process.env.WX_APP_ID,
    secret: process.env.WX_APP_SECRET,
    envVersion: process.env.WX_CODE_ENV_VERSION || "release",
    checkPath: process.env.WX_CODE_CHECK_PATH !== "false",
  },
});
exports.main = require("./shared/startup-timing")(
  createHandler(
    routes.map(([method, path, a]) => [
      method,
      path,
      async (ctx) => {
        const u = await currentUser(ctx);
        const limit = {
          apply: 10,
          "share.create": 30,
          "share.poster": 15,
          "order.create": 10,
        }[a];
        if (
          limit &&
          !(await rpc("agent_rate_limit", {
            p_actor: u?.id || hash("agent-rate:" + ctx.openid),
            p_kind: a,
            p_max: limit,
          }))
        )
          fail(429, "请求频繁，请稍后再试");
        const { d, p } = prepare(a, ctx.data, ctx.params, u, ctx.headers);
        const lockMinutes = Number(process.env.AGENT_LOCK_MINUTES || 30),
          shareHours = Number(process.env.SHARE_HOURS || 72);
        if (
          ["admin.settings", "admin.settings.update", "order.create"].includes(
            a,
          ) &&
          (!Number.isInteger(lockMinutes) ||
            lockMinutes < 5 ||
            lockMinutes > 1440)
        )
          fail(503, "代理下单锁库时长配置无效");
        if (
          a === "share.create" &&
          (!Number.isFinite(shareHours) || shareHours < 1 || shareHours > 720)
        )
          fail(503, "分享有效期配置无效");
        const r = await rpc("api_agents", {
          p_action: a,
          p_id: p.id || null,
          p_data: d,
          p_user: u,
          p_request_id: ctx.requestId,
          p_config: {
            lockMinutes,
            shareHours,
            shareId: crypto.randomBytes(12).toString("base64url"),
            inviteCodes: Array.from({ length: 10 }, () =>
              crypto
                .randomBytes(6)
                .toString("base64url")
                .replace(/[-_]/g, "")
                .slice(0, 8)
                .toUpperCase(),
            ),
          },
        });
        await resolveFiles(r, u);
        const v = view(a, r, u, d);
        if (a === "share.copy")
          return {
            shareId: v.shareId,
            text:
              v.units
                .map(
                  (x) =>
                    x.name +
                    " " +
                    x.storage +
                    " " +
                    x.color +
                    " ¥" +
                    x.price +
                    "\n" +
                    x.desc,
                )
                .join("\n\n") + "\n夏目数码 · 实拍一机一检",
          };
        if (a === "share.poster") {
          if (!code.configured())
            return {
              ...v,
              qrcode: null,
              qrcodeStatus: "unconfigured",
              message: "暂无法生成可扫码海报，请使用小程序卡片分享",
            };
          let qrcode = qrCache.get(v.shareId);
          if (!qrcode) {
            let pending = qrPending.get(v.shareId);
            if (!pending) {
              pending = code.generate({
                shareId: v.shareId,
                page:
                  v.units.length === 1
                    ? "packages/shop/product/index"
                    : "packages/shop/collection/index",
              });
              qrPending.set(v.shareId, pending);
            }
            try {
              qrcode = await pending;
              if (qrCache.size >= 128)
                qrCache.delete(qrCache.keys().next().value);
              qrCache.set(v.shareId, qrcode);
            } finally {
              if (qrPending.get(v.shareId) === pending)
                qrPending.delete(v.shareId);
            }
          }
          return { ...v, qrcode, qrcodeStatus: "ready" };
        }
        return v;
      },
    ]),
  ),
  started,
);
