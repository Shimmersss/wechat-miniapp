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
  assert.equal((await link([a], "agent")).status, 503);
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
