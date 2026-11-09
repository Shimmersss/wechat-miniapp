const { publicView } = require("./public-unit");
const finance = (u) =>
  u?.permissions?.some((p) => ["agent:review", "agent:settle"].includes(p));
const maskName = (n) =>
  n ? n.slice(0, 1) + "*".repeat(Math.max(1, n.length - 1)) : "";
const maskPhone = (n) => (n ? n.slice(0, 3) + "****" + n.slice(-4) : "");
const me = (r) =>
  !r
    ? { status: "none" }
    : {
        status: r.status,
        name: r.name,
        phone: r.phone,
        region: r.region,
        appliedAt: r.applied_at,
        ...(r.status === "active"
          ? { markupMax: Number(r.markup_max), inviteCode: r.invite_code }
          : {}),
        ...(r.status === "rejected" ? { reviewRemark: r.review_remark } : {}),
        ...(r.inviter_name ? { inviterName: r.inviter_name } : {}),
      };
const admin = (r) => ({
  id: r.user_id,
  status: r.status,
  name: r.name,
  phone: r.phone,
  region: r.region,
  inviterId: r.inviter_id,
  inviterName: r.inviter_name || null,
  inviteCode: r.invite_code,
  markupMax: r.markup_max === null ? null : Number(r.markup_max),
  reviewRemark: r.review_remark,
  reviewedAt: r.reviewed_at,
  appliedAt: r.applied_at,
  version: r.version,
});
function unit(r) {
  const v = publicView(r, "agent");
  return {
    id: r.id,
    name: v.name,
    storage: v.storage,
    color: v.color,
    grade: v.grade,
    cover: v.cover,
    retail: Number(r.retail),
    markup: Number(r.markup),
    markupMin: 0,
    markupMax: Number(r.markupMax),
    sharePrice: Number(r.price),
    aboveRetail: Number(r.price) > Number(r.retail),
    priceVersion: r.price_version,
  };
}
function order(r, internal, u) {
  const v = {
    id: r.request_id,
    unitId: r.unit_id,
    name: r.unit_snapshot?.name || "",
    storage:
      r.unit_snapshot?.attributes?.storage || r.unit_snapshot?.storage || "",
    status: r.lock_status,
    requestStatus: r.request_status,
    sharePrice: Number(r.share_price),
    ...(!internal || finance(u) ? { markup: Number(r.markup) } : {}),
    lockExpiresAt: r.lock_expires_at,
    releaseReason: r.release_reason || "",
    createdAt: r.created_at,
    customerName: internal ? r.customer_name : maskName(r.customer_name),
    customerPhone: internal ? r.customer_phone : maskPhone(r.customer_phone),
  };
  return {
    ...v,
    ...(internal
      ? {
          agentId: r.agent_id,
          agentName: r.agent_name || null,
          saleOrderId: r.sale_order_id,
          ...(finance(u) ? { agentBase: Number(r.agent_base) } : {}),
        }
      : {}),
  };
}
const earning = (r, internal) => ({
  id: r.id,
  kind: r.kind,
  amount: Number(r.amount) * (r.kind === "reversal" ? -1 : 1),
  status: r.status,
  orderId: r.request_id,
  ...(internal
    ? {
        saleOrderId: r.sale_order_id,
        agentId: r.agent_id,
        agentName: r.agent_name,
        settleReason: r.settle_reason,
      }
    : {}),
  name: r.unit_snapshot?.name || "",
  createdAt: r.created_at,
  settledAt: r.settled_at,
});
const { request } = require("./request-view");
function share(r) {
  const units = r.units.map((x) => publicView(x, r.link.channel)),
    one = units.length === 1,
    first = units[0];
  return {
    shareId: r.link.id,
    channel: r.link.channel,
    path:
      (one
        ? "/packages/shop/product/index"
        : "/packages/shop/collection/index") +
      "?s=" +
      r.link.id,
    title: one
      ? first.name + " " + first.storage + " ¥" + first.price
      : "夏目数码 · " + units.length + "台精选设备",
    ...(one ? { price: first.price } : {}),
    imageUrl: first.cover,
    expireAt: r.link.expires_at,
    units,
  };
}
function view(a, r, u, d) {
  if (["me", "apply"].includes(a)) return me(r);
  if (["admin.review", "admin.update"].includes(a)) return admin(r);
  if (a === "markup") return unit(r);
  if (a === "invite")
    return {
      inviteCode: r.inviteCode,
      members: r.members.map((m) => ({
        name: maskName(m.name),
        status: m.status,
        appliedAt: m.applied_at,
      })),
    };
  if (a.startsWith("share.") && a !== "share.revoke") return share(r);
  if (a === "order.create" || a === "request.get" || a === "admin.request.get")
    return request(r, u, a.startsWith("admin."));
  if (
    [
      "units",
      "orders",
      "commissions",
      "admin.orders",
      "admin.earnings",
      "admin.applications.list",
      "admin.agents.list",
      "requests",
      "admin.requests",
    ].includes(a)
  )
    return {
      list: r.rows.map((x) =>
        a === "units"
          ? unit(x)
          : a.includes("earnings") || a === "commissions"
            ? earning(x, a.startsWith("admin."))
            : a.includes("applications") || a === "admin.agents.list"
              ? admin(x)
              : a.includes("requests")
                ? request(x, u, a.startsWith("admin."))
                : order(x, a.startsWith("admin."), u),
      ),
      total: Number(r.total),
      page: d.page,
      pageSize: d.pageSize,
      ...(r.summary ? { summary: r.summary } : {}),
    };
  return r;
}
module.exports = { view, request, share };
