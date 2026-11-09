const { fail } = require("./gateway");
const { text, integer } = require("./stock-input");
const { isPhone } = require("./validate");
const { PERM, STAFF_ROLES, SENSITIVE_FIELDS } = require("./roles");
const rules = {
  roles: STAFF_ROLES,
  permissions: Object.values(PERM),
  fields: Object.keys(SENSITIVE_FIELDS),
};
function prepare(a, input, params = {}) {
  const d = { ...input },
    p = { ...params };
  if (
    p.id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      p.id,
    )
  )
    fail(400, "员工编号无效");
  const allowed = (keys) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !keys.includes(k))
    )
      fail(400, "员工参数无效");
  };
  if (a === "list") {
    d.page = integer(d.page || 1, "页码", 1, 1000000);
    d.pageSize = integer(d.pageSize || 20, "每页数量", 1, 1000);
    d.offset = (d.page - 1) * d.pageSize;
    if (d.status && !["active", "disabled"].includes(d.status))
      fail(400, "员工状态无效");
    if (d.roleKey) d.roleKey = text(d.roleKey, "角色", 32);
    if (d.keyword) d.keyword = text(d.keyword, "搜索", 50);
  }
  if (a === "create") {
    allowed(["name", "phone", "roleKey", "reason"]);
    d.name = text(d.name, "姓名", 50);
    d.phone = text(d.phone, "手机号", 11);
    if (!isPhone(d.phone)) fail(400, "请填写11位手机号");
    if (!STAFF_ROLES.includes(d.roleKey)) fail(400, "角色无效");
  }
  if (a === "update") {
    allowed(["name", "roleKey", "status", "reason", "version"]);
    if (d.name !== undefined) d.name = text(d.name, "姓名", 50);
    if (d.roleKey !== undefined && !STAFF_ROLES.includes(d.roleKey))
      fail(400, "角色无效");
    if (d.status !== undefined && !["active", "disabled"].includes(d.status))
      fail(400, "员工状态无效");
  }
  if (["create", "update", "unbind", "roles.update"].includes(a))
    d.reason = text(d.reason, "调整原因", 500);
  if (["update", "unbind", "roles.update"].includes(a))
    d.version = integer(d.version, "版本", 1, 2147483647);
  if (a === "roles.update") {
    if (!STAFF_ROLES.includes(p.key)) fail(404, "角色不存在");
    if (p.key === "boss") fail(400, "老板角色固定拥有全部权限，不能编辑");
    if (
      !Array.isArray(d.permissions) ||
      d.permissions.some((k) => !rules.permissions.includes(k)) ||
      !Array.isArray(d.visibleFields) ||
      d.visibleFields.some((k) => !rules.fields.includes(k))
    )
      fail(400, "权限点或字段无效");
    d.permissions = [...new Set(d.permissions)].sort();
    d.visibleFields = [...new Set(d.visibleFields)].sort();
  }
  return { d, p };
}
module.exports = { prepare, rules };
