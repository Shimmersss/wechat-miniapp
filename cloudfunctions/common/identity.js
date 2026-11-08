/**
 * 当前用户：会话令牌 + 平台注入的 OPENID 双重校验，再按员工角色组装权限与可见字段。
 * 与 server/src/core.js 的 userView 保持同一套规则。
 */
const {
  ROLE_PERMISSIONS,
  SENSITIVE_FIELDS,
  defaultVisibleFields,
} = require("./roles");
const { rpc, tokenHash, fail } = require("./gateway");

function userView(row) {
  const u = row.user;
  // 只有经过员工短信登录（assurance=staff）的会话才拥有员工身份
  const staff = row.assurance === "staff" && row.staff_status === "active";
  const role = staff
    ? row.staff_role
    : ["customer", "peer", "agent"].includes(u.role)
      ? u.role
      : "customer";
  // 老板固定拥有全部权限与字段，防止误配置锁死后台
  const boss = staff && role === "boss";
  const fields = staff && !boss ? row.role_visible_fields : null;
  return {
    id: u.id,
    nickname: u.nickname,
    role,
    permissions: boss
      ? ROLE_PERMISSIONS.boss
      : staff
        ? row.role_permissions || []
        : ROLE_PERMISSIONS[role] || [],
    visibleFields: boss
      ? Object.keys(SENSITIVE_FIELDS)
      : Array.isArray(fields)
        ? fields
        : defaultVisibleFields(role),
    agentStatus: u.agent_status || undefined,
    staffNo: staff ? row.staff_id : undefined,
    storeId: (staff && row.store_id) || undefined,
  };
}

/** 有有效会话返回用户视图，否则 null */
async function currentUser(ctx) {
  const h = tokenHash(ctx.headers);
  if (!h || !ctx.openid) return null;
  const row = await rpc("api_session_user", {
    p_token_hash: h,
    p_openid: ctx.openid,
  });
  return row ? userView(row) : null;
}

async function requireUser(ctx) {
  const user = await currentUser(ctx);
  if (!user) fail(401, "请先登录");
  return user;
}

module.exports = { userView, currentUser, requireUser };
