const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, imei, attributes } = require("./helpers");
const { client, page } = require("./page-helpers");
let f,
  id,
  api,
  storage = new Map();
test.before(async () => {
  global.wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
  };
  f = await fixture();
  api = client(f, "boss");
  const m = (
      await f.api("POST", "/models", {
        category: "phone",
        name: "分享页面_" + Date.now(),
        brandLabel: "页面",
        series: "验证",
        copyTemplateId: "t_phone",
        tacs: [],
      })
    ).data,
    t = (await f.api("GET", "/templates/" + m.templateId)).data,
    s = (
      await f.api("POST", "/suppliers", { name: "分享页面货源_" + Date.now() })
    ).data,
    r = await f.upload();
  id = (
    await f.api("POST", "/inbound/units", {
      modelId: m.id,
      templateVersion: t.version,
      supplierId: s.id,
      imei1: imei(),
      inspectionConfirmed: true,
      attributes: attributes(t, r),
      cost: "100",
      retail: "150.68",
      wholesale: "130.35",
      agentBase: "120",
      flags: { showInShop: true, sharePeer: true, shareAgent: false },
    })
  ).data.id;
});
test.after(async () => f?.close());
const event = (id) => ({ currentTarget: { dataset: { id } } });
test("分享页面真实API：不默认设备、查找多选、切换清旧价、预览与撤销", async () => {
  const p = page("miniprogram/packages/staff/share/index.js", api);
  p.onLoad({});
  assert.equal(p.data.selected.length, 0);
  assert.equal(p.data.share, null);
  p.setData({ keyword: id });
  await p.search();
  assert.equal(p.data.results.length, 1);
  p.onAdd(event(id));
  p.onAdd(event(id));
  assert.equal(p.data.selected.length, 1);
  await p.createLink();
  assert.equal(p.data.share.price, 150.68);
  assert.match(p.data.share.path, /\?s=[A-Za-z0-9_-]{16}$/);
  p.onAudienceTap({ currentTarget: { dataset: { value: "peer" } } });
  assert.equal(p.data.share, null);
  await p.createLink();
  assert.equal(p.data.share.price, 130.35);
  p.onPreview();
  assert.equal(p.navigation[0].query.s, p.data.share.shareId);
  await p.onRevoke();
  assert.equal(p.data.share, null);
  assert.equal(p.confirmations.at(-1).needReason, true);
  p.onAudienceTap({ currentTarget: { dataset: { value: "agent" } } });
  await p.createLink();
  assert.match(p.data.error, /仅已审核通过的代理/);
  assert.equal(p.data.share, null);
});
test("仅s打开商品/合集，失效时清旧商品；迟到分享结果不能覆盖新渠道", async () => {
  storage.clear();
  const share = await api.share.createLink({ unitId: id, channel: "customer" }),
    wx = { setNavigationBarTitle: () => {} };
  const p = page(
    "miniprogram/packages/shop/product/index.js",
    api,
    "customer",
    { wx },
  );
  await p.onLoad({ s: share.shareId });
  assert.equal(p.data.id, id);
  assert.equal(p.data.unit.price, 150.68);
  const c = page(
    "miniprogram/packages/shop/collection/index.js",
    api,
    "customer",
    { wx },
  );
  await c.onLoad({ s: share.shareId });
  assert.equal(c.data.share.units[0].id, id);
  c.onSelect({ detail: { id } });
  assert.equal(c.navigation[0].query.s, share.shareId);
  await api.share.revoke(share.shareId, { reason: "验证失效页面" });
  await p.load();
  assert.equal(p.data.unit, null);
  assert.ok(p.data.error);
  let finish;
  const original = api.share.createLink;
  api.share.createLink = () => new Promise((r) => (finish = r));
  const staff = page("miniprogram/packages/staff/share/index.js", api);
  staff.setData({ selected: [{ id }] });
  const pending = staff.createLink();
  staff.onAudienceTap({ currentTarget: { dataset: { value: "peer" } } });
  finish(share);
  await pending;
  assert.equal(staff.data.share, null);
  assert.equal(staff.data.active, "peer");
  api.share.createLink = original;
});
test("顾客搜索页：价格输入只是草稿，点确定前翻页/切换筛选不带入价格", async () => {
  const calls = [],
    stub = {
      shop: {
        units: async (q) => {
          calls.push(q);
          return { list: [{ id: "x" + calls.length }], total: 100 };
        },
      },
    };
  const p = page(
    "miniprogram/packages/shop/search/index.js",
    stub,
    "customer",
    {
      wx: {
        getStorageSync: () => [],
        setStorageSync() {},
        removeStorageSync() {},
      },
    },
  );
  await p.onLoad({});
  const field = (name, value) => ({
    currentTarget: { dataset: { field: name } },
    detail: { value },
  });
  p.onPriceInput(field("priceMin", "100"));
  p.onPriceInput(field("priceMax", "200"));
  await p.onReachBottom();
  await p.onPick({
    currentTarget: { dataset: { field: "grade", value: "99新" } },
  });
  for (const q of calls) {
    assert.equal(q.priceMin, undefined);
    assert.equal(q.priceMax, undefined);
  }
  assert.equal(p.data.filterCount, 1);
  await p.onApplyPrice();
  assert.equal(calls.at(-1).priceMin, "100");
  assert.equal(calls.at(-1).priceMax, "200");
  assert.equal(calls.at(-1).grade, "99新");
  assert.equal(p.data.filterCount, 2);
  p.onPriceInput(field("priceMin", "300"));
  await p.onApplyPrice();
  assert.match(p.notices.at(-1), /最低价不能高于最高价/);
  assert.equal(p.data.priceMin, "100");
  await p.onResetFilter();
  assert.equal(p.data.priceMinDraft, "");
  assert.equal(calls.at(-1).priceMin, undefined);
});
