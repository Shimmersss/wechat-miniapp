const test = require("node:test"),
  assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture } = require("./helpers"),
  { client, page } = require("./page-helpers");
const staffPkg = "miniprogram/packages/staff/";
let f, boss;
test.before(async () => {
  f = await fixture(["boss", "manager"]);
  boss = client(f, "boss");
});
test.after(async () => f?.close());

test("员工页面：新增、改角色、停用；角色页面保存；日志页面按动作筛选并展开", async () => {
  const people = page(staffPkg + "staff/index.js", boss);
  await people.onLoad();
  people.onCreate();
  const phone = "136" + String(crypto.randomInt(0, 100000000)).padStart(8, "0");
  Object.assign(people.data.editor, { name: "页面店员", phone });
  await people.onSaveEditor();
  assert.equal(people.data.error, "");
  assert.equal(people.data.editor, null);
  people.data.keyword = phone;
  await people.onSearch();
  const created = people.data.list[0];
  assert.equal(created.roleKey, "sales");
  people.onEdit({ currentTarget: { dataset: { id: created.id } } });
  people.data.editor.roleIndex = people.data.roles.findIndex(
    (r) => r.key === "warehouse",
  );
  await people.onSaveEditor();
  assert.equal(people.data.list[0].roleKey, "warehouse");
  await people.onToggle({ currentTarget: { dataset: { id: created.id } } });
  people.data.status = "";
  await people.onSearch();
  assert.equal(people.data.list[0].status, "disabled");
  assert.ok(people.confirmations.every((c) => c.needReason));

  const managerPeople = page(
    staffPkg + "staff/index.js",
    client(f, "manager"),
    "manager",
  );
  await managerPeople.onLoad();
  assert.ok(!managerPeople.data.roles.some((r) => r.key === "boss"));

  const roles = page(staffPkg + "staff/roles.js", boss);
  await roles.onLoad({ role: "engineer" });
  assert.equal(roles.data.canEdit, true);
  const before = roles.data.roles.find((r) => r.key === "engineer");
  roles.onToggleField({ currentTarget: { dataset: { key: "cost" } } });
  roles.onToggleField({ currentTarget: { dataset: { key: "cost" } } });
  assert.equal(roles.data.draft.dirty, true);
  await roles.onSave();
  assert.equal(roles.data.error, "");
  const after = roles.data.roles.find((r) => r.key === "engineer");
  assert.equal(after.version, before.version + 1);
  assert.deepEqual(after.visibleFields, before.visibleFields);
  await roles.onLoad({ role: "boss" });
  roles.onTogglePerm({ currentTarget: { dataset: { key: "stats:view" } } });
  assert.equal(roles.data.draft.dirty, false);

  const audit = page(staffPkg + "audit/index.js", boss);
  await audit.onLoad({ objectId: created.id });
  assert.ok(audit.data.list.some((a) => a.action === "停用员工"));
  const log = audit.data.list.find((a) => a.action === "调整员工资料或角色");
  audit.onExpand({ currentTarget: { dataset: { id: log.id } } });
  assert.equal(audit.data.expanded, log.id);
  assert.match(log.afterText, /warehouse/);
});
