#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的代理订单集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-agents.js。使用已登录 tcb/mcporter、functions.env。
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
process.env.WHOLESALE_DISCOUNT = variables.WHOLESALE_DISCOUNT || "0";
if (!process.env.CLOUDBASE_API_KEY) throw new Error("缺少 CLOUDBASE_API_KEY");
function control(tool, args) {
  const raw = execFileSync(
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
const files = require("../cloudfunctions/files").main;
const shop = require("../cloudfunctions/shop").main;
const agent = require("../cloudfunctions/agent").main;
const expiry = require("../cloudfunctions/agent-expiry").main;
Module._load = original;
// 32MiB上限在已部署函数通过真实微信SDK分段验收；本运行器不搬运整份大文件。
const results = [],
  evidence = {};
const raw = (handler, path, method = "GET", data = {}, token = fixture.token) =>
  handler(
    {
      path,
      method,
      data,
      headers: token ? { Authorization: "Bearer " + token } : {},
    },
    { request_id: "agents-verify-" + fixture.tag },
  );
async function call(
  handler,
  path,
  method = "GET",
  data = {},
  expected = 0,
  token = fixture.token,
) {
  const r = await raw(handler, path, method, data, token);
  assert.equal(r.code, expected, JSON.stringify(r));
  return r.data;
}
const png = fs.readFileSync("miniprogram/assets/brands/apple.png");
async function upload(bytes, scope = "internal", key = crypto.randomUUID()) {
  const intent = await call(files, "/files/upload-intent", "POST", {
    scope,
    size: bytes.length,
    requestKey: key,
  });
  assert.ok(!intent.uploadUrl.includes(variables.CLOUDBASE_API_KEY));
  const sent = await fetch(intent.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  assert.ok(
    sent.ok,
    `upload ${sent.status}: ${(await sent.text()).slice(0, 200)}`,
  );
  let result = await call(
    files,
    "/files/" + intent.uploadId + "/complete",
    "POST",
  );
  let steps = 1;
  while (result.processing && steps < 130) {
    result = await call(
      files,
      "/files/" + intent.uploadId + "/complete",
      "POST",
    );
    steps++;
  }
  assert.ok(result.fileId, "核验未完成不得作为文件返回");
  return { intent, file: result, steps };
}
const key = () => crypto.randomUUID(),
  execute = (sql) =>
    control("managePgDatabase", { action: "execute", confirm: true, sql }),
  query = (sql) => control("queryPgDatabase", { action: "sql", sql }).data.rows;
const imei = () => {
  const s = "35" + String(crypto.randomInt(1e12)).padStart(12, "0");
  let n = 0;
  for (let i = 0; i < 14; i++) {
    let d = +s[i] * (i % 2 ? 2 : 1);
    n += Math.floor(d / 10) + (d % 10);
  }
  return s + ((10 - (n % 10)) % 10);
};
function user() {
  const id = crypto.randomUUID(),
    openid = "agent-verify-" + id,
    token = crypto.randomBytes(32).toString("hex");
  execute(
    `INSERT INTO users(id,openid,nickname) VALUES('${id}','${openid}','代理链路验证'); INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash("sha256").update(token).digest("hex")}','${id}','wechat',now()+interval '2 hours')`,
  );
  return { id, openid, token };
}
async function as(
  who,
  fn,
  url,
  method = "GET",
  data = {},
  expected = 0,
  headers = {},
) {
  const old = fixture.openid;
  fixture.openid = who.openid;
  const promise = fn(
    {
      path: url,
      method,
      data,
      headers: { Authorization: "Bearer " + who.token, ...headers },
    },
    { request_id: "agents-real-" + fixture.tag },
  );
  fixture.openid = old;
  const r = await promise;
  assert.equal(r.code, expected, JSON.stringify(r));
  return r.data;
}
async function extraChecks() {
  const f = JSON.parse(fs.readFileSync(`${local}/agent-fixture.json`)),
    first = f.agent,
    customer = user(),
    stranger = user();
  const form = await call(stock, "/models/" + f.modelId + "/form"),
    attrs = Object.fromEntries(
      form.fields
        .filter((x) => x.required || x.default !== undefined)
        .map((x) => [
          x.key,
          x.default !== undefined
            ? x.default
            : x.type === "select"
              ? x.options[0]
              : x.type === "number"
                ? 90
                : "验证",
        ]),
    );
  const make = (extra = {}) =>
    call(stock, "/inbound/units", "POST", {
      modelId: f.modelId,
      templateVersion: form.version,
      inspectionConfirmed: true,
      attributes: attrs,
      imei1: imei(),
      cost: 1000,
      retail: 1500,
      wholesale: 1400,
      agentBase: 1300,
      flags: { showInShop: true, sharePeer: true, shareAgent: true },
      ...extra,
    });
  const fresh = await make();
  await as(first, agent, "/agent/units/" + fresh.id + "/markup", "PUT", {
    markup: 80,
  });
  const units = { list: [{ id: fresh.id, priceVersion: 1 }] };
  const id = units.list.find((x) => x.id !== f.unitId).id;
  const link = await as(first, agent, "/share/links", "POST", {
    unitId: id,
    channel: "agent",
  });
  const body = {
    requestKey: key(),
    unitId: id,
    name: "并发顾客",
    phone: "199" + String(Date.now()).slice(-8),
  };
  const raced = await Promise.all(
    [customer, stranger].map((w) =>
      as(w, agent, "/shop/orders", "POST", body, 0, {
        "X-Channel": link.shareId,
      })
        .then((x) => ({ code: 0, data: x }))
        .catch((e) => ({
          code: /409/.test(e.message) ? 409 : 410,
          error: e.message,
        })),
    ),
  );
  assert.equal(
    raced.filter((x) => x.code === 0).length,
    1,
    JSON.stringify(raced),
  );
  const order = raced.find((x) => x.code === 0).data;
  const sale = await call(sales, "/sales-orders", "POST", {
    requestKey: key(),
    customerRequestId: order.id,
    items: [
      {
        unitId: id,
        channel: "agent",
        priceVersion: units.list.find((x) => x.id === id).priceVersion,
      },
    ],
    paymentConfirmed: true,
    payMethod: "现金",
  });
  const earned = (
    await call(agent, "/admin/agent-earnings", "GET", { agentId: first.id })
  ).list.find((x) => x.orderId === order.id);
  const settled = (
    await call(agent, "/admin/agent-earnings", "GET", {
      agentId: first.id,
      status: "settled",
    })
  ).list[0];
  assert.ok(settled);
  await call(
    agent,
    "/admin/agent-earnings/settle",
    "POST",
    { ids: [earned.id, settled.id], reason: "混合状态整批拒绝" },
    409,
  );
  assert.equal(
    (
      await call(agent, "/admin/agent-earnings", "GET", { agentId: first.id })
    ).list.find((x) => x.id === earned.id).status,
    "pending",
  );
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      raw(agent, "/admin/agent-earnings/settle", "POST", {
        ids: [earned.id],
        reason: "并发转账只记一次",
      }),
    ),
  );
  assert.deepEqual(concurrent.map((x) => x.code).sort(), [0, 409]);
  results.push(
    "同设备两个顾客并发下单只有一个成功；混合状态批量转账回滚；并发转账仅一次成功",
  );
  await call(agent, "/customer-requests", "GET");
  await as(customer, agent, "/shop/requests", "GET");
  assert.ok(
    (await call(agent, "/customer-requests", "GET", { kind: "order" })).total >=
      1,
  );
  const invalid = user();
  for (let i = 0; i < 10; i++)
    await as(
      invalid,
      agent,
      "/agent/applications",
      "POST",
      { agreed: false },
      400,
    );
  await as(
    invalid,
    agent,
    "/agent/applications",
    "POST",
    { agreed: false },
    429,
  );
  results.push("失败请求也受持久限频限制；意向列表按当前迁移支持不指定kind");
  const publicPhoto = await upload(png, "public"),
    internalPhoto = await upload(png, "internal");
  const still = await make({
    publicImages: [{ fileId: publicPhoto.file.fileId }],
    receiptImages: [{ fileId: internalPhoto.file.fileId }],
    internalNote: "不得公开的内部说明",
  });
  const detail = await call(stock, "/units/" + still.id);
  const media = await as(first, agent, "/share/links", "POST", {
    unitId: still.id,
    channel: "agent",
  });
  const exposed = await as(customer, agent, "/shop/shares/" + media.shareId);
  assert.equal(exposed.units[0].images.length, 1);
  assert.ok((await fetch(exposed.units[0].images[0])).ok);
  const serialized = JSON.stringify(exposed);
  for (const secret of [
    internalPhoto.file.fileId,
    "不得公开的内部说明",
    detail.imei1,
  ])
    if (secret) assert.ok(!serialized.includes(secret));
  const poster = await as(
    customer,
    agent,
    "/share/links/" + media.shareId + "/poster",
  );
  assert.equal(poster.qrcodeStatus, "unconfigured");
  assert.equal(poster.qrcode, null);
  await as(first, agent, "/share/links/" + media.shareId + "/revoke", "PATCH", {
    reason: "验证撤销",
  });
  await as(customer, agent, "/shop/shares/" + media.shareId, "GET", {}, 404);
  results.push(
    "真实公开照片签名下载、内部凭证与完整串码不泄漏、缺微信凭据不生成二维码、撤销生效",
  );
  // 只用原始PG查询观察定时器，不调用任何会主动清理的业务接口。
  const expLink = await as(first, agent, "/share/links", "POST", {
    unitId: still.id,
    channel: "agent",
  });
  const expOrder = await as(
    customer,
    agent,
    "/shop/orders",
    "POST",
    { ...body, requestKey: key(), unitId: still.id },
    0,
    { "X-Channel": expLink.shareId },
  );
  execute(
    `UPDATE agent_orders SET lock_expires_at=now()-interval '1 second' WHERE request_id='${expOrder.id}'`,
  );
  let state;
  // 定时器每 10 分钟触发（见 deploy-cloudfunctions.js 的 EXPIRY_CRON），最多等 11 分钟。
  for (let i = 0; i < 132; i++) {
    state = query(
      `SELECT s.status,u.status unit_status FROM agent_order_states s JOIN agent_orders a ON a.request_id=s.request_id JOIN units u ON u.id=a.unit_id WHERE s.request_id='${expOrder.id}'`,
    )[0];
    if (state.status === "released") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  assert.equal(state.status, "released");
  assert.equal(state.unit_status, "in_stock");
  results.push(
    "已部署定时器自主释放过期订单：只观察PG，无手工调用或业务读触发",
  );
  fs.writeFileSync(
    `${local}/agent-extra-results.json`,
    JSON.stringify({ passed: results }, null, 2),
  );
  console.log(JSON.stringify({ results }));
}
async function securityChecks() {
  const flag = (v) => {
    assert.ok([true, false, "true", "false"].includes(v));
    return v === true || v === "true";
  };
  const funcs = query(
    `SELECT p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'agent_%' OR p.proname IN ('api_agents','stock_sale'))`,
  );
  assert.deepEqual(
    funcs.map((f) => f.proname).sort(),
    [
      "agent_rate_limit",
      "agent_person",
      "agent_active",
      "agent_public_unit",
      "agent_share_resolve",
      "agent_order_raw",
      "agent_request_raw",
      "agent_unlock",
      "agent_release_expired",
      "agent_earning_totals",
      "api_agents",
      "agent_sale_order",
      "stock_sale",
      "agent_shop_unit",
    ].sort(),
  );
  for (const f of funcs) {
    assert.equal(flag(f.prosecdef), false);
    assert.equal(flag(f.anon), false);
    assert.equal(flag(f.authenticated), false);
    assert.equal(flag(f.service), true);
  }
  const tableRows = execute(
    `SELECT jsonb_agg(q) rows FROM (SELECT c.relname,c.relrowsecurity,has_table_privilege('service_role',c.oid,'INSERT') ins,has_table_privilege('service_role',c.oid,'UPDATE') upd,has_table_privilege('service_role',c.oid,'DELETE') del,has_table_privilege('service_role',c.oid,'TRUNCATE') trunc,has_table_privilege('anon',c.oid,'SELECT') anon,has_table_privilege('authenticated',c.oid,'SELECT') authenticated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('agent_orders','agent_earnings','customer_requests','customer_request_events','sales_attributions','share_items','audit_logs')) q`,
  ).data.previewRows[0].rows;
  const tables =
    typeof tableRows === "string" ? JSON.parse(tableRows) : tableRows;
  assert.equal(tables.length, 7);
  for (const t of tables) {
    assert.equal(flag(t.relrowsecurity), true);
    assert.equal(flag(t.ins), true);
    for (const k of ["upd", "del", "trunc", "anon", "authenticated"])
      assert.equal(flag(t[k]), false, t.relname + ":" + k);
  }
  const settings = await call(agent, "/admin/agent-settings"),
    reason = "代理设置版本与审计验证";
  const raced = await Promise.all(
    [1, 2].map(() =>
      raw(agent, "/admin/agent-settings", "PUT", {
        defaultMarkupMax: settings.defaultMarkupMax,
        version: settings.version,
        reason,
      }),
    ),
  );
  assert.deepEqual(raced.map((x) => x.code).sort(), [0, 409]);
  const audit = query(
    `SELECT before_data,after_data,reason FROM audit_logs WHERE request_id='agents-verify-${fixture.tag}' AND action='调整代理默认加价上限'`,
  );
  for (const row of audit)
    for (const k of ["before_data", "after_data"])
      if (typeof row[k] === "string") row[k] = JSON.parse(row[k]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, reason);
  assert.equal(
    Number(audit[0].before_data.defaultMarkupMax),
    settings.defaultMarkupMax,
  );
  assert.equal(
    Number(audit[0].after_data.defaultMarkupMax),
    settings.defaultMarkupMax,
  );
  process.env.AGENT_LOCK_MINUTES = "NaN";
  await call(agent, "/admin/agent-settings", "GET", {}, 503);
  delete process.env.AGENT_LOCK_MINUTES;
  const result = {
    functions: funcs,
    appendOnlyTables: tables,
    settingsVersionConflict: [0, 409],
    settingsAudit: true,
    invalidConfigurationRejected: true,
  };
  fs.writeFileSync(
    `${local}/agent-security-results.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      functions: funcs.length,
      appendOnlyTables: tables.length,
      settingsVersionConflict: [0, 409],
      settingsAudit: true,
    }),
  );
}
if (process.argv.includes("--security"))
  securityChecks().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
else if (process.argv.includes("--extra"))
  extraChecks().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
else
  (async () => {
    const first = user(),
      second = user(),
      customer = user(),
      stranger = user();
    assert.equal((await as(first, agent, "/agent/me")).status, "none");
    await call(
      agent,
      "/agent/applications",
      "POST",
      { name: "员工", phone: "19900000001", region: "验证", agreed: true },
      403,
    );
    const apply = (w) =>
      as(w, agent, "/agent/applications", "POST", {
        name: "代理验证" + w.id.slice(0, 5),
        phone: "199" + String(Date.now()).slice(-8),
        region: "验证区域",
        agreed: true,
      });
    await apply(first);
    await as(
      first,
      agent,
      "/agent/applications",
      "POST",
      { name: "重复", phone: "19900000001", region: "验证", agreed: true },
      409,
    );
    const review = async (who) => {
      const rows = await call(agent, "/admin/agent-applications", "GET", {
        keyword: "代理验证",
      });
      const row = rows.list.find((r) => r.id === who.id);
      return call(
        agent,
        "/admin/agent-applications/" + who.id + "/review",
        "POST",
        {
          approve: true,
          markupMax: 200,
          remark: "实际审核测试",
          version: row.version,
        },
      );
    };
    let approved = await review(first);
    assert.equal(approved.status, "active");
    assert.equal((await as(first, agent, "/agent/me")).markupMax, 200);
    await as(second, agent, "/agent/applications", "POST", {
      name: "直属代理验证",
      phone: "199" + String(Date.now()).slice(-8),
      region: "验证区域",
      agreed: true,
      inviteCode: approved.inviteCode,
    });
    const secondRows = await call(agent, "/admin/agent-applications", "GET", {
      keyword: "直属代理验证",
    });
    await call(
      agent,
      "/admin/agent-applications/" + second.id + "/review",
      "POST",
      {
        approve: false,
        remark: "测试拒绝",
        version: secondRows.list.find((r) => r.id === second.id).version,
      },
    );
    assert.equal(
      (await as(second, agent, "/agent/me")).reviewRemark,
      "测试拒绝",
    );
    await as(second, agent, "/agent/applications", "POST", {
      name: "代理验证" + second.id.slice(0, 5),
      phone: "199" + String(Date.now()).slice(-8),
      region: "验证区域",
      agreed: true,
      inviteCode: approved.inviteCode,
    });
    await review(second);
    const invited = await as(first, agent, "/agent/invite");
    assert.ok(invited.members.some((r) => r.name.includes("*")));
    results.push(
      "真实申请/审核/拒绝再申请、角色即时更新、一级邀请与直属代理脱敏",
    );
    const base = await call(stock, "/templates/t_phone"),
      cat = await call(stock, "/catalog/categories", "POST", {
        label: "代理" + fixture.tag.slice(0, 8),
        copyTemplateId: base.id,
      });
    const fields = base.fields.map((f) =>
      ["supplier", "receipt"].includes(f.key) ? { ...f, required: false } : f,
    );
    const form = await call(
      stock,
      "/templates/" + cat.templateId + "/versions",
      "POST",
      { baseVersion: 1, fields },
    );
    const model = await call(stock, "/models", "POST", {
      category: cat.value,
      name: "代理链路验证" + fixture.tag,
      brandLabel: "验证",
      series: "验证",
    });
    const attributes = Object.fromEntries(
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
    const unit = () =>
      call(stock, "/inbound/units", "POST", {
        modelId: model.id,
        templateVersion: form.version,
        inspectionConfirmed: true,
        attributes,
        imei1: imei(),
        cost: 1000,
        retail: 1500,
        wholesale: 1400,
        agentBase: 1300,
        flags: { showInShop: true, sharePeer: true, shareAgent: true },
      });
    const units = [];
    for (let i = 0; i < 6; i++) units.push(await unit());
    let shown = await as(first, agent, "/agent/units", "GET", {
      keyword: model.name,
    });
    assert.equal(shown.total, 6);
    assert.ok(
      shown.list.every(
        (r) =>
          !Object.hasOwn(r, "agentBase") &&
          !Object.hasOwn(r, "cost") &&
          !Object.hasOwn(r, "imei1"),
      ),
    );
    await as(
      first,
      agent,
      "/agent/units/" + units[0].id + "/markup",
      "PUT",
      { markup: 201 },
      400,
    );
    const priced = await as(
      first,
      agent,
      "/agent/units/" + units[0].id + "/markup",
      "PUT",
      { markup: 100 },
    );
    assert.equal(priced.sharePrice, 1400);
    await as(
      first,
      agent,
      "/agent/units/" + units[0].id + "/markup",
      "PUT",
      { markup: 100, sharePrice: 1 },
      400,
    );
    results.push(
      "代理仅可转发允许设备，服务端加价上限与分享价计算、底价成本串码裁剪",
    );
    const link = await as(first, agent, "/share/links", "POST", {
      unitId: units[0].id,
      channel: "agent",
    });
    assert.equal(link.price, 1400);
    assert.match(link.shareId, /^[A-Za-z0-9_-]{16}$/);
    const shared = await as(customer, agent, "/shop/shares/" + link.shareId);
    assert.equal(shared.price, 1400);
    const viaShop = await as(customer, shop, "/shop/units", "GET", {}, 0, {
      "X-Channel": link.shareId,
    });
    assert.equal(viaShop.list[0].price, 1400);
    assert.equal(viaShop.list[0].priceType, "agent");
    const body = {
      requestKey: key(),
      unitId: units[0].id,
      phone: "199" + String(Date.now()).slice(-8),
      name: "顾客验证",
      content: "",
    };
    await as(first, agent, "/shop/orders", "POST", body, 400, {
      "X-Channel": link.shareId,
    });
    let order = await as(customer, agent, "/shop/orders", "POST", body, 0, {
      "X-Channel": link.shareId,
    });
    assert.equal(order.agentOrder.status, "locked");
    assert.equal(
      (
        await as(customer, agent, "/shop/orders", "POST", body, 0, {
          "X-Channel": link.shareId,
        })
      ).id,
      order.id,
    );
    assert.equal((await call(stock, "/units/" + units[0].id)).status, "locked");
    await as(stranger, agent, "/shop/requests/" + order.id, "GET", {}, 404);
    results.push("真实代理分享快照、顾客下单锁库/幂等、自购与越权拒绝");
    const quoteBody = {
      customerRequestId: order.id,
      items: [{ unitId: units[0].id, channel: "agent", priceVersion: 1 }],
    };
    const looked = await call(sales, "/sales/lookup", "GET", {
      code: units[0].id,
      customerRequestId: order.id,
    });
    assert.equal(looked.status, "locked");
    assert.equal(
      (await call(sales, "/sales/quote", "POST", quoteBody)).total,
      1400,
    );
    await call(
      sales,
      "/sales/quote",
      "POST",
      { ...quoteBody, items: [{ ...quoteBody.items[0], price: 1400 }] },
      400,
    );
    const saleBody = {
      ...quoteBody,
      requestKey: key(),
      paymentConfirmed: true,
      payMethod: "现金",
      customer: "代理顾客",
    };
    const sale = await call(sales, "/sales-orders", "POST", saleBody);
    assert.equal(sale.amount, 1400);
    assert.equal(
      (await call(sales, "/sales-orders", "POST", saleBody)).id,
      sale.id,
    );
    const detail = await call(sales, "/sales-orders/" + sale.id);
    assert.equal(detail.agentSources[0].markup, 100);
    assert.equal(detail.customerRequestId, order.id);
    const earned = await as(first, agent, "/agent/commissions");
    assert.equal(earned.summary.pendingAmount, 100);
    assert.equal(earned.list[0].saleOrderId, undefined);
    results.push("代理锁库真实收银成交、不可改价、快照出库与归因/收益一次记账");
    const money = earned.list[0];
    await call(
      agent,
      "/admin/agent-earnings/settle",
      "POST",
      { ids: [money.id], reason: "" },
      400,
    );
    await call(agent, "/admin/agent-earnings/settle", "POST", {
      ids: [money.id],
      reason: "实际线下转账验收",
    });
    await call(
      agent,
      "/admin/agent-earnings/settle",
      "POST",
      { ids: [money.id], reason: "不能重复标记" },
      409,
    );
    const refund = await call(
      sales,
      "/sales-orders/" + sale.id + "/refund",
      "POST",
      {
        requestKey: key(),
        kind: "return",
        reason: "真实退货冲回",
        items: [{ itemId: detail.items[0].id }],
      },
    );
    assert.equal(refund.status, "refunded");
    const reversal = await as(first, agent, "/agent/commissions");
    assert.equal(reversal.summary.pendingAmount, -100);
    assert.equal(reversal.summary.settledAmount, 100);
    assert.ok(
      reversal.list.some((r) => r.kind === "reversal" && r.amount === -100),
    );
    results.push("逐单转账原因审计与重复拒绝，已转账收益退货追加负向冲回");
    const link2 = await as(first, agent, "/share/links", "POST", {
      unitId: units[1].id,
      channel: "agent",
    });
    const pending = await as(
      customer,
      agent,
      "/shop/orders",
      "POST",
      { ...body, requestKey: key(), unitId: units[1].id },
      0,
      { "X-Channel": link2.shareId },
    );
    const sale2 = await call(sales, "/sales-orders", "POST", {
      requestKey: key(),
      customerRequestId: pending.id,
      items: [{ unitId: units[1].id, channel: "agent", priceVersion: 1 }],
      paymentConfirmed: true,
      payMethod: "现金",
    });
    const sale2detail = await call(sales, "/sales-orders/" + sale2.id);
    await call(sales, "/sales-orders/" + sale2.id + "/refund", "POST", {
      requestKey: key(),
      kind: "return",
      reason: "未转账退货",
      items: [{ itemId: sale2detail.items[0].id }],
    });
    assert.ok(
      (await as(first, agent, "/agent/commissions")).list.some(
        (e) => e.orderId === pending.id && e.status === "reversed",
      ),
    );
    results.push("待转账收益退货直接冲回，原销售/收益记录保留");
    const cancelLink = await as(first, agent, "/share/links", "POST", {
      unitId: units[2].id,
      channel: "agent",
    });
    const cancelOrder = await as(
      customer,
      agent,
      "/shop/orders",
      "POST",
      { ...body, requestKey: key(), unitId: units[2].id },
      0,
      { "X-Channel": cancelLink.shareId },
    );
    const cancelBody = {
      requestKey: key(),
      version: cancelOrder.version,
      reason: "真实取消验收",
    };
    await as(
      customer,
      agent,
      "/shop/requests/" + cancelOrder.id + "/cancel",
      "PATCH",
      cancelBody,
    );
    assert.equal(
      (await call(stock, "/units/" + units[2].id)).status,
      "in_stock",
    );
    assert.equal(
      (
        await as(
          customer,
          agent,
          "/shop/requests/" + cancelOrder.id + "/cancel",
          "PATCH",
          cancelBody,
        )
      ).version,
      2,
    );
    results.push("顾客取消释放占用与库存，取消幂等");
    const expireLink = await as(first, agent, "/share/links", "POST", {
      unitId: units[3].id,
      channel: "agent",
    });
    const expireOrder = await as(
      customer,
      agent,
      "/shop/orders",
      "POST",
      { ...body, requestKey: key(), unitId: units[3].id },
      0,
      { "X-Channel": expireLink.shareId },
    );
    execute(
      `UPDATE agent_orders SET lock_expires_at=now()-interval '1 second' WHERE request_id='${expireOrder.id}'`,
    );
    await expiry();
    assert.equal(
      (await call(stock, "/units/" + units[3].id)).status,
      "in_stock",
    );
    assert.equal(
      (
        await as(first, agent, "/agent/orders", "GET", { status: "released" })
      ).list.some((r) => r.id === expireOrder.id),
      true,
    );
    results.push("真实PG隔离订单设为到期后运行实际释放任务，只释放到期锁");
    const badLink = await as(first, agent, "/share/links", "POST", {
      unitId: units[4].id,
      channel: "agent",
    });
    await call(stock, "/units/" + units[4].id + "/price", "PATCH", {
      retail: 1600,
      priceVersion: 1,
      reason: "分享失效验证",
    });
    await as(
      customer,
      agent,
      "/shop/shares/" + badLink.shareId,
      "GET",
      {},
      410,
    );
    await as(first, agent, "/agent/units/" + units[5].id + "/markup", "PUT", {
      markup: 80,
    });
    const nativeLink = await as(first, agent, "/share/links", "POST", {
      unitId: units[5].id,
      channel: "agent",
    });
    const current = await call(agent, "/admin/agents", "GET", {
      keyword: "代理验证" + first.id.slice(0, 5),
    });
    const before = current.list.find((x) => x.id === first.id);
    const disabled = await call(agent, "/admin/agents/" + first.id, "PATCH", {
      status: "disabled",
      version: before.version,
      reason: "资格撤销验证",
    });
    await as(first, agent, "/agent/units", "GET", {}, 403);
    await as(
      customer,
      agent,
      "/shop/shares/" + nativeLink.shareId,
      "GET",
      {},
      410,
    );
    await call(agent, "/admin/agents/" + first.id, "PATCH", {
      status: "active",
      version: disabled.version,
      reason: "恢复隔离验证代理",
    });
    results.push("改价或代理停用使分享失效，恢复资格重新判权");
    execute(`UPDATE staff SET role_key='sales' WHERE user_id='${fixture.uid}'`);
    const salesRows = await call(agent, "/admin/agent-orders");
    assert.ok(
      salesRows.list.every(
        (o) => o.markup === undefined && o.agentBase === undefined,
      ),
    );
    await call(agent, "/admin/agent-earnings", "GET", {}, 403);
    await call(agent, "/admin/agent-settings", "GET", {}, 403);
    execute(`UPDATE staff SET role_key='boss' WHERE user_id='${fixture.uid}'`);
    results.push("销售可见代理订单但看不到底价/加价及收益台账");
    fs.writeFileSync(
      `${local}/agent-fixture.json`,
      JSON.stringify({
        ...fixture,
        agentId: first.id,
        agent: first,
        customer,
        shareId: nativeLink.shareId,
        unitId: units[5].id,
        modelId: model.id,
        saleId: sale.id,
        expectedSharePrice: nativeLink.price,
        expectedMarkup: 80,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      `${local}/agent-results.json`,
      JSON.stringify({ passed: results }, null, 2),
    );
    console.log(JSON.stringify({ results }));
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
