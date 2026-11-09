#!/usr/bin/env node
/** 访问设备主键优化：真实PG执行计划 + 已部署微信SDK边界/重试验证，仅新增三条隔离访问事件，不改员工身份。 */
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
process.chdir(root);
const local = ".local/cloudbase";
function control(tool, args) {
  const listing = execFileSync("tcb", ["env", "list", "--json"], {
      encoding: "utf8",
    }),
    envId = JSON.parse(listing.slice(listing.indexOf("{"))).data[0].EnvId;
  let raw;
  try {
    raw = execFileSync(
      "npx",
      [
        "-y",
        "mcporter",
        "call",
        "--stdio",
        "npx -y @cloudbase/cloudbase-mcp@latest",
        tool,
        "--args",
        JSON.stringify({ ...args, envId }),
        "--output",
        "json",
      ],
      { encoding: "utf8", maxBuffer: 3e6 },
    );
  } catch (e) {
    if (!e.stdout) throw Error("管理查询失败");
    raw = String(e.stdout);
  }
  const r = JSON.parse(raw.slice(raw.indexOf("{")));
  if (!r.success) throw Error(r.message);
  return r;
}
function evaluate(fn, args) {
  const file = path.join(root, local + "/visit-index-eval.json");
  fs.writeFileSync(file, JSON.stringify(args), { mode: 0o600 });
  const raw = execFileSync(
    "wechatide",
    [
      "-c",
      "Codex",
      "automation_evaluate",
      "--project",
      root,
      "--fn-source",
      fn,
      "--args-file",
      file,
    ],
    { encoding: "utf8", maxBuffer: 1e6 },
  );
  const r = JSON.parse(raw.slice(raw.indexOf("{")));
  assert.equal(r.ok, true);
  assert.equal(r.result.success, true);
  return r.result.result.result;
}
(async () => {
  const id = control("queryPgDatabase", {
    action: "sql",
    sql: "SELECT id FROM units LIMIT 1",
  }).data.rows[0].id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const plans = [];
  for (const predicate of [`id::text=lower('${id}')`, `id='${id}'::uuid`]) {
    const r = control("queryPgDatabase", {
      action: "sql",
      sql: `EXPLAIN (FORMAT JSON) SELECT 1 FROM units WHERE ${predicate}`,
    });
    let p = Object.values(r.data.rows[0])[0];
    if (typeof p === "string") p = JSON.parse(p);
    plans.push(p[0].Plan);
  }
  assert.ok(plans[1]["Index Cond"], "新谓词必须成为索引条件");
  assert.equal(plans[1]["Index Name"], "units_pkey");
  assert.equal(plans[0]["Index Cond"], undefined);
  const tag = crypto.randomUUID(),
    ids = [
      id,
      id.toUpperCase(),
      "invalid-device-id",
      crypto.randomUUID(),
      id.replaceAll("-", ""),
      "{" + id + "}",
      null,
    ];
  const events = ids.map((unitId, i) => ({
    eventId: "index_" + tag + "_" + i,
    type: "pv",
    route: "packages/shop/product/index",
    ...(unitId ? { unitId } : {}),
  }));
  const statusText = execFileSync(
    "wechatide",
    ["-c", "Codex", "check_wechatide_status", "--skill-version", "0.3.11"],
    { encoding: "utf8" },
  );
  const status = JSON.parse(statusText.slice(statusText.indexOf("{"))).result;
  assert.ok(["equal", "agent_ahead"].includes(status.versionRelation));
  assert.equal(status.loginExpired, false);
  const actual = evaluate(
    async function (i) {
      const data = { visitorId: "visitor_index_" + i.tag, events: i.events };
      const invoke = async () =>
        (
          await wx.cloud.callFunction({
            name: "customer",
            data: {
              path: "/visits/batch",
              method: "POST",
              data,
              headers: { "X-Channel": "" },
            },
          })
        ).result;
      return { first: await invoke(), retry: await invoke() };
    }.toString(),
    [{ tag, events }],
  );
  assert.equal(actual.first.code, 0, actual.first.message);
  assert.deepEqual(actual.first.data, { accepted: 3, ignored: 4 });
  assert.equal(actual.retry.code, 0);
  assert.deepEqual(actual.retry.data, { accepted: 0, ignored: 7 });
  const safe = plans.map((p) =>
    Object.fromEntries(
      Object.entries(p)
        .filter(([k]) =>
          [
            "Node Type",
            "Index Name",
            "Relation Name",
            "Plan Rows",
            "Startup Cost",
            "Total Cost",
            "Filter",
            "Index Cond",
          ].includes(k),
        )
        .map(([k, v]) => [
          k,
          typeof v === "string" ? v.replaceAll(id, "[unit-id]") : v,
        ]),
    ),
  );
  const result = {
    passed: true,
    before: safe[0],
    after: safe[1],
    wechat: { first: actual.first.data, retry: actual.retry.data },
    cases: [
      "规范UUID",
      "大写UUID",
      "非法字符串",
      "不存在的规范UUID",
      "无分隔符写法",
      "花括号写法",
      "无设备事件",
    ],
    boundary:
      "EXPLAIN为计划估计，不是EXPLAIN ANALYZE或负载延迟测试；只有查询参数强转，旧文本匹配语义保留。",
  };
  fs.writeFileSync(
    local + "/visit-index-results.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
