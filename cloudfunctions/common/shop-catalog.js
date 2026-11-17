/** 与旧 catalog.js 分组、排序和公开字段保持一致。分类顺序由 SQL 的 sort_order 决定；手机分类的品牌按首页入口顺序排。 */
// 部署时 shop-brands.js 被复制到同一 shared/ 目录；在仓库里直接加载（单元测试）时取小程序常量。
const { PHONE_CATEGORY, brandRank } = (() => {
  try {
    return require("./shop-brands");
  } catch {
    return require("../../miniprogram/constants/shop-brands");
  }
})();

function categories(result) {
  return result.categories.map((c) => {
    const brands = [];
    for (const m of result.models.filter((m) => m.category_id === c.value)) {
      let brand = brands.find((b) => b.value === m.brand);
      if (!brand) {
        brand = { value: m.brand, label: m.brand_label, series: [] };
        brands.push(brand);
      }
      let series = brand.series.find((s) => s.label === m.series);
      if (!series) {
        series = { label: m.series, models: [] };
        brand.series.push(series);
      }
      series.models.push({ id: m.id, name: m.name });
    }
    if (c.value === PHONE_CATEGORY)
      brands.sort((a, b) => brandRank(a.value, a.label) - brandRank(b.value, b.label));
    return {
      value: c.value,
      label: c.label,
      identifierMode: c.identifierMode || "imei",
      brands,
    };
  });
}
module.exports = { categories };
