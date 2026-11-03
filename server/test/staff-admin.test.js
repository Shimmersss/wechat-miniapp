const test = require("node:test"),
  assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture } = require("./helpers");
const { userView } = require("../src/core");
const { canSee } = require("../src/stock");
let f;
const phone = () =>
  "137" + String(crypto.randomInt(0, 100000000)).padStart(8, "0");
test.before(async () => {
  f = await fixture(["boss", "manager", "sales", "warehouse", "finance"]);
});
test.after(async () => f?.close());
// 按本次夹具的用户编号精确定位员工，避免误改验证库里同名的历史夹具
const staffOf = async (role) => {
  const [rows] = await f.admin.execute(
    "SELECT id,version FROM staff WHERE user_id=?",
    [f.users[role]],
  );
  return rows[0];
};

test("员工：新增/重复手机号、非老板不能动老板、不能停用自己、停用与解绑立即失效", async () => {
  const p = phone();
  let r = await f.api("POST", "/staff", {
    name: "新店员",
    phone: p,
    roleKey: "sales",
    reason: "入职",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.wechatBound, false);
  assert.equal(r.data.roleLabel, "销售");
  const created = r.data;
  assert.equal(
    (
      await f.api("POST", "/staff", {
        name: "重复",
        phone: p,
        roleKey: "sales",
        reason: "入职",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.api(
        "POST",
        "/staff",
        { name: "越权", phone: phone(), roleKey: "boss", reason: "入职" },
        "manager",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("POST", "/staff", {
        name: "无效",
        phone: phone(),
        roleKey: "agent",
        reason: "入职",
      })
    ).status,
    400,
  );
  assert.equal((await f.api("GET", "/staff", undefined, "sales")).status, 403);

  r = await f.api(
    "PATCH",
    "/staff/" + created.id,
    {
      name: "新店员2",
      roleKey: "warehouse",
      reason: "调岗",
      version: created.version,
    },
    "manager",
  );
  assert.equal(r.data.roleKey, "warehouse");
  assert.equal(
    (
      await f.api("PATCH", "/staff/" + created.id, {
        name: "旧版本",
        reason: "x",
        version: created.version,
      })
    ).status,
    409,
  );

  const boss = await staffOf("boss");
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/staff/" + boss.id,
        { status: "disabled", reason: "x", version: boss.version },
        "manager",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.api("PATCH", "/staff/" + boss.id, {
        status: "disabled",
        reason: "自己",
        version: boss.version,
      })
    ).status,
    400,
  );

  const warehouse = await staffOf("warehouse");
  assert.equal(
    (await f.api("GET", "/units?pageSize=1", undefined, "warehouse")).status,
    200,
  );
  r = await f.api("PATCH", "/staff/" + warehouse.id, {
    status: "disabled",
    reason: "离职",
    version: warehouse.version,
  });
  assert.equal(r.data.status, "disabled");
  assert.equal(
    (await f.api("GET", "/units?pageSize=1", undefined, "warehouse")).status,
    401,
  );

  const finance = await staffOf("finance");
  assert.equal(
    (
      await f.api("POST", "/staff/" + finance.id + "/unbind", {
        reason: "换手机",
        version: finance.version,
      })
    ).data.wechatBound,
    false,
  );
  assert.equal(
    (await f.api("GET", "/staff/dashboard", undefined, "finance")).status,
    401,
  );
  assert.equal(
    (
      await f.api("POST", "/staff/" + finance.id + "/unbind", {
        reason: "再次",
        version: finance.version + 1,
      })
    ).status,
    409,
  );
});

test("角色：只有老板能改、老板角色不可改、校验权限点、版本冲突与审计", async () => {
  const roles = (await f.api("GET", "/roles", undefined, "manager")).data;
  assert.equal(roles.canEdit, false);
  const boss = roles.list.find((x) => x.key === "boss"),
    sales = roles.list.find((x) => x.key === "sales");
  assert.equal(boss.editable, false);
  assert.ok(boss.visibleFields.includes("cost"));
  assert.ok(!sales.visibleFields.includes("cost"));
  const same = {
    permissions: sales.permissions,
    visibleFields: sales.visibleFields,
    reason: "核对",
    version: sales.version,
  };
  assert.equal(
    (await f.api("PUT", "/roles/sales", same, "manager")).status,
    403,
  );
  assert.equal(
    (await f.api("PUT", "/roles/boss", { ...same, permissions: [] })).status,
    400,
  );
  assert.equal(
    (await f.api("PUT", "/roles/sales", { ...same, permissions: ["bad:perm"] }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.api("PUT", "/roles/sales", {
        ...same,
        visibleFields: ["password"],
      })
    ).status,
    400,
  );
  const saved = await f.api("PUT", "/roles/sales", same);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, sales.version + 1);
  assert.equal((await f.api("PUT", "/roles/sales", same)).status, 409);
  const log = (
    await f.api(
      "GET",
      "/audit-logs?objectId=sales&action=" +
        encodeURIComponent("调整角色权限与字段可见性"),
    )
  ).data.list[0];
  assert.equal(log.reason, "核对");
});

test("字段可见性按角色配置生效；老板固定全权限", () => {
  const base = {
    id: "u",
    nickname: "x",
    role: "customer",
    staff_status: "active",
    staff_id: "s",
  };
  const sales = userView({
    ...base,
    staff_role: "sales",
    role_permissions: '["inventory:view"]',
    role_visible_fields: '["cost"]',
  });
  assert.equal(canSee(sales, "cost"), true);
  assert.equal(canSee(sales, "wholesalePrice"), false);
  const legacy = userView({
    ...base,
    staff_role: "sales",
    role_permissions: "[]",
    role_visible_fields: null,
  });
  assert.equal(canSee(legacy, "wholesalePrice"), true);
  assert.equal(canSee(legacy, "cost"), false);
  const boss = userView({
    ...base,
    staff_role: "boss",
    role_permissions: "[]",
    role_visible_fields: "[]",
  });
  assert.ok(boss.permissions.includes("staff:manage"));
  assert.equal(canSee(boss, "cost"), true);
});

test("操作日志：筛选、按查看人字段权限脱敏、无权限拒绝", async () => {
  const objectId = "redact_" + Date.now();
  await f.admin.execute(
    "INSERT INTO audit_logs(actor_id,action,object_id,after_data,reason,request_id,ip) VALUES (?,?,?,?,?,?,?)",
    [
      f.users.boss,
      "脱敏验证",
      objectId,
      JSON.stringify({
        cost: 100,
        supplierId: "s1",
        retail: 150,
        nested: { profit: 50 },
      }),
      "验证",
      "req",
      "127.0.0.1",
    ],
  );
  const asBoss = (await f.api("GET", "/audit-logs?objectId=" + objectId)).data
    .list[0];
  assert.equal(asBoss.after.cost, 100);
  assert.equal(asBoss.actorName, "验证boss");
  const asManager = (
    await f.api("GET", "/audit-logs?objectId=" + objectId, undefined, "manager")
  ).data.list[0];
  assert.equal(asManager.after.cost, "无权限查看");
  assert.equal(asManager.after.nested.profit, "无权限查看");
  assert.equal(asManager.after.supplierId, "s1");
  assert.equal(asManager.after.retail, 150);
  assert.equal(
    (await f.api("GET", "/audit-logs", undefined, "sales")).status,
    403,
  );
  const filters = (await f.api("GET", "/audit-logs/filters")).data;
  assert.ok(filters.actions.includes("脱敏验证"));
  assert.equal((await f.api("GET", "/audit-logs?from=2026/11/01")).status, 400);
});
