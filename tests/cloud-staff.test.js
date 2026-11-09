const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  path = require("node:path");
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk") return { init() {} };
  if (
    args[0]?.filename.startsWith(
      path.join(__dirname, "../cloudfunctions/common/"),
    ) &&
    ["roles", "status", "template", "validate"].some((k) => name === "./" + k)
  ) {
    const k = name.slice(2);
    return original.call(
      this,
      path.join(
        __dirname,
        "../miniprogram",
        ["roles", "status"].includes(k) ? "constants" : "utils",
        k,
      ),
      ...args,
    );
  }
  return original.call(this, name, ...args);
};
const { prepare, rules } = require("../cloudfunctions/common/staff-input"),
  { employee, role } = require("../cloudfunctions/common/staff-view");
Module._load = original;
const id = "00000000-0000-0000-0000-000000000001";
test("云员工维护拒绝伪造绑定/身份字段，变更必须给原因与版本", () => {
  const valid = {
    name: "测试员工",
    phone: "19900000001",
    roleKey: "sales",
    reason: "入职",
  };
  assert.equal(prepare("create", valid, {}).d.name, "测试员工");
  for (const extra of [{ user_id: id }, { openid: "forged" }, { version: 9 }])
    assert.throws(() => prepare("create", { ...valid, ...extra }, {}));
  assert.throws(() =>
    prepare("update", { status: "disabled", reason: "离职" }, { id }),
  );
  assert.throws(() => prepare("unbind", { version: 1, reason: "" }, { id }));
  assert.throws(() => prepare("create", { ...valid, roleKey: "agent" }, {}));
  assert.throws(() =>
    prepare(
      "update",
      { version: 1, reason: "改号", phone: "19900000002" },
      { id },
    ),
  );
});
test("云角色权限只接受共享白名单并去重排序，老板角色不可编辑", () => {
  const d = {
    reason: "权限核对",
    version: 1,
    permissions: ["inventory:view", "dashboard:view", "inventory:view"],
    visibleFields: ["fullImei", "cost", "cost"],
  };
  const r = prepare("roles.update", d, { key: "sales" }).d;
  assert.deepEqual(r.permissions, ["dashboard:view", "inventory:view"]);
  assert.deepEqual(r.visibleFields, ["cost", "fullImei"]);
  assert.throws(() => prepare("roles.update", d, { key: "boss" }));
  assert.throws(() =>
    prepare(
      "roles.update",
      { ...d, permissions: ["made:up"] },
      { key: "sales" },
    ),
  );
  assert.throws(() =>
    prepare(
      "roles.update",
      { ...d, visibleFields: ["password"] },
      { key: "sales" },
    ),
  );
  assert.ok(rules.roles.includes("engineer"));
});
test("云员工列表仅返回原DTO，绑定状态和本人判断不泄露用户编号/OPENID/令牌", () => {
  const r = employee(
    {
      id,
      user_id: id,
      name: "验证",
      phone: "19900000001",
      role_key: "sales",
      status: "active",
      version: 2,
      openid: "private",
      token_hash: "private",
      last_login: "2026-11-09",
    },
    { id },
  );
  assert.equal(r.isSelf, true);
  assert.equal(r.wechatBound, true);
  assert.equal(r.roleLabel, "销售");
  for (const k of ["user_id", "openid", "token_hash", "store_id"])
    assert.equal(r[k], undefined);
  assert.equal(
    employee({ id, user_id: null, role_key: "warehouse" }, { id }).isSelf,
    false,
  );
});
test("云角色视图老板始终全部权限字段，其他角色显示实际配置与在职人数", () => {
  const boss = role({
    role_key: "boss",
    label: "老板",
    permissions: [],
    visible_fields: [],
    staff_count: 1,
    version: 1,
  });
  assert.equal(boss.editable, false);
  assert.ok(boss.permissions.includes("staff:manage"));
  assert.ok(boss.visibleFields.includes("cost"));
  const sales = role({
    role_key: "sales",
    label: "销售",
    permissions: ["inventory:view"],
    visible_fields: ["cost"],
    staff_count: "2",
    version: 3,
  });
  assert.deepEqual(sales.permissions, ["inventory:view"]);
  assert.deepEqual(sales.visibleFields, ["cost"]);
  assert.equal(sales.staffCount, 2);
});
