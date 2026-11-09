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
const { period, prepare } = require("../cloudfunctions/common/report-input"),
  { metric } = require("../cloudfunctions/common/report-view"),
  { render, csvCell } = require("../cloudfunctions/common/report-csv"),
  { redact } = require("../cloudfunctions/common/audit-view");
Module._load = original;
const user = {
  role: "sales",
  visibleFields: [],
  permissions: ["dashboard:view"],
};
test("云统计按北京时间周一与月底划期，起止包含末日且最多366天", () => {
  assert.deepEqual(
    period({ range: "week" }, new Date("2026-11-08T16:01:00Z")),
    { start: "2026-11-08T16:00:00.000Z", end: "2026-11-09T16:00:00.000Z" },
  );
  assert.equal(
    period({ range: "month" }, new Date("2026-11-30T16:01:00Z")).start,
    "2026-11-30T16:00:00.000Z",
  );
  assert.throws(() => period({ from: "2026-02-30", to: "2026-03-01" }));
  assert.throws(() => period({ from: "2025-01-01", to: "2026-01-02" }));
  assert.throws(() => period({ from: "2026-01-01" }));
  assert.equal(
    prepare("dashboard", { range: "month", engineerId: "foreign" }, {}).d
      .engineerId,
    undefined,
  );
  assert.throws(() =>
    prepare(
      "audit.list",
      { actorId: "------------------------------------" },
      {},
    ),
  );
});
test("云统计利润需同时有字段与权限，差价退款净额不减少销售台次", () => {
  const raw = { amount: 900, cost: 700, sold: 1, returned: 0, refund: 100 };
  assert.equal(metric(raw, user).profit, undefined);
  assert.equal(
    metric(raw, { ...user, visibleFields: ["profit"] }).profit,
    undefined,
  );
  assert.equal(
    metric(raw, {
      ...user,
      visibleFields: ["profit"],
      permissions: ["profit:view"],
    }).profit,
    200,
  );
  assert.equal(metric(raw, user).qty, 1);
});
test("云导出复核当前字段与快照权限，数字负数不作公式转义，文本公式安全", () => {
  assert.equal(csvCell(" =1+1"), '"\' =1+1"');
  assert.equal(csvCell(-1.25), "-1.25");
  const payload = {
    costAccess: true,
    profitAccess: true,
    rows: [{ name: "=SUM(1,2)", cost: 700, profit: 200, amount: 900 }],
  };
  const boss = {
    role: "boss",
    visibleFields: ["cost", "profit"],
    permissions: ["profit:view"],
  };
  assert.ok(render(payload, boss).includes("净成本"));
  assert.ok(render(payload, boss).includes("'=SUM"));
  assert.ok(!render(payload, user).includes("净成本"));
  assert.ok(
    !render(
      { ...payload, costAccess: false, profitAccess: false },
      boss,
    ).includes("净毛利"),
  );
  assert.throws(() =>
    prepare("export.create", { requestKey: "x", reason: "" }, {}),
  );
});
test("云审计按旧端规则递归裁剪数组/对象，不改变非敏感原因与普通字段", () => {
  const v = redact(
    {
      items: [
        {
          cost: 123,
          supplierId: "private",
          imei1: "private",
          internalNote: "private",
          wholesale: 100,
          agent_base: 80,
          name: "设备",
        },
      ],
      reason: "实际操作",
    },
    user,
  );
  assert.equal(v.items[0].name, "设备");
  for (const k of [
    "cost",
    "supplierId",
    "imei1",
    "internalNote",
    "wholesale",
    "agent_base",
  ])
    assert.equal(v.items[0][k], "无权限查看");
  assert.equal(v.reason, "实际操作");
});
test("云导出文件只用签名地址下载，失败不返回文件或附带员工令牌", async () => {
  const { writeReport } = require("../miniprogram/utils/report-file");
  const calls = [];
  global.wx = {
    env: { USER_DATA_PATH: "/private" },
    getFileSystemManager: () => ({ access: (o) => o.success() }),
    downloadFile: (o) => {
      calls.push(o);
      o.success({ statusCode: 200 });
    },
  };
  assert.equal(
    await writeReport({ id: "report-id", url: "https://storage.test/signed" }),
    "/private/reports/report-id.csv",
  );
  assert.equal(calls[0].header, undefined);
  global.wx.downloadFile = (o) => o.success({ statusCode: 403 });
  await assert.rejects(
    writeReport({ id: "report-id", url: "https://storage.test/signed" }),
    /403/,
  );
  await assert.rejects(
    writeReport({ id: "../unsafe", url: "https://storage.test/signed" }),
  );
});
