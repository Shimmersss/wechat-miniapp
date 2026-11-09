/** 与旧 catalog.js 分组、排序和公开字段保持一致。 */
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
    return { value: c.value, label: c.label, brands };
  });
}
module.exports = { categories };
