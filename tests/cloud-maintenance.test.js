const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk") return { init() {} };
  return original.call(this, name, ...args);
};
const {
  day,
  allowed,
  triggerName,
  safeBackupKey,
} = require("../cloudfunctions/common/maintenance-runtime");
Module._load = original;
test("每日备份按北京时间02时切日，跨月跨年保持一致", () => {
  assert.equal(day(Date.parse("2026-11-09T17:59:59Z")), "2026-11-09");
  assert.equal(day(Date.parse("2026-11-09T18:00:00Z")), "2026-11-10");
  assert.equal(day(Date.parse("2026-12-31T18:00:00Z")), "2027-01-01");
});
test("知道或伪造Timer结构不足以执行维护，微信客户端即使传正确能力名仍拒绝", () => {
  const old = process.env.MAINTENANCE_KEY;
  process.env.MAINTENANCE_KEY = "unit-only-not-a-real-key";
  try {
    const valid = { Type: "Timer", TriggerName: triggerName() };
    assert.equal(allowed(valid, {}), true);
    assert.equal(allowed(valid, { OPENID: "actual-platform-user" }), false);
    assert.equal(allowed({ ...valid, TriggerName: "forged" }, {}), false);
    assert.equal(allowed({ ...valid, Type: "Client" }, {}), false);
  } finally {
    if (old === undefined) delete process.env.MAINTENANCE_KEY;
    else process.env.MAINTENANCE_KEY = old;
  }
});
test("备份写入路径仅允许内部规范键，拒绝跨目录或客户端传入的存储路径", () => {
  const id = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    safeBackupKey("daily/2026-11-10/" + id + "/tables/audit_logs/1.json.gz"),
    true,
  );
  assert.equal(safeBackupKey("daily/2026-11-10/" + id + "/media/" + id), true);
  for (const key of [
    "../files",
    "daily/2026-11-10/" + id + "/tables/../../secret",
    "xiamu-internal/object",
    "daily/2026-11-10/../complete.json",
  ])
    assert.equal(safeBackupKey(key), false);
});
test("归档原始PG JSON文本经gzip及RPC字符串包装不损失64位整数", () => {
  const zlib = require("node:zlib"),
    payload =
      '{"table":"audit_logs","rows":[{"id":9007199254740993,"amount":123.45}]}';
  const raw = zlib.gunzipSync(zlib.gzipSync(Buffer.from(payload))).toString();
  const rpc = JSON.parse(JSON.stringify({ p_data: { payload: raw } }));
  assert.equal(rpc.p_data.payload, payload);
  assert.ok(rpc.p_data.payload.includes("9007199254740993"));
});

function gcHarness(authorized, status) {
  const fs = require("node:fs"),
    vm = require("node:vm");
  const actions = [];
  let deletes = 0;
  const gateway = {
    rpc: async (_, data) => {
      actions.push(data);
      if (data.p_action === "take")
        return {
          tasks: [
            {
              id: "task",
              lease: "lease",
              bucket: "xiamu-staging",
              key: "object",
            },
          ],
        };
      if (data.p_action === "authorize") return { allowed: authorized };
      return {};
    },
    fail: (_, message) => {
      throw Error(message);
    },
  };
  const context = {
    module: { exports: {} },
    require: (name) =>
      name === "./gateway"
        ? gateway
        : name === "./pg-storage"
          ? {
              objectPath: (bucket, key) => bucket + "/" + key,
              request: async () => {
                deletes++;
                return { ok: status === 200, status };
              },
            }
          : require(name),
  };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../cloudfunctions/common/maintenance-runtime"),
      "utf8",
    ),
    context,
  );
  return {
    run: context.module.exports.gcStep,
    actions,
    deletes: () => deletes,
  };
}

test("云存储删除失败不得确认清理成功，释放任务供重试", async () => {
  const h = gcHarness(true, 503);
  await assert.rejects(h.run(), /未标记成功/);
  assert.equal(h.deletes(), 1);
  assert.deepEqual(
    h.actions.map((a) => a.p_action),
    ["take", "authorize", "fail"],
  );
});

test("取得租约后保护条件变化时不删除对象，只记跳过", async () => {
  const h = gcHarness(false, 200);
  await h.run();
  assert.equal(h.deletes(), 0);
  assert.equal(h.actions.at(-1).p_action, "ack");
  assert.equal(h.actions.at(-1).p_data.skipped, true);
});
