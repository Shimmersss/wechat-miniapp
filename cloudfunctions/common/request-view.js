const { publicView } = require("./public-unit");
const { TRANSITIONS, ACTIVE } = require("./customer-requests");
const canPeer = (u) =>
  !!u &&
  (u.role === "peer" ||
    (u.staffNo &&
      u.permissions.includes("share:do") &&
      u.visibleFields.includes("wholesalePrice")));
function request(r, u, internal) {
  const state = TRANSITIONS[r.kind]?.[r.status] || [],
    agent = r.kind === "order" ? r.agent_order : null;
  let unit = r.unit_snapshot
    ? publicView(
        r.unit_snapshot,
        r.unit_snapshot.priceType === "wholesale" || r.source === "peer"
          ? "peer"
          : r.source === "agent"
            ? "agent"
            : "customer",
      )
    : null;
  if (unit?.priceType === "wholesale" && !canPeer(u))
    unit = { id: unit.id, name: unit.name, imeiMasked: unit.imeiMasked };
  const finance = u?.permissions.some((p) =>
    ["agent:review", "agent:settle"].includes(p),
  );
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: r.version,
    unitId: r.unit_id,
    unit,
    content: r.content,
    phone: r.phone,
    name: r.name,
    date: r.appointment_date || null,
    timeSlot: r.time_slot || null,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    saleRecorded: !!r.sale_order_id,
    ...(agent
      ? {
          agentOrder: {
            status: agent.lock_status,
            sharePrice: Number(agent.share_price),
            priceVersion: agent.price_version,
            lockExpiresAt: agent.lock_expires_at,
            ...(internal
              ? {
                  agentId: agent.agent_id,
                  agentName: agent.agent_name,
                  ...(finance ? { markup: Number(agent.markup) } : {}),
                }
              : {}),
          },
        }
      : {}),
    ...(internal
      ? {
          ownerId: r.owner_id,
          shareId: r.share_id,
          shareOwnerId: r.share_owner_id,
          shareOwnerName: r.share_owner_name || null,
          actions: state,
          canStartSale:
            ACTIVE.includes(r.status) &&
            !r.sale_order_id &&
            !!r.unit_id &&
            u.permissions.includes("sales:create") &&
            (r.kind === "order"
              ? agent?.lock_status === "locked" &&
                Date.parse(agent.lock_expires_at) > Date.now()
              : r.unit_status === "in_stock" && r.unit_ownership === "own"),
          ...(u.permissions.some((p) =>
            ["sales:create", "stats:view", "sales:refund"].includes(p),
          )
            ? { salesOrderId: r.sale_order_id || undefined }
            : {}),
        }
      : { canCancel: ACTIVE.includes(r.status) }),
    timeline: (r.events || []).map((e) => ({
      id: e.id,
      status: e.to_status,
      time: e.created_at,
      actor: e.actor_kind === "staff" ? "门店" : "本人",
      ...(internal
        ? { operator: e.nickname, note: e.note }
        : e.actor_kind === "customer"
          ? { note: e.note }
          : {}),
    })),
  };
}
function view(action, r, u, d) {
  if (["list", "staff.list"].includes(action))
    return {
      list: r.rows.map((x) => request(x, u, action.startsWith("staff."))),
      total: Number(r.total),
      page: d.page,
      pageSize: d.pageSize,
    };
  if (
    [
      "get",
      "staff.get",
      "consult.create",
      "appointment.create",
      "order.create",
    ].includes(action)
  )
    return request(r, u, action.startsWith("staff."));
  return r;
}
module.exports = { view, request };
