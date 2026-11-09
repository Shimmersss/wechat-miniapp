#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的统计导出与审计集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-reports.js。使用已登录 tcb/mcporter、functions.env。
 * 创建带随机标识的验证员工/分类/型号/单机；保留数据和审计作为验证证据，不自动删除。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
process.chdir(root);
execFileSync(process.execPath, ["scripts/sync-cloudfunctions.js"]);
const local = ".local/cloudbase";
fs.mkdirSync(local, { recursive: true });
const variables = Object.fromEntries(
  fs
    .readFileSync(`${local}/functions.env`, "utf8")
    .split("\n")
    .map((x) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(x.trim()))
    .filter(Boolean)
    .map((x) => [x[1], x[2]]),
);
const listing = execFileSync("tcb", ["env", "list", "--json"], {
  encoding: "utf8",
});
const envId = JSON.parse(listing.slice(listing.indexOf("{"))).data[0].EnvId;
process.env.TCB_ENV = envId;
process.env.CLOUDBASE_API_KEY = variables.CLOUDBASE_API_KEY;
process.env.OTP_HASH_KEY = variables.OTP_HASH_KEY;
process.env.WHOLESALE_DISCOUNT = variables.WHOLESALE_DISCOUNT || "0";
if (!process.env.CLOUDBASE_API_KEY) throw new Error("缺少 CLOUDBASE_API_KEY");
function control(tool, args) {
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
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (e) {
    if (!e.stdout) throw Error("CloudBase control request failed");
    raw = String(e.stdout);
  }
  const result = JSON.parse(raw.slice(raw.indexOf("{")));
  if (!result.success) throw new Error(result.message || result.errorCode);
  return result;
}
const fixture = {
  tag: crypto.randomUUID(),
  uid: crypto.randomUUID(),
  token: crypto.randomBytes(32).toString("hex"),
};
fixture.openid = "stock-verification-" + fixture.tag;
const phone = "199" + String(Date.now()).slice(-8);
control("managePgDatabase", {
  action: "execute",
  confirm: true,
  sql: `
 INSERT INTO users(id,openid,nickname) VALUES('${fixture.uid}','${fixture.openid}','库存迁移验证');
 INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${crypto.randomUUID()}','${fixture.uid}','${phone}','库存迁移验证','boss');
 INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash("sha256").update(fixture.token).digest("hex")}','${fixture.uid}','staff',now()+interval '2 hours');`,
});
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === "wx-server-sdk")
    return {
      init() {},
      DYNAMIC_CURRENT_ENV: "test",
      getWXContext: () => ({ OPENID: fixture.openid }),
    };
  return original.call(this, name, ...args);
};
const stock = require("../cloudfunctions/staff-stock").main;
const sales = require("../cloudfunctions/staff-sales").main;
const reports = require("../cloudfunctions/staff-reports").main;
const shop = require("../cloudfunctions/shop").main;
const agent = require("../cloudfunctions/agent").main;

Module._load = original;
const results = [],
  key = () => crypto.randomUUID(),
  execute = (sql) =>
    control("managePgDatabase", { action: "execute", confirm: true, sql }),
  query = (sql) =>
    control("queryPgDatabase", { action: "sql", sql, limit: 100 }).data.rows;
const raw = (fn, url, method = "GET", data = {}) =>
  fn(
    {
      path: url,
      method,
      data,
      headers: { Authorization: "Bearer " + fixture.token },
    },
    { request_id: "reports-verify-" + fixture.tag },
  );
async function call(fn, url, method = "GET", data = {}, expected = 0) {
  const r = await raw(fn, url, method, data);
  assert.equal(r.code, expected, JSON.stringify(r));
  return r.data;
}
const imei = () => {
  const s = "35" + String(crypto.randomInt(1e12)).padStart(12, "0");
  let n = 0;
  for (let i = 0; i < 14; i++) {
    const d = +s[i] * (i % 2 ? 2 : 1);
    n += Math.floor(d / 10) + (d % 10);
  }
  return s + ((10 - (n % 10)) % 10);
};
const DAY = 86400000,
  anchor =
    Date.UTC(2200, 0, 1) +
    (parseInt(fixture.tag.slice(0, 8), 16) % (6000 * 365)) * DAY,
  period = {
    from: new Date(anchor).toISOString().slice(0, 10),
    to: new Date(anchor + DAY).toISOString().slice(0, 10),
  },
  start = Date.parse(period.from + "T00:00:00+08:00"),
  stamp = (n) => new Date(start + n).toISOString();
