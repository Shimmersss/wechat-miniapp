const crypto = require("node:crypto");
const {
  PERM,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  SENSITIVE_FIELDS,
  STAFF_ROLES,
  defaultVisibleFields,
} = require("../../miniprogram/constants/roles");
const { one } = require("./db");
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
    this.code = `HTTP_${status}`;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const id = () => crypto.randomUUID();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value) =>
  crypto.createHmac("sha256", key).update(value).digest("hex");
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function text(value, label, max = 100, optional = false) {
  if (optional && (value === undefined || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    fail(400, `${label}格式无效`);
  return value.trim();
}
function page(query = {}) {
  const p = Number(query.page || 1),
    size = Number(query.pageSize || 20);
  if (
    !Number.isInteger(p) ||
    p < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 1000
  )
    fail(400, "分页参数无效");
  return { page: p, pageSize: size, offset: (p - 1) * size };
}
function list(rows, total, pagination) {
  return {
    list: rows,
    total: Number(total),
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}
function json(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function requirePerm(request, ...permissions) {
  if (!request.user) fail(401, "请先登录");
  if (!permissions.some((p) => request.user.permissions.includes(p)))
    fail(403, "无权限执行该操作");
}
function userView(row, allowStaff = true) {
  const staff = allowStaff && row.staff_status === "active";
  const role = staff
    ? row.staff_role
    : ["customer", "peer", "agent"].includes(row.role)
      ? row.role
      : "customer";
  // 老板角色固定拥有全部权限与字段，防止误配置锁死后台；其他员工角色按 roles 表实时生效
  const boss = staff && role === "boss",
    fields = staff && !boss ? json(row.role_visible_fields) : null;
  return {
    id: row.id,
    nickname: row.nickname,
    role,
    permissions: boss
      ? ROLE_PERMISSIONS.boss
      : staff
        ? json(row.role_permissions) || []
        : ROLE_PERMISSIONS[role] || [],
    visibleFields: boss
      ? Object.keys(SENSITIVE_FIELDS)
      : Array.isArray(fields)
        ? fields
        : defaultVisibleFields(role),
    agentStatus: row.agent_status || undefined,
    staffNo: staff ? row.staff_id : undefined,
    storeId: row.store_id || undefined,
  };
}
const userSql = `SELECT u.*, s.id staff_id, s.status staff_status, s.role_key staff_role, s.store_id, r.permissions role_permissions, r.visible_fields role_visible_fields
  FROM users u LEFT JOIN staff s ON s.user_id=u.id LEFT JOIN roles r ON r.role_key=s.role_key WHERE u.id=? AND u.status='active'`;
async function loadUser(db, userId, allowStaff = true) {
  const row = await one(db, userSql, [userId]);
  return row ? userView(row, allowStaff) : null;
}
async function audit(
  db,
  request,
  action,
  objectId,
  { before = null, after = null, reason = "" } = {},
) {
  await db.execute(
    "INSERT INTO audit_logs (actor_id, action, object_id, before_data, after_data, reason, request_id, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      request.user?.id || null,
      action,
      String(objectId || ""),
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      reason,
      request.id,
      request.ip,
    ],
  );
}
module.exports = {
  userView,
  PERM,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  STAFF_ROLES,
  SENSITIVE_FIELDS,
  HttpError,
  fail,
  id,
  hash,
  hmac,
  equal,
  text,
  page,
  list,
  json,
  requirePerm,
  loadUser,
  audit,
};
