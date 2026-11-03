const test = require("node:test"),
  assert = require("node:assert/strict");
const { wechatCode } = require("../src/wechat-code");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);
const input = {
  shareId: "AbcD1234_5678-xY",
  page: "packages/shop/product/index",
};
// HTTP boundary fixtures verify request/response handling; they do not prove the live WeChat service or scan result.
test("微信码提供方：scene仅分享编号、凭据缓存合并、过期重取、图片魔数与失败显式返回", async () => {
  let requests = [],
    invalid = true;
  const cfg = {
    wx: {
      appId: "fixture-app",
      secret: "fixture-secret",
      envVersion: "develop",
      checkPath: false,
    },
  };
  const provider = wechatCode(cfg, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url.includes("stable_token"))
        return Response.json({
          access_token: "private-token",
          expires_in: 7200,
        });
      if (invalid) {
        invalid = false;
        return Response.json({ errcode: 40014 });
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  assert.equal(provider.configured(), true);
  const code = await provider.generate(input);
  assert.equal(code.mime, "image/png");
  assert.deepEqual(Buffer.from(code.base64, "base64"), png);
  const qr = requests.find((r) => r.url.includes("getwxacode"));
  assert.equal(qr.body.scene, "s=" + input.shareId);
  assert.equal(qr.body.scene.length, 18);
  assert.equal(qr.body.page, input.page);
  assert.equal(qr.body.check_path, false);
  assert.equal(qr.body.secret, undefined);
  assert.equal(
    requests.filter((r) => r.url.includes("stable_token")).length,
    2,
  );
  assert.equal(
    requests.filter((r) => r.url.includes("stable_token"))[1].body
      .force_refresh,
    true,
  );
  await Promise.all([provider.generate(input), provider.generate(input)]);
  assert.equal(
    requests.filter((r) => r.url.includes("stable_token")).length,
    2,
  );
  const bad = wechatCode(cfg, {
    fetchImpl: async () => new Response("<not an image>"),
  });
  await assert.rejects(bad.generate(input), (e) => e.statusCode === 503);
  const missing = wechatCode({ wx: {} });
  assert.equal(missing.configured(), false);
  await assert.rejects(missing.generate(input), (e) => e.statusCode === 503);
  await assert.rejects(
    provider.generate({ ...input, shareId: "forged" }),
    (e) => e.statusCode === 400,
  );
});
