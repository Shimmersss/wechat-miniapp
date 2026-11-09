const { ROLE_LABELS, PERM, SENSITIVE_FIELDS } = require("./roles");
function employee(r, u) {
  return {
    id: r.id,
    isSelf: !!r.user_id && r.user_id === u.id,
    name: r.name,
    phone: r.phone,
    roleKey: r.role_key,
    roleLabel: ROLE_LABELS[r.role_key] || r.role_key,
    status: r.status,
    wechatBound: !!r.user_id,
    lastLoginAt: r.last_login || null,
    createdAt: r.created_at,
    version: r.version,
  };
}
function role(r) {
  const boss = r.role_key === "boss";
  return {
    key: r.role_key,
    label: r.label,
    permissions: boss ? Object.values(PERM) : r.permissions || [],
    visibleFields: boss
      ? Object.keys(SENSITIVE_FIELDS)
      : r.visible_fields || [],
    editable: !boss,
    staffCount: Number(r.staff_count || 0),
    version: r.version,
  };
}
function view(a, r, u, d) {
  if (a === "roles.list") return { list: r.rows.map(role), canEdit: r.canEdit };
  if (a === "roles.update") return role(r);
  if (a === "list")
    return {
      list: r.rows.map((x) => employee(x, u)),
      total: Number(r.total),
      page: d.page,
      pageSize: d.pageSize,
    };
  return employee(r, u);
}
module.exports = { view, employee, role };
