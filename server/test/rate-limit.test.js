const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture } = require("./helpers");
test("咨询入口真实限流返回429信封，不能被统一错误处理改成500", async () => {
  const f = await fixture(["customer"]);
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await f.api("POST", "/shop/consults", {}, "customer")).status,
        400,
      );
    const result = await f.api("POST", "/shop/consults", {}, "customer");
    assert.equal(result.status, 429);
    assert.equal(result.code, 429);
    assert.equal(result.data, null);
    assert.match(result.message, /频繁/);
  } finally {
    await f.close();
  }
});
