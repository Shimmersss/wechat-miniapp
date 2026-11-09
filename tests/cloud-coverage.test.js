const test = require("node:test"),
  assert = require("node:assert/strict");
const { discover } = require("../scripts/audit-cloud-coverage");
const { categories } = require("../cloudfunctions/common/shop-catalog");
test("已登记页面的API及上传路径均有匹配云函数，精确复合前缀不被域前缀遮挡", () => {
  const r = discover();
  assert.equal(r.summary.pages, 59);
  assert.equal(r.summary.demoPages, 4);
  assert.deepEqual(r.missing, []);
  assert.equal(r.summary.unknownPages, 0);
  assert.equal(r.summary.utilityRoutes, 2);
  assert.ok(
    r.utilityRoutes.every((route) => route.covered && route.fn === "files"),
  );
  assert.equal(
    r.apis.find((x) => x.module === "shop" && x.name === "categories").covered,
    true,
  );
  assert.equal(
    r.apis.find((x) => x.module === "dashboard").fn,
    "staff-reports",
  );
  assert.ok(
    r.pages.find((p) => p.page === "packages/staff/inbound/batch").uploads,
  );
});
test("公开分类只保留分类/品牌/系列/型号白名单，空分类保留，型号可按id精确筛选", () => {
  const result = categories({
    categories: [
      { value: "phone", label: "手机", private: "secret" },
      { value: "tablet", label: "平板" },
    ],
    models: [
      {
        id: "a",
        category_id: "phone",
        brand: "brand",
        brand_label: "品牌",
        series: "系列一",
        name: "型号一",
        cost: 5,
      },
      {
        id: "b",
        category_id: "phone",
        brand: "brand",
        brand_label: "品牌",
        series: "系列二",
        name: "型号二",
        supplier: "secret",
      },
    ],
  });
  assert.deepEqual(result, [
    {
      value: "phone",
      label: "手机",
      brands: [
        {
          value: "brand",
          label: "品牌",
          series: [
            { label: "系列一", models: [{ id: "a", name: "型号一" }] },
            { label: "系列二", models: [{ id: "b", name: "型号二" }] },
          ],
        },
      ],
    },
    { value: "tablet", label: "平板", brands: [] },
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
