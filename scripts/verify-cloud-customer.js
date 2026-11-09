#!/usr/bin/env node
/**
 * 函数源码 + 真实 CloudBase PG 的顾客意向与访问上报集成验收（不是数据库 mock）。
 * 仅 wx-server-sdk 的平台 OPENID 由隔离测试夹具注入；真实部署/微信身份另在模拟器验证。
 * 运行 node scripts/verify-cloud-customer.js。使用已登录 tcb/mcporter、functions.env。
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
const customer = require("../cloudfunctions/customer").main;
const shop = require("../cloudfunctions/shop").main;
const agent = require("../cloudfunctions/agent").main;

Module._load = original;
const results = [],
  key = () => crypto.randomUUID(),
  execute = (sql) =>
    control("managePgDatabase", { action: "execute", confirm: true, sql }),
  query = (sql) =>
    control("queryPgDatabase", { action: "sql", sql, limit: 100 }).data.rows;
const imei = () => {
  const s = "35" + String(crypto.randomInt(1e12)).padStart(12, "0");
  let n = 0;
  for (let i = 0; i < 14; i++) {
    let d = +s[i] * (i % 2 ? 2 : 1);
    n += Math.floor(d / 10) + (d % 10);
  }
  return s + ((10 - (n % 10)) % 10);
};
const boss = { id: fixture.uid, openid: fixture.openid, token: fixture.token };
const raw = (who, fn, url, method = "GET", data = {}, headers = {}) => {
  const previous = fixture.openid;
  fixture.openid = who?.openid || boss.openid;
  const promise = fn(
    {
      path: url,
      method,
      data,
      headers: {
        ...(who ? { Authorization: "Bearer " + who.token } : {}),
        ...headers,
      },
    },
    { request_id: "customer-verify-" + fixture.tag },
  );
  fixture.openid = previous;
  return promise;
};
async function call(
  who,
  fn,
  url,
  method = "GET",
  data = {},
  expected = 0,
  headers = {},
) {
  const r = await raw(who, fn, url, method, data, headers);
  assert.equal(r.code, expected, JSON.stringify(r));
  return r.data;
}
function user(role = "customer") {
  const id = key(),
    openid = "customer-verify-" + id,
    token = crypto.randomBytes(32).toString("hex");
  execute(
    `INSERT INTO users(id,openid,nickname,role) VALUES('${id}','${openid}','意向验证','${role}');INSERT INTO sessions(token_hash,user_id,assurance,expires_at) VALUES('${crypto.createHash("sha256").update(token).digest("hex")}','${id}','wechat',now()+interval '2 hours')`,
  );
  return { id, openid, token };
}
const headers = (share) => ({ "X-Channel": share }),
  contact = (id) => ({
    unitId: id,
    requestKey: key(),
    phone: "199" + String(Date.now()).slice(-8),
    name: "意向验证",
    content: "核对实际设备电池情况",
  });
async function agentSaleCheck() {
  const prior = JSON.parse(fs.readFileSync(`${local}/customer-fixture.json`));
  assert.match(prior.modelId, /^[A-Za-z0-9_-]+$/);
  const available = query(
    `SELECT id,price_version FROM units WHERE model_id='${prior.modelId}' AND status='in_stock' AND share_flags->>'shareAgent'='true' ORDER BY id LIMIT 1`,
  )[0];
  assert.ok(available, "保留的当前块隔离设备须仍在库");
  const seller = user("agent"),
    buyer = user();
  execute(
    `INSERT INTO agents(user_id,status,name,phone,region,markup_max) VALUES('${seller.id}','active','当前块收银兼容验证','','隔离夹具',100);UPDATE users SET agent_status='active' WHERE id='${seller.id}'`,
  );
  await call(seller, agent, "/agent/units/" + available.id + "/markup", "PUT", {
    markup: 40,
  });
  const link = await call(seller, agent, "/share/links", "POST", {
    unitId: available.id,
    channel: "agent",
  });
  const order = await call(
    buyer,
    customer,
    "/shop/orders",
    "POST",
    contact(available.id),
    0,
    headers(link.shareId),
  );
  const sale = await call(boss, sales, "/sales-orders", "POST", {
    requestKey: key(),
    customerRequestId: order.id,
    items: [
      {
        unitId: available.id,
        priceVersion: Number(available.price_version),
        channel: "agent",
      },
    ],
    paymentConfirmed: true,
    payMethod: "现金",
  });
  assert.equal(sale.amount, link.price);
  const result = await call(buyer, customer, "/shop/requests/" + order.id);
  assert.equal(result.agentOrder.status, "sold");
  assert.equal(result.status, "closed");
  const earnings = query(
    `SELECT amount FROM agent_earnings WHERE request_id='${order.id}'`,
  );
  assert.equal(earnings.length, 1);
  assert.equal(Number(earnings[0].amount), 40);
  const evidence = {
    passed: true,
    agentSnapshotSale: true,
    singleEarning: 40,
    source:
      "当前块改动stock_sale后的定向兼容验证，真实PG/会话，平台OPENID隔离夹具",
  };
  fs.writeFileSync(
    `${local}/customer-agent-sale-results.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
}
if (process.argv.includes("--agent-sale"))
  agentSaleCheck().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
else
  (async () => {
    const owner = user(),
      stranger = user(),
      peer = user("peer");
    const base = await call(boss, stock, "/templates/t_phone"),
      cat = await call(boss, stock, "/catalog/categories", "POST", {
        label: "意向" + fixture.tag.slice(0, 8),
        copyTemplateId: base.id,
      }),
      fields = base.fields.map((f) =>
        ["supplier", "receipt"].includes(f.key) ? { ...f, required: false } : f,
      ),
      template = await call(
        boss,
        stock,
        "/templates/" + cat.templateId + "/versions",
        "POST",
        { baseVersion: 1, fields },
      ),
      model = await call(boss, stock, "/models", "POST", {
        category: cat.value,
        name: "意向验证" + fixture.tag,
        brandLabel: "意向验证",
        series: "验证",
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
    const units = [];
    for (let i = 0; i < 5; i++)
      units.push(
        await call(boss, stock, "/inbound/units", "POST", {
          modelId: model.id,
          templateVersion: template.version,
          inspectionConfirmed: true,
          attributes: attrs,
          imei1: imei(),
          cost: 1000,
          retail: 1500,
          wholesale: 1400,
          agentBase: 1300,
          flags: { showInShop: true, sharePeer: true, shareAgent: true },
        }),
      );
    const share = await call(boss, agent, "/share/links", "POST", {
        unitId: units[0].id,
        channel: "customer",
      }),
      body = contact(units[0].id);
    await call(null, customer, "/shop/consults", "POST", body, 401);
    const submitted = await Promise.all(
      [1, 2].map(() =>
        call(
          owner,
          customer,
          "/shop/consults",
          "POST",
          body,
          0,
          headers(share.shareId),
        ),
      ),
    );
    const c = submitted[0];
    assert.equal(c.id, submitted[1].id);
    assert.equal(c.source, "customer");
    assert.equal(c.unit.price, 1500);
    assert.equal(c.shareOwnerId, undefined);
    assert.equal(c.unit.imei1, undefined);
    assert.equal(c.unit.cost, undefined);
    await call(
      owner,
      customer,
      "/shop/consults",
      "POST",
      { ...body, phone: "19900000001" },
      409,
      headers(share.shareId),
    );
    assert.equal(
      (await call(boss, stock, "/units/" + units[0].id)).status,
      "in_stock",
    );
    results.push("咨询真实落库，同标识并发仅一份快照/事件，来源核验且不锁库存");
    await call(stranger, customer, "/shop/requests/" + c.id, "GET", {}, 404);
    assert.equal((await call(stranger, customer, "/shop/requests")).total, 0);
    await call(
      owner,
      customer,
      "/shop/consults",
      "POST",
      { ...contact(units[0].id), price: 1 },
      400,
    );
    await call(
      owner,
      customer,
      "/shop/consults",
      "POST",
      contact(units[0].id),
      404,
      headers("forged_source"),
    );
    const generic = await call(owner, customer, "/shop/consults", "POST", {
      ...contact(undefined),
      name: "",
    });
    assert.equal(generic.unit, null);
    assert.equal(generic.name, "");
    results.push("咨询支持不选设备，其他账号404，拒绝前端自报价格/伪造来源");
    const o = await call(null, customer, "/shop/contact-options");
    const apBody = {
      ...contact(units[1].id),
      date: o.minDate,
      timeSlot: o.timeSlots[0],
    };
    await call(
      owner,
      customer,
      "/shop/appointments",
      "POST",
      { ...apBody, date: "2000-01-01" },
      400,
    );
    await call(
      owner,
      customer,
      "/shop/appointments",
      "POST",
      { ...apBody, timeSlot: "非法预约时段" },
      400,
    );
    const ap = await call(
      owner,
      customer,
      "/shop/appointments",
      "POST",
      apBody,
    );
    assert.equal(ap.date, o.minDate);
    assert.equal(
      (await call(boss, stock, "/units/" + units[1].id)).status,
      "in_stock",
    );
    const previousSlots = process.env.APPOINTMENT_SLOTS;
    process.env.APPOINTMENT_SLOTS = "invalid json";
    await call(null, customer, "/shop/contact-options", "GET", {}, 503);
    assert.equal(
      (await call(owner, customer, "/shop/appointments", "POST", apBody)).id,
      ap.id,
    );
    await call(
      owner,
      customer,
      "/shop/appointments",
      "POST",
      { ...apBody, requestKey: key() },
      503,
    );
    if (previousSlots === undefined) delete process.env.APPOINTMENT_SLOTS;
    else process.env.APPOINTMENT_SLOTS = previousSlots;
    results.push(
      "预约日期/时段配置与不锁库存，配置损坏明确503，已成功提交重试仍返回原单",
    );
    execute(`UPDATE staff SET role_key='warehouse' WHERE user_id='${boss.id}'`);
    await call(boss, customer, "/customer-requests/" + c.id, "GET", {}, 403);
    execute(`UPDATE staff SET role_key='sales' WHERE user_id='${boss.id}'`);
    const internal = await call(boss, customer, "/customer-requests/" + c.id);
    assert.equal(internal.shareOwnerId, boss.id);
    assert.equal(internal.unit.cost, undefined);
    assert.equal(internal.canStartSale, true);
    const change = {
      requestKey: key(),
      version: 1,
      status: "contacted",
      reason: "内部跟进备注不得给顾客",
    };
    const race = await Promise.all(
      [1, 2].map((i) =>
        raw(boss, customer, "/customer-requests/" + c.id + "/status", "PATCH", {
          ...change,
          requestKey: i === 1 ? change.requestKey : key(),
        }),
      ),
    );
    assert.deepEqual(race.map((r) => r.code).sort(), [0, 409]);
    assert.equal(
      (
        await call(
          boss,
          customer,
          "/customer-requests/" + c.id + "/status",
          "PATCH",
          change,
        )
      ).version,
      2,
    );
    assert.ok(
      !JSON.stringify(
        await call(owner, customer, "/shop/requests/" + c.id),
      ).includes(change.reason),
    );
    results.push("员工权限/当前版本并发/处理幂等，内部备注按用途裁剪");
    const cancel = { requestKey: key(), version: 1, reason: "顾客暂不需要" };
    await call(
      owner,
      customer,
      "/shop/requests/" + generic.id + "/cancel",
      "PATCH",
      cancel,
    );
    assert.equal(
      (
        await call(
          owner,
          customer,
          "/shop/requests/" + generic.id + "/cancel",
          "PATCH",
          cancel,
        )
      ).version,
      2,
    );
    await call(
      boss,
      customer,
      "/customer-requests/" + generic.id + "/status",
      "PATCH",
      {
        requestKey: key(),
        version: 2,
        status: "contacted",
        reason: "不得恢复终态",
      },
      409,
    );
    await call(
      boss,
      customer,
      "/customer-requests/" + ap.id + "/status",
      "PATCH",
      {
        requestKey: key(),
        version: 1,
        status: "contacted",
        reason: "不能跳预约节点",
      },
      409,
    );
    await call(
      boss,
      customer,
      "/customer-requests/" + ap.id + "/status",
      "PATCH",
      {
        requestKey: key(),
        version: 1,
        status: "confirmed",
        reason: "已核实预约",
      },
    );
    results.push("本人取消与终态守卫，预约必须按new→confirmed→completed流转");
    execute(`UPDATE staff SET role_key='boss' WHERE user_id='${boss.id}'`);
    const wrong = {
      requestKey: key(),
      customerRequestId: c.id,
      items: [{ unitId: units[1].id, priceVersion: 1 }],
      paymentConfirmed: true,
      payMethod: "现金",
    };
    await call(boss, sales, "/sales-orders", "POST", wrong, 400);
    assert.equal(
      (await call(boss, stock, "/units/" + units[1].id)).status,
      "in_stock",
    );
    await call(boss, stock, "/units/" + units[0].id + "/price", "PATCH", {
      retail: 1600,
      priceVersion: 1,
      reason: "验证普通意向使用成交时现价",
    });
    const saleBody = {
      ...wrong,
      requestKey: key(),
      items: [{ unitId: units[0].id, priceVersion: 2 }],
    };
    const sale = await call(boss, sales, "/sales-orders", "POST", saleBody);
    assert.equal(sale.amount, 1600);
    assert.equal(
      (await call(boss, sales, "/sales-orders", "POST", saleBody)).id,
      sale.id,
    );
    const closed = await call(owner, customer, "/shop/requests/" + c.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.unit.price, 1500);
    assert.equal(closed.saleRecorded, true);
    assert.equal(
      (await call(boss, sales, "/sales-orders/" + sale.id)).shareOwnerId,
      boss.id,
    );
    results.push(
      "普通意向按现价成交但保留提交快照；错误设备完整回滚；归因/销售/状态同事务且幂等",
    );
    const appointmentSale = await call(boss, sales, "/sales-orders", "POST", {
      ...wrong,
      requestKey: key(),
      customerRequestId: ap.id,
    });
    assert.equal(
      (await call(owner, customer, "/shop/requests/" + ap.id)).status,
      "completed",
    );
    assert.equal(appointmentSale.customerRequestId, ap.id);
    assert.equal(
      Number(
        query(
          `SELECT count(*) n FROM agent_earnings WHERE request_id IN ('${c.id}','${ap.id}')`,
        )[0].n,
      ),
      0,
    );
    results.push("预约确认后成交转completed，普通意向不生成代理收益");
    const peerShare = await call(boss, agent, "/share/links", "POST", {
        unitId: units[2].id,
        channel: "peer",
      }),
      peerConsult = await call(
        peer,
        customer,
        "/shop/consults",
        "POST",
        contact(units[2].id),
        0,
        headers(peerShare.shareId),
      );
    assert.equal(peerConsult.unit.price, 1400);
    execute(`UPDATE users SET role='customer' WHERE id='${peer.id}'`);
    const cropped = await call(
      peer,
      customer,
      "/shop/requests/" + peerConsult.id,
    );
    assert.equal(cropped.unit.price, undefined);
    assert.deepEqual(Object.keys(cropped.unit).sort(), [
      "id",
      "imeiMasked",
      "name",
    ]);
    execute(`UPDATE users SET role='peer' WHERE id='${peer.id}'`);
    results.push(
      "同行历史快照随当前权限裁剪，失去资格不能读取同行价或公开参数",
    );
    const raceConsult = await call(
      owner,
      customer,
      "/shop/consults",
      "POST",
      contact(units[2].id),
    );
    const raced = await Promise.all([
      raw(
        owner,
        customer,
        "/shop/requests/" + raceConsult.id + "/cancel",
        "PATCH",
        { requestKey: key(), version: 1, reason: "并发取消" },
      ),
      raw(boss, sales, "/sales-orders", "POST", {
        requestKey: key(),
        customerRequestId: raceConsult.id,
        items: [{ unitId: units[2].id, priceVersion: 1 }],
        paymentConfirmed: true,
        payMethod: "现金",
      }),
    ]);
    assert.deepEqual(raced.map((x) => x.code).sort(), [0, 409]);
    results.push(
      "同意向取消与成交并发只有一方成功，失败方不产生库存/归因副作用",
    );
    const visitor = "visitor_" + key(),
      eventId = "event_" + key(),
      batch = {
        visitorId: visitor,
        events: [
          {
            eventId,
            type: "pv",
            route: "pages/shop/index",
            ts: 0,
            secret: "不得存储",
          },
          {
            eventId: "event_" + key(),
            type: "pv",
            route: "packages/staff/stats/index",
          },
          { eventId: "event_" + key(), type: "event", name: "consult_click" },
          { eventId: "event_" + key(), type: "event", name: "unknown" },
          {
            eventId: "event_" + key(),
            type: "pv",
            route: "packages/shop/product/index",
            unitId: "missing-unit",
          },
        ],
      };
    const hash = crypto
      .createHmac("sha256", variables.OTP_HASH_KEY)
      .update("visitor:" + visitor)
      .digest("hex");
    const v = await call(null, customer, "/visits/batch", "POST", batch);
    assert.equal(v.accepted, 2);
    assert.equal(v.ignored, 3);
    assert.equal(
      (await call(null, customer, "/visits/batch", "POST", batch)).accepted,
      0,
    );
    const rows = query(
      `SELECT * FROM visit_events WHERE visitor_hash='${hash}'`,
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.source === "natural"));
    assert.ok(!JSON.stringify(rows).includes(visitor));
    assert.ok(
      rows.every((x) => Date.now() - Date.parse(x.created_at) < 120000),
    );
    const duplicate = await Promise.all(
      [1, 2].map(() =>
        call(null, customer, "/visits/batch", "POST", {
          visitorId: visitor,
          events: [
            { eventId: "concurrent_" + eventId, type: "event", name: "share" },
          ],
        }),
      ),
    );
    assert.deepEqual(duplicate.map((x) => x.accepted).sort(), [0, 1]);
    results.push(
      "真实匿名访问HMAC落库、服务端时间、员工页/未知事件/未知设备忽略，重试与并发去重",
    );
    const badBatch = {
      visitorId: visitor,
      events: [
        { eventId: "atomic_" + key(), type: "pv", route: "pages/shop/index" },
        { eventId: "bad", type: "wrong" },
      ],
    };
    await call(null, customer, "/visits/batch", "POST", badBatch, 400);
    assert.equal(
      query(
        `SELECT count(*) n FROM visit_events WHERE visitor_hash='${hash}'`,
      )[0].n,
      "3",
    );
    const validShare = await call(boss, agent, "/share/links", "POST", {
        unitId: units[3].id,
        channel: "customer",
      }),
      event = () => ({
        visitorId: visitor,
        events: [
          {
            eventId: "event_" + key(),
            type: "pv",
            route: "packages/shop/product/index",
            unitId: units[3].id,
            source: "agent",
            shareOwnerId: stranger.id,
          },
        ],
      });
    await call(
      null,
      customer,
      "/visits/batch",
      "POST",
      event(),
      0,
      headers(validShare.shareId),
    );
    await call(
      null,
      customer,
      "/visits/batch",
      "POST",
      event(),
      0,
      headers("forged_source"),
    );
    await call(
      null,
      customer,
      "/visits/batch",
      "POST",
      event(),
      0,
      headers(peerShare.shareId),
    );
    await call(
      boss,
      agent,
      "/share/links/" + validShare.shareId + "/revoke",
      "PATCH",
      { reason: "验证来源撤销" },
    );
    await call(
      null,
      customer,
      "/visits/batch",
      "POST",
      event(),
      0,
      headers(validShare.shareId),
    );
    const attr = query(
      `SELECT source,share_owner_id FROM visit_events WHERE visitor_hash='${hash}'`,
    );
    assert.ok(
      attr.some((x) => x.source === "customer" && x.share_owner_id === boss.id),
    );
    assert.equal(attr.filter((x) => x.source === "unverified").length, 3);
    results.push(
      "整批非法事件不部分写入，真实分享归因；伪造/同行未授权/撤销来源单列unverified",
    );
    const agentUser = user();
    await call(agentUser, agent, "/agent/applications", "POST", {
      name: "归因代理" + fixture.tag.slice(0, 5),
      phone: "199" + String(Date.now()).slice(-8),
      region: "测试",
      agreed: true,
    });
    await call(
      boss,
      agent,
      "/admin/agent-applications/" + agentUser.id + "/review",
      "POST",
      { approve: true, markupMax: 100, version: 1, remark: "当前块验证" },
    );
    const agentShare = await call(agentUser, agent, "/share/links", "POST", {
      unitId: units[3].id,
      channel: "agent",
    });
    const before = await call(agentUser, agent, "/agent/overview");
    await call(
      null,
      customer,
      "/visits/batch",
      "POST",
      event(),
      0,
      headers(agentShare.shareId),
    );
    const after = await call(agentUser, agent, "/agent/overview");
    assert.equal(after.todayViews, before.todayViews + 1);
    const order = await call(
      owner,
      customer,
      "/shop/orders",
      "POST",
      contact(units[3].id),
      0,
      headers(agentShare.shareId),
    );
    assert.equal(order.agentOrder.status, "locked");
    await call(
      owner,
      customer,
      "/shop/requests/" + order.id + "/cancel",
      "PATCH",
      { requestKey: key(), version: 1, reason: "代理路由兼容验证" },
    );
    assert.equal(
      (await call(boss, stock, "/units/" + units[3].id)).status,
      "in_stock",
    );
    results.push(
      "新访问上报计入真实代理概览；统一意向接口仍保留代理下单锁库与取消释放",
    );
    const functionRows = query(
      `SELECT p.proname,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('customer_request_raw','api_customer_requests','api_visits','stock_sale')`,
    );
    assert.equal(functionRows.length, 4);
    const bool = (v) => v === true || v === "true";
    for (const f of functionRows) {
      assert.equal(bool(f.prosecdef), false);
      assert.equal(bool(f.anon), false);
      assert.equal(bool(f.authenticated), false);
      assert.equal(bool(f.service), true);
    }
    const tableData = execute(
        `SELECT jsonb_agg(q) rows FROM(SELECT c.relname,has_table_privilege('service_role',c.oid,'UPDATE') upd,has_table_privilege('service_role',c.oid,'DELETE') del,has_table_privilege('service_role',c.oid,'TRUNCATE') trunc,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('customer_requests','customer_request_events','sales_attributions','visit_events','audit_logs'))q`,
      ).data.previewRows[0].rows,
      tableRows =
        typeof tableData === "string" ? JSON.parse(tableData) : tableData;
    assert.equal(tableRows.length, 5);
    for (const t of tableRows) {
      assert.equal(bool(t.relrowsecurity), true);
      for (const k of ["upd", "del", "trunc"]) assert.equal(bool(t[k]), false);
    }
    results.push(
      "实际PG授权：四函数INVOKER且只授权service_role，五张业务/审计表只追加",
    );
    const audits = query(
      `SELECT action,reason FROM audit_logs WHERE request_id='customer-verify-${fixture.tag}'`,
    );
    assert.ok(
      audits.some(
        (x) => x.action === "跟进咨询预约" && x.reason === change.reason,
      ),
    );
    fs.writeFileSync(
      `${local}/customer-fixture.json`,
      JSON.stringify({
        ...fixture,
        modelId: model.id,
        nativeUnitId: units[4].id,
        unitId: units[0].id,
        consultId: c.id,
        appointmentId: ap.id,
        saleId: sale.id,
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      `${local}/customer-results.json`,
      JSON.stringify(
        {
          passed: results,
          permissions: { functions: functionRows, tables: tableRows },
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
