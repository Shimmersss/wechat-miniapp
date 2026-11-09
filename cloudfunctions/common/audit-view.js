const { canSee } = require("./stock-view");
const { ROLE_LABELS } = require("./roles");
function redact(value, user) {
  const hidden = [
    [/cost|profit|margin/i, "cost"],
    [/supplier/i, "supplier"],
    [/internalNote/i, "internalNote"],
    [/imei/i, "fullImei"],
    [/wholesale/i, "wholesalePrice"],
    [/agent_?base/i, "agentBase"],
  ].filter(([, field]) => !canSee(user, field));
  const walk = (v) =>
    Array.isArray(v)
      ? v.map(walk)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) =>
              hidden.some(([re]) => re.test(k))
                ? [k, "无权限查看"]
                : [k, walk(x)],
            ),
          )
        : v;
  return walk(value);
}
function list(r, u, d) {
  return {
    list: r.rows.map((a) => ({
      id: String(a.id),
      action: a.action,
      objectId: a.object_id,
      actorId: a.actor_id,
      actorName: a.actor_name || "系统",
      actorRole: a.actor_role ? ROLE_LABELS[a.actor_role] : null,
      before: redact(a.before_data, u),
      after: redact(a.after_data, u),
      reason: a.reason,
      ip: a.ip,
      requestId: a.request_id,
      createdAt: a.created_at,
    })),
    total: Number(r.total),
    page: d.page,
    pageSize: d.pageSize,
  };
}
module.exports = { redact, list };
