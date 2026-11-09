#!/usr/bin/env node
/** 路由/页面静态核对 + 已部署公开分类的真实微信/PG验证。 */
const assert = require("node:assert/strict");
const { discover } = require("./audit-cloud-coverage");
const {
  pg,
  native,
  navigate,
  evaluate,
  save,
  guest,
} = require("./lib/cloud-verification");
const group = require("../cloudfunctions/common/shop-catalog").categories;
(async () => {
  const audit = discover();
  assert.equal(audit.missing.length, 0);
  assert.equal(audit.summary.unknownPages, 0);
  const [categories, models] = await Promise.all([
    pg("categories?select=id,label&order=created_at,id&limit=10000"),
    pg(
      "models?select=id,category_id,brand,brand_label,series,name&order=brand_label,series,name&limit=10000",
    ),
  ]);
  const expected = group({
    categories: categories.map((c) => ({ value: c.id, label: c.label })),
    models,
  });
  await guest();
  const actual = native("shop", "/shop/categories");
  assert.equal(actual.code, 0);
  assert.deepEqual(actual.data, expected);
  navigate("/pages/category/index", "switchTab");
  let page;
  for (let i = 0; i < 12; i++) {
    page = evaluate(function () {
      const p = getCurrentPages().slice(-1)[0];
      return {
        route: p.route,
        error: p.data.error,
        loading: p.data.loading,
        categories: p.data.categories?.length,
        models: p.data.categories?.flatMap((c) =>
          c.brands.flatMap((b) => b.series.flatMap((s) => s.models)),
        ).length,
      };
    });
    if (!page.loading && page.categories) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(page.error, "");
  assert.equal(page.categories, categories.length);
  assert.equal(page.models, models.length);
  navigate("/pages/shop/index", "switchTab");
  const result = {
    passed: true,
    summary: audit.summary,
    checks: [
      "59个页面及依赖、动态域引用按保守方式纳入核对，141个API方法均有正确前缀和处理器",
      "真实微信已部署分类结果与真实PG公开分类/型号逐项一致",
      "真实顾客分类页加载分类和型号，无页面错误",
    ],
    page,
    boundaries: [
      "动态方法以域方法全集保守覆盖，并另行核对repair API_METHODS与consult三种模式；静态核对不能代替真实业务验证。",
      "4个demo页面保留；蓝牙打印和正式微信凭据/小程序码为明确外部条件，没有伪造成功。",
    ],
  };
  save("coverage-results", result);
  save("coverage-audit", audit);
  console.log(JSON.stringify(result));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
