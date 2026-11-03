/** 前端权限判断：只决定入口和按钮显隐，不能替代服务端授权 */
const { STAFF_ROLES, SENSITIVE_FIELDS } = require('../constants/roles');

function isStaff(user) {
  return !!user && STAFF_ROLES.includes(user.role);
}

function isAgent(user) {
  return !!user && user.role === 'agent' && user.agentStatus === 'active';
}

/** @param {string|string[]} perm 权限点，数组表示满足其一即可 */
function can(user, perm) {
  if (!perm) return true;
  if (!user || !user.permissions) return false;
  const list = Array.isArray(perm) ? perm : [perm];
  return list.some((p) => user.permissions.includes(p));
}

/** 字段是否可见（服务端已裁剪时，字段为 undefined，同样视为不可见） */
function canSeeField(user, field) {
  const roles = SENSITIVE_FIELDS[field];
  if (!roles) return true;
  return !!user && roles.includes(user.role);
}

module.exports = { isStaff, isAgent, can, canSeeField };
