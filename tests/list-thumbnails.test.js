const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "wx-server-sdk") return { init() {} };
  if (name === "./roles" && args[0]?.filename.endsWith("/cloudfunctions/common/public-unit.js"))
    return require("../miniprogram/constants/roles");
  return originalLoad.call(this, name, ...args);
};
const { thumbnailUrl } = require('../cloudfunctions/common/pg-storage');
const { publicView } = require('../cloudfunctions/common/public-unit');
Module._load = originalLoad;

test('缩略图保留访问签名，交由云存储输出 360px WebP', () => {
  const signed = 'https://example.test/v1/storages/object/sign/public/a?token=signed';
  const thumb = new URL(thumbnailUrl(signed));
  assert.equal(thumb.pathname, new URL(signed).pathname);
  assert.equal(thumb.searchParams.get('token'), 'signed');
  assert.match(thumb.search, /&imageMogr2\/thumbnail\/360x360\/format\/webp\/quality\/60$/);
});

test('公开列表视图返回封面缩略图，不回传原图或内部凭证', () => {
  const view = publicView({
    template_snapshot: { fields: [] },
    thumb_url: 'thumb-url',
    poster_url: 'video-poster-url',
    attached: [{ field_key: 'publicImages', mime: 'image/jpeg' }, { field_key: 'receipt', mime: 'image/jpeg', resolved_url: 'internal' }],
  }, 'customer');
  assert.equal(view.thumbUrl, 'thumb-url');
  assert.equal(view.posterUrl, 'video-poster-url');
  assert.equal(view.cover, 'thumb-url');
  assert.deepEqual(view.images, []);
  assert.doesNotMatch(JSON.stringify(view), /internal/);
});

test('店保未填写（null 或空）时返回 null，不显示成 0 天', () => {
  const fields = [{ key: 'shopWarranty', visibility: ['customer', 'peer'] }];
  const view = shopWarranty => publicView({ template_snapshot: { fields }, attributes: { shopWarranty }, attached: [] }, 'customer').warrantyDays;
  assert.equal(view(null), null);
  assert.equal(view(''), null);
  assert.equal(view(undefined), null);
  assert.equal(view('abc'), null);
  assert.equal(view(90), 90);
  assert.equal(view('30'), 30);
  assert.equal(view(0), 0);
});
