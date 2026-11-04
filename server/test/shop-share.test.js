const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { one } = require("../src/db");
let f, payload, model, secretImei, receipt, photo;
test.before(async () => {
  f = await fixture(["boss", "sales", "warehouse", "customer", "peer"]);
  model = (
    await f.api("POST", "/models", {
      category: "phone",
      name: "分享验证_" + Date.now(),
      brandLabel: "分享品牌",
      series: "验证",
      copyTemplateId: "t_phone",
      tacs: [],
    })
  ).data;
  const template = (await f.api("GET", "/templates/" + model.templateId)).data;
  const supplier = (
    await f.api("POST", "/suppliers", { name: "不可外发货源_" + Date.now() })
  ).data;
  receipt = await f.upload();
  photo = await f.upload("public");
  payload = {
    modelId: model.id,
    templateVersion: template.version,
    supplierId: supplier.id,
    inspectionConfirmed: true,
    attributes: attributes(template, receipt),
    cost: "1000.12",
    retail: "1300.58",
    wholesale: "1200.25",
    agentBase: "1100.14",
    internalNote: "内部绝密说明",
    customerDesc: "顾客机况",
    peerDesc: "同行机况",
    publicImages: [{ fileId: photo.fileId }],
    flags: { showInShop: true, sharePeer: true, shareAgent: true },
  };
});
test.after(async () => f?.close());
async function unit() {
  secretImei = imei();
  const r = await f.api("POST", "/inbound/units", {
    ...payload,
    imei1: secretImei,
  });
  assert.equal(r.status, 200, r.message);
  return r.data.id;
}
const link = (ids, channel = "customer", role = "boss") =>
  f.api("POST", "/share/links", { unitIds: ids, channel }, role);