async function csv(report) {
  const r = await fetch(report.url);
  assert.ok(r.ok, "实际CSV必须可下载");
  return Buffer.from(await r.arrayBuffer()).toString("utf8");
}
async function extraChecks() {
  const prior = JSON.parse(fs.readFileSync(`${local}/reports-fixture.json`));
  const agentFixture = JSON.parse(
    fs.readFileSync(`${local}/agent-fixture.json`),
  );
  const canonical = await call(agent, "/admin/agent-earnings", "GET", {
    agentId: agentFixture.agentId,
  });
  const recon = await call(reports, "/stats/agent-earnings", "GET", {
    from: "2026-11-01",
    to: "2026-11-30",
  });
  const row = recon.list.find((x) => x.agentId === agentFixture.agentId);
  assert.ok(row);
  assert.equal(row.pending, canonical.summary.pendingAmount);
  assert.equal(row.settled, canonical.summary.settledAmount);
  assert.ok(row.reversed > 0);
  assert.ok(row.pending < 0);
  assert.equal(row.net, Math.round((row.earned - row.reversed) * 100) / 100);
  const object = query(
    `SELECT name FROM storage.objects WHERE bucket_id='xiamu-reports' LIMIT 1`,
  )[0];
  assert.ok(object);
  const storage = require("../cloudfunctions/staff-reports/shared/pg-storage");
  const denied = await fetch(
    storage.origin() +
      "/v1/storages/object/" +
      storage.objectPath("xiamu-reports", object.name),
  );
  assert.ok(!denied.ok, "匿名不可直读报表");
  const policy = query(
    `SELECT policyname,permissive,roles::text,qual,with_check FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='xiamu_reports_server_only'`,
  )[0];
  assert.ok(policy);
  assert.equal(policy.permissive, "RESTRICTIVE");
  assert.ok(
    policy.roles.includes("anon") && policy.roles.includes("authenticated"),
  );
  assert.ok(policy.qual.includes("xiamu-reports"));
  const acl = execute(
    `SELECT has_table_privilege('service_role','public.report_exports','INSERT') ins,has_table_privilege('service_role','public.report_exports','UPDATE') upd,has_table_privilege('service_role','public.report_exports','DELETE') del,has_table_privilege('service_role','public.report_exports','TRUNCATE') trunc`,
  ).data.previewRows[0];
  const bool = (v) => v === true || v === "true";
  assert.equal(bool(acl.ins), true);
  for (const k of ["upd", "del", "trunc"]) assert.equal(bool(acl[k]), false);
  const old = Object.assign({}, fixture),
    other = {
      uid: key(),
      openid: "reports-other-" + key(),
      token: crypto.randomBytes(32).toString("hex"),
    };
  const exportId = query(
    `SELECT id FROM report_exports WHERE actor_id='${prior.uid}' LIMIT 1`,
  )[0].id;
  execute(
    `INSERT INTO users(id,openid,nickname) VALUES('${other.uid}','${other.openid}','报表隔离验证');INSERT INTO staff(id,user_id,phone,name,role_key) VALUES('${key()}','${other.uid}','199${String(Date.now()).slice(-8)}','隔离验证','boss');INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash("sha256").update(other.token).digest("hex")}','${other.uid}','staff',now()+interval '2 hours')`,
  );
  try {
    Object.assign(fixture, other);
    await call(reports, "/stats/exports/" + exportId, "GET", {}, 404);
  } finally {
    Object.assign(fixture, old);
  }
  const result = {
    passed: true,
    agentReconciliation: {
      pending: row.pending,
      settled: row.settled,
      reversed: row.reversed,
      net: row.net,
    },
    anonymousObjectStatus: denied.status,
    storagePolicy: policy,
    exportAppendOnly: acl,
    otherStaffDenied: 404,
  };
  fs.writeFileSync(
    `${local}/reports-extra-results.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
}
if (process.argv.includes("--extra"))
  extraChecks().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
else
  (async () => {
    const base = await call(stock, "/templates/t_phone"),
      cat = await call(stock, "/catalog/categories", "POST", {
        label: "统计" + fixture.tag.slice(0, 8),
        copyTemplateId: base.id,
      }),
      fields = base.fields.map((f) =>
        ["supplier", "receipt"].includes(f.key) ? { ...f, required: false } : f,
      ),
      template = await call(
        stock,
        "/templates/" + cat.templateId + "/versions",
        "POST",
        { baseVersion: 1, fields },
      ),
      model = await call(stock, "/models", "POST", {
        category: cat.value,
        name: "=SUM(1,2)_" + fixture.tag,
        brandLabel: "报表验证",
        series: "统计",
      }),
      attrs = Object.fromEntries(
        fields
          .filter((f) => f.required || f.default !== undefined)
          .map((f) => [
            f.key,
            f.default !== undefined
              ? f.default
              : f.type === "select"
                ? f.options[0]
                : f.type === "number"
                  ? 90
                  : "验证",
          ]),
      );
    const baseline = await call(reports, "/stats/overview", "GET", {
      from: period.from,
      to: period.from,
    });
    const units = [];
    for (const [cost, retail] of [
      [1000, 1500],
      [300, 500],
      [800, 1200],
    ])
      units.push(
        await call(stock, "/inbound/units", "POST", {
          modelId: model.id,
          templateVersion: template.version,
          inspectionConfirmed: true,
          attributes: attrs,
          imei1: imei(),
          cost,
          retail,
          wholesale: retail,
          agentBase: retail,
        }),
      );
    const sale = async (un) =>
      call(sales, "/sales-orders", "POST", {
        requestKey: key(),
        items: [{ unitId: un.id, priceVersion: 1 }],
        paymentConfirmed: true,
        payMethod: "现金",
      });
    const first = await sale(units[0]),
      second = await sale(units[1]);
    const firstDetail = await call(sales, "/sales-orders/" + first.id),
      secondDetail = await call(sales, "/sales-orders/" + second.id);
    let firstState = await call(
      sales,
      "/sales-orders/" + first.id + "/refund",
      "POST",
      {
        requestKey: key(),
        kind: "adjustment",
        reason: "跨日差价退款验证",
        items: [{ itemId: firstDetail.items[0].id, amount: 100 }],
      },
    );
    const adjustment = firstState.refunds[0].id;
    firstState = await call(
      sales,
      "/sales-orders/" + first.id + "/refund",
      "POST",
      {
        requestKey: key(),
        kind: "return",
        reason: "跨日整机退货验证",
        items: [{ itemId: firstDetail.items[0].id }],
      },
    );
    const returned = firstState.refunds.find((x) => x.id !== adjustment).id;
    execute(
      `UPDATE units SET created_at='${stamp(-DAY)}' WHERE id IN('${units[0].id}','${units[1].id}');UPDATE units SET created_at=now()-interval '40 days' WHERE id='${units[2].id}';UPDATE sales_orders SET created_at=CASE id WHEN '${first.id}'::uuid THEN '${stamp(0)}'::timestamptz ELSE '${stamp(DAY)}'::timestamptz END WHERE id IN('${first.id}','${second.id}');UPDATE sales_refunds SET created_at=CASE id WHEN '${adjustment}'::uuid THEN '${stamp(8 * 3600000)}'::timestamptz ELSE '${stamp(DAY + 8 * 3600000)}'::timestamptz END WHERE id IN('${adjustment}','${returned}');UPDATE inventory_ledger SET created_at=CASE WHEN to_status='sold' THEN CASE unit_id WHEN '${units[0].id}'::uuid THEN '${stamp(0)}'::timestamptz ELSE '${stamp(DAY)}'::timestamptz END WHEN to_status='recheck' THEN '${stamp(DAY + 8 * 3600000)}'::timestamptz ELSE '${stamp(-DAY)}'::timestamptz END WHERE unit_id IN('${units[0].id}','${units[1].id}')`,
    );
    const day2 = await call(reports, "/stats/overview", "GET", {
      from: period.from,
      to: period.from,
    });
    assert.equal(day2.amount, 1400);
    assert.equal(day2.profit, 400);
    assert.equal(day2.qty, 1);
    assert.equal(day2.returnedQty, 0);
    assert.equal(day2.openingStock, baseline.openingStock + 3);
    const combined = await call(reports, "/stats/overview", "GET", period);
    assert.equal(combined.amount, 500);
    assert.equal(combined.profit, 200);
    assert.equal(combined.qty, 2);
    assert.equal(combined.returnedQty, 1);
    assert.equal(combined.refundAmount, 1500);
    results.push(
      "实际收款/差价退款/退货跨北京时间边界统计，期初库存与毛利口径正确",
    );
    const trend = await call(reports, "/stats/trend", "GET", period);
    assert.deepEqual(
      trend.list.map((x) => x.amount),
      [1400, -900],
    );
    const empty = await call(reports, "/stats/trend", "GET", {
      from: "2092-01-01",
      to: "2092-01-03",
    });
    assert.equal(empty.list.length, 3);
    assert.ok(empty.list.every((x) => x.amount === 0));
    for (const dimension of ["model", "staff", "store"]) {
      const b = await call(reports, "/stats/breakdown", "GET", {
        ...period,
        dimension,
      });
      assert.equal(
        b.list.reduce((n, x) => n + x.amount, 0),
        500,
      );
    }
    results.push("销售趋势补零和型号/员工/门店拆分，与净额总计一致");
    const visits = await call(reports, "/stats/visits", "GET", period);
    assert.equal(visits.pv, 0);
    assert.equal(visits.uv, 0);
    assert.ok(
      (await call(reports, "/stats/visit-trend", "GET", period)).list.every(
        (x) => x.pv === 0,
      ),
    );
    const realVisits = await call(reports, "/stats/visits");
    assert.ok(realVisits.pv >= 3);
    assert.ok(realVisits.consultRequests >= 1);
    assert.equal(realVisits.phone, undefined);
    results.push("真实访问/咨询数据汇总、空期UV/PV补零，统计不返回联系方式");
    const dashboard = await call(reports, "/staff/dashboard");
    assert.ok(dashboard.todos.some((x) => x.key === "loanOverdue"));
    assert.ok(dashboard.todos.some((x) => x.key === "agentEarnings"));
    assert.ok(dashboard.repair);
    const ageing = await call(reports, "/stats/ageing", "GET", {
      days: 31,
      pageSize: 1000,
    });
    assert.ok(ageing.list.some((x) => x.id === units[2].id));
    await call(reports, "/stats/agent-earnings", "GET", period);
    results.push(
      "工作台真实库存、维修/借还/代理待办与库龄查询，代理对账读取真实状态",
    );
    const exportBody = {
      requestKey: key(),
      from: period.from,
      to: period.from,
      reason: "实际报表对账验证",
    };
    await call(
      reports,
      "/stats/export",
      "POST",
      { ...exportBody, reason: "" },
      400,
    );
    const exports = await Promise.all(
      [1, 2].map(() => call(reports, "/stats/export", "POST", exportBody)),
    );
    assert.equal(exports[0].id, exports[1].id);
    const meta = exports[0],
      content = await call(reports, "/stats/exports/" + meta.id),
      text = await csv(content);
    assert.equal(meta.rows, 2);
    assert.ok(text.startsWith("\uFEFF"));
    assert.ok(text.includes("'=SUM(1,2)_"));
    assert.ok(text.includes("净成本"));
    assert.ok(text.includes("净毛利"));
    results.push(
      "真实并发导出幂等、原因审计、私有Storage实际上传下载、UTF8 BOM与公式转义",
    );
    await call(
      reports,
      "/stats/export",
      "POST",
      { ...exportBody, reason: "冲突内容" },
      409,
    );
    const priorId = fixture.openid;
    fixture.openid = "different-platform";
    await call(reports, "/stats/exports/" + meta.id, "GET", {}, 401);
    fixture.openid = priorId;
    execute(
      `UPDATE staff SET role_key='manager' WHERE user_id='${fixture.uid}'`,
    );
    const lower = await csv(await call(reports, "/stats/exports/" + meta.id));
    assert.ok(!lower.includes("净成本"));
    assert.ok(!lower.includes("净毛利"));
    assert.notEqual(lower, text);
    execute(`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`);
    await call(reports, "/stats/export", "POST", exportBody, 403);
    const lowStats = await call(reports, "/stats/overview", "GET", period);
    assert.equal(lowStats.profit, undefined);
    const lowDash = await call(reports, "/staff/dashboard");
    assert.equal(lowDash.inventory.stockCost, undefined);
    assert.equal(lowDash.sales.profit, undefined);
    await call(reports, "/audit-logs", "GET", {}, 403);
    await call(reports, "/stats/agent-earnings", "GET", {}, 403);
    execute(`UPDATE staff SET role_key='boss' WHERE user_id='${fixture.uid}'`);
    results.push(
      "下载重新鉴权与降权重新裁列、销售无导出/审计/代理对账权限，工作台成本毛利裁剪",
    );
    const nextRefund = await call(
      sales,
      "/sales-orders/" + second.id + "/refund",
      "POST",
      {
        requestKey: key(),
        kind: "adjustment",
        reason: "快照后新增退款",
        items: [{ itemId: secondDetail.items[0].id, amount: 10 }],
      },
    );
    execute(
      `UPDATE sales_refunds SET created_at='${stamp(9 * 3600000)}' WHERE id='${nextRefund.refunds[0].id}'`,
    );
    assert.equal(
      await csv(await call(reports, "/stats/exports/" + meta.id)),
      text,
    );
    results.push("导出固定快照不随后续退款变化，缓存按裁剪后内容分开存储");
    execute(
      `INSERT INTO audit_logs(actor_id,action,object_id,before_data,after_data,reason,request_id) VALUES('${fixture.uid}','报表嵌套裁剪验证','${fixture.tag}','{"rows":[{"cost":9876,"profit":1234,"name":"公开名称"}]}','{}','保留实际原因','reports-verify-${fixture.tag}')`,
    );
    const audit = await call(reports, "/audit-logs", "GET", {
      actorId: fixture.uid,
      objectId: fixture.tag,
    });
    assert.equal(audit.total, 1);
    assert.equal(audit.list[0].before.rows[0].cost, 9876);
    assert.equal(audit.list[0].reason, "保留实际原因");
    const filters = await call(reports, "/audit-logs/filters");
    assert.ok(filters.actions.includes("报表嵌套裁剪验证"));
    execute(
      `UPDATE staff SET role_key='manager' WHERE user_id='${fixture.uid}'`,
    );
    const hidden = await call(reports, "/audit-logs", "GET", {
      objectId: fixture.tag,
    });
    assert.equal(hidden.list[0].before.rows[0].cost, "无权限查看");
    assert.equal(hidden.list[0].before.rows[0].name, "公开名称");
    execute(`UPDATE staff SET role_key='boss' WHERE user_id='${fixture.uid}'`);
    results.push("实际审计筛选/操作人/分页和嵌套数据裁剪，原因与普通字段保留");
    const auditCount = query(
      `SELECT count(*) n FROM audit_logs WHERE action='导出销售退款报表' AND object_id='${meta.id}'`,
    )[0];
    assert.equal(Number(auditCount.n), 1);
    execute(
      `UPDATE report_exports SET expires_at=now()-interval '1 second' WHERE id='${meta.id}'`,
    );
    await call(reports, "/stats/exports/" + meta.id, "GET", {}, 410);
    await call(reports, "/stats/export", "POST", exportBody, 410);
    results.push("导出审计恰一条、15分钟快照到期拒绝下载和重放");
    const grants = query(
      `SELECT p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('report_sales_events','report_overview','report_visits','report_agent_earnings','api_reports','api_report_export')`,
    );
    assert.equal(grants.length, 6);
    for (const g of grants) {
      assert.ok([false, "false"].includes(g.prosecdef));
      assert.ok([false, "false"].includes(g.anon));
      assert.ok([false, "false"].includes(g.authenticated));
      assert.ok([true, "true"].includes(g.service));
    }
    results.push("六个新RPC/辅助函数实际INVOKER与service_role独占授权核对");
    fs.writeFileSync(
      `${local}/reports-fixture.json`,
      JSON.stringify({
        ...fixture,
        modelId: model.id,
        saleId: first.id,
        period,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      `${local}/reports-results.json`,
      JSON.stringify(
        {
          passed: results,
          grants,
          metrics: { day2, combined },
          csv: {
            rows: 2,
            bom: true,
            formulaEscaping: true,
            currentPermissionCrop: true,
          },
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, checks: results }));
  })().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