function safe(u) {
  const content = JSON.stringify(u);
  for (const banned of [
    secretImei,
    receipt.fileId,
    "内部绝密说明",
    "不可外发货源",
  ])
    assert.ok(!content.includes(banned), banned);
  for (const key of [
    "imei1",
    "imei2",
    "cost",
    "supplier",
    "internalNote",
    "wholesale",
    "agentBase",
    "retail",
  ])
    assert.equal(u[key], undefined);
  assert.equal(u.images.length, 1);
  assert.ok(u.images[0].includes(photo.fileId));
}
test("真实公开商品与分享：服务端渠道定价/白名单字段/单机与合集仅带s", async () => {
  const a = await unit(),
    b = await unit();
  let r = await f.api("GET", "/shop/units/" + a, undefined, null);
  assert.equal(r.status, 200, r.message);
  safe(r.data);
  assert.equal(r.data.price, 1300.58);
  assert.equal(r.data.desc, "顾客机况");
  r = await f.api("GET", "/shop/units/" + a, undefined, "peer");
  assert.equal(r.data.price, 1200.25);
  safe(r.data);
  assert.equal(r.data.desc, "同行机况");
  const customer = (await link([a], "customer", "customer")).data;
  assert.match(customer.shareId, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(
    customer.path,
    "/packages/shop/product/index?s=" + customer.shareId,
  );
  r = await f.api("GET", "/shop/shares/" + customer.shareId, undefined, null);
  assert.equal(r.data.units[0].price, 1300.58);
  safe(r.data.units[0]);
  assert.equal((await link([a], "peer", "customer")).status, 403);
  assert.equal((await link([a], "customer", "warehouse")).status, 403);
  assert.equal((await link([a], "customer", null)).status, 401);
  // 员工不能生成代理渠道分享，只有审核通过的代理本人可以
  assert.equal((await link([a], "agent")).status, 403);
  const peer = (await link([a], "peer", "sales")).data;
  assert.equal(
    (await f.api("GET", "/shop/shares/" + peer.shareId, undefined, null))
      .status,
    403,
  );
  assert.equal(
    (await f.api("GET", "/shop/shares/" + peer.shareId, undefined, "customer"))
      .status,
    403,
  );
  r = await f.api("GET", "/shop/shares/" + peer.shareId, undefined, "peer");
  assert.equal(r.data.units[0].price, 1200.25);
  safe(r.data.units[0]);
  const headers = { "X-Channel": customer.shareId };
  r = await f.api(
    "GET",
    "/shop/units?modelId=" + model.id,
    undefined,
    null,
    headers,
  );
  assert.deepEqual(
    r.data.list.map((u) => u.id),
    [a],
  );
  assert.equal(
    (await f.api("GET", "/shop/units/" + b, undefined, null, headers)).status,
    404,
  );
  const collection = (await link([a, b])).data;
  assert.equal(
    collection.path,
    "/packages/shop/collection/index?s=" + collection.shareId,
  );
  assert.equal(collection.units.length, 2);
  assert.equal(collection.price, undefined);
  assert.equal((await link([a, a])).status, 400);
  await assert.rejects(
    f.pool.execute("UPDATE share_items SET price=1 WHERE share_id=?", [
      customer.shareId,
    ]),
    (e) => e.code === "ER_TABLEACCESS_DENIED_ERROR",
  );
  await f.restart();
  assert.equal(
    (await f.api("GET", "/shop/shares/" + collection.shareId, undefined, null))
      .data.units.length,
    2,
  );
});
test("撤销/改价/下架/停用/到期使链接失效，访问只归因有效且获授权的分享", async () => {
  const id = await unit(),
    customer = (await link([id])).data,
    peer = (await link([id], "peer")).data;
  const report = (key, share, role = null) =>
    f.api(
      "POST",
      "/visits/batch",
      {
        visitorId: "share_visitor_" + id,
        events: [
          {
            eventId: key + "_" + id,
            type: "pv",
            route: "packages/shop/product/index",
            unitId: id,
          },
        ],
      },
      role,
      { "X-Channel": share },
    );
  assert.equal((await report("valid", customer.shareId)).data.accepted, 1);
  assert.equal((await report("valid", customer.shareId)).data.accepted, 0);
  await report("forged", "agent_forged");
  await report("denied", peer.shareId);
  await report("peer", peer.shareId, "peer");
  const [events] = await f.pool.execute(
    "SELECT source,share_id,share_owner_id FROM visit_events WHERE unit_id=?",
    [id],
  );
  assert.equal(events.filter((e) => e.source === "customer").length, 1);
  assert.equal(events.filter((e) => e.source === "peer").length, 1);
  assert.equal(events.filter((e) => e.source === "unverified").length, 2);
  assert.ok(
    events.find((e) => e.source === "customer").share_owner_id === f.users.boss,
  );
  assert.ok(
    events
      .filter((e) => e.source === "unverified")
      .every((e) => e.share_id === null),
  );
  assert.equal(
    (
      await f.api(
        "PATCH",
        "/share/links/" + customer.shareId + "/revoke",
        { reason: "错误分享撤回" },
        "customer",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.api("PATCH", "/share/links/" + customer.shareId + "/revoke", {
        reason: "错误分享撤回",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.api("GET", "/shop/shares/" + customer.shareId, undefined, null))
      .status,
    404,
  );
  const changed = (await link([id])).data;
  const service = require("../src/share-service").shareService({
    config: f.cfg,
  });
  const context = await service.resolve(f.pool, changed.shareId, null);
  assert.equal(
    (
      await f.api("PATCH", "/units/" + id + "/price", {
        retail: "1400.66",
        priceVersion: 1,
        reason: "更新售价",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.api("GET", "/shop/shares/" + changed.shareId, undefined, null))
      .status,
    410,
  );
  await assert.rejects(
    service.unit(f.pool, id, { user: null }, context),
    (e) => e.statusCode === 410,
  );
  const latest = await one(
    f.pool,
    require("../src/stock").unitSelect + " WHERE u.id=?",
    [id],
  );
  assert.throws(
    () => service.snapshotPrice(context, latest),
    (e) => e.statusCode === 410,
  );
  const hidden = (await link([id])).data;
  await f.api("PATCH", "/units/" + id + "/share-flags", { showInShop: false });
  assert.equal(
    (await f.api("GET", "/shop/shares/" + hidden.shareId, undefined, null))
      .status,
    410,
  );
  assert.equal(
    (await f.api("GET", "/shop/units/" + id, undefined, null)).status,
    404,
  );
  await f.api("PATCH", "/units/" + id + "/share-flags", { showInShop: true });
  const expired = (await link([id])).data;
  await f.admin.execute(
    "UPDATE share_links SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE id=?",
    [expired.shareId],
  );
  assert.equal(
    (await f.api("GET", "/shop/shares/" + expired.shareId, undefined, null))
      .status,
    410,
  );
  const disabled = (await link([id], "customer", "sales")).data;
  await f.admin.execute("UPDATE staff SET status='disabled' WHERE user_id=?", [
    f.users.sales,
  ]);
  assert.equal(
    (await f.api("GET", "/shop/shares/" + disabled.shareId, undefined, null))
      .status,
    410,
  );
});

test("顾客搜索：成色/电池/价格按渠道公开取值筛选，分类型号带 id", async () => {
  const create = async (prices) => {
    const r = await f.api("POST", "/inbound/units", {
      ...payload,
      ...prices,
      imei1: imei(),
    });
    assert.equal(r.status, 200, r.message);
    return r.data.id;
  };
  const cheap = await create({ retail: "800.00", wholesale: "700.00" }),
    dear = await create({});
  const base = "/shop/units?pageSize=100&modelId=" + model.id,
    ids = async (query, role = null) => {
      const r = await f.api("GET", base + query, undefined, role);
      assert.equal(r.status, 200, r.message);
      return r.data.list.map((u) => u.id);
    };
  let got = await ids("&priceMax=1000");
  assert.ok(got.includes(cheap) && !got.includes(dear));
  assert.ok((await ids("&priceMin=1000")).includes(dear));
  // 同行按同行价筛选，顾客按零售价
  assert.ok((await ids("&priceMax=750", "peer")).includes(cheap));
  assert.ok(!(await ids("&priceMax=750")).includes(cheap));
  const grade = payload.attributes.grade;
  assert.ok((await ids("&grade=" + encodeURIComponent(grade))).includes(cheap));
  assert.deepEqual(await ids("&grade=" + encodeURIComponent("不存在成色")), []);
  assert.ok((await ids("&batteryMin=96")).includes(cheap));
  assert.deepEqual(await ids("&batteryMin=97"), []);
  // 模板未对顾客公开电池时，电池筛选不能命中该设备，避免借筛选推断隐藏参数
  const row = await one(
    f.admin,
    "SELECT template_snapshot FROM units WHERE id=?",
    [cheap],
  );
  const snapshot =
    typeof row.template_snapshot === "string"
      ? JSON.parse(row.template_snapshot)
      : row.template_snapshot;
  snapshot.fields = snapshot.fields.map((x) =>
    x.key === "battery" ? { ...x, visibility: ["internal"] } : x,
  );
  await f.admin.execute("UPDATE units SET template_snapshot=? WHERE id=?", [
    JSON.stringify(snapshot),
    cheap,
  ]);
  got = await ids("&batteryMin=90");
  assert.ok(got.includes(dear) && !got.includes(cheap));
  const page1 = await f.api(
    "GET",
    "/shop/units?pageSize=1&batteryMin=90&modelId=" + model.id,
    undefined,
    null,
  );
  assert.equal(page1.data.list.length, 1);
  assert.equal(page1.data.total, got.length);
  for (const bad of [
    "&priceMin=abc",
    "&batteryMin=101",
    "&priceMin=10&priceMax=5",
  ])
    assert.equal((await f.api("GET", base + bad, undefined, null)).status, 400);
  const categories = (await f.api("GET", "/shop/categories", undefined, null))
    .data;
  const models = categories
    .flatMap((c) => c.brands)
    .flatMap((b) => b.series)
    .flatMap((s) => s.models);
  assert.deepEqual(
    models.find((m) => m.id === model.id),
    { id: model.id, name: model.name },
  );
});

test("顾客搜索 SQL 下推：成色/电池/价格结果与公开取值口径（publicFacts）逐条一致", async () => {
  const { shareService } = require("../src/share-service");
  const { unitSelect } = require("../src/stock");
  const service = shareService({ config: f.cfg });
  const ids = [];
  for (const retail of ["500", "800", "1200", "1500", "2000", "2500"])
    ids.push(
      (
        await f.api("POST", "/inbound/units", {
          ...payload,
          retail,
          wholesale: String(Number(retail) - 100),
          imei1: imei(),
        })
      ).data.id,
    );
  // 边界取值：带%、纯数字、非数字、空值、成色不同、对顾客隐藏电池、对同行隐藏成色
  const tweaks = [
    { battery: "88%" },
    { battery: 79 },
    { battery: "abc" },
    { battery: "" },
    { grade: "其他成色", battery: "100" },
    { hide: { battery: ["internal"], grade: ["customer"] } },
  ];
  for (const [i, t] of tweaks.entries()) {
    const row = await one(
      f.admin,
      "SELECT attributes,template_snapshot FROM units WHERE id=?",
      [ids[i]],
    );
    const attrs =
      typeof row.attributes === "string"
        ? JSON.parse(row.attributes)
        : row.attributes;
    const snap =
      typeof row.template_snapshot === "string"
        ? JSON.parse(row.template_snapshot)
        : row.template_snapshot;
    if (t.battery !== undefined) attrs.battery = t.battery;
    if (t.grade !== undefined) attrs.grade = t.grade;
    if (t.hide)
      snap.fields = snap.fields.map((x) =>
        t.hide[x.key] ? { ...x, visibility: t.hide[x.key] } : x,
      );
    await f.admin.execute(
      "UPDATE units SET attributes=?,template_snapshot=? WHERE id=?",
      [JSON.stringify(attrs), JSON.stringify(snap), ids[i]],
    );
  }
  const [rows] = await f.admin.query(
    unitSelect + " WHERE u.model_id=? AND u.status='in_stock'",
    [model.id],
  );
  const grade = payload.attributes.grade;
  const queries = [
    { priceMin: "800", priceMax: "2000" },
    { grade },
    { grade: "其他成色" },
    { batteryMin: "80" },
    { batteryMin: "0" },
    { batteryMin: "96", grade },
    { priceMax: "1500", batteryMin: "85" },
  ];
  for (const role of [null, "peer"]) {
    const channel = role === "peer" ? "peer" : "customer",
      flag = role === "peer" ? "sharePeer" : "showInShop";
    for (const q of queries) {
      const min = q.priceMin ? Number(q.priceMin) : null,
        max = q.priceMax ? Number(q.priceMax) : null,
        bat = q.batteryMin !== undefined ? Number(q.batteryMin) : null;
      const expected = rows
        .filter(
          (u) =>
            (typeof u.share_flags === "string"
              ? JSON.parse(u.share_flags)
              : u.share_flags)[flag],
        )
        .filter((u) => {
          const x = service.publicFacts(u, { channel });
          return (
            (!q.grade || x.grade === q.grade) &&
            (min === null || x.price >= min) &&
            (max === null || x.price <= max) &&
            (bat === null || (Number.isFinite(x.battery) && x.battery >= bat))
          );
        })
        .map((u) => u.id)
        .sort();
      const r = await f.api(
        "GET",
        "/shop/units?pageSize=100&modelId=" +
          model.id +
          "&" +
          new URLSearchParams(q).toString(),
        undefined,
        role,
      );
      assert.equal(r.status, 200, r.message);
      assert.deepEqual(
        r.data.list.map((u) => u.id).sort(),
        expected,
        channel + " " + JSON.stringify(q),
      );
      assert.equal(r.data.total, expected.length);
    }
  }
  // 分页：总数来自数据库计数，每页条数正确且不重复
  const first = await f.api(
    "GET",
    "/shop/units?page=1&pageSize=2&batteryMin=0&modelId=" + model.id,
    undefined,
    null,
  );
  const second = await f.api(
    "GET",
    "/shop/units?page=2&pageSize=2&batteryMin=0&modelId=" + model.id,
    undefined,
    null,
  );
  assert.equal(first.data.list.length, 2);
  assert.equal(second.data.total, first.data.total);
  assert.ok(
    !second.data.list.some((u) => first.data.list.some((x) => x.id === u.id)),
  );
});
