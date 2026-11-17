const present = (v) => v !== undefined && v !== null && String(v).trim() !== "";
function productInfo(unit) {
  // TODO(confirm): 电池健康低于多少提示、采用什么文案，暂不额外标色。
  const definitions = [
    ["grade", "成色"],
    ["battery", "电池健康"],
    ["storage", "存储容量"],
    ["ram", "运行内存"],
    ["color", "颜色"],
    ["version", "版本"],
    ["warrantyDays", "店保"],
  ];
  const info = definitions
    .filter(([key]) => present(unit[key]))
    .map(([key, label]) => ({
      key,
      label,
      value:
        key === "battery"
          ? String(unit[key]).replace(/%$/, "") + "%"
          : key === "warrantyDays"
            ? unit[key] + " 天"
            : unit[key],
    }));
  const shown = new Set(info.map((i) => i.key));
  if (shown.has("warrantyDays")) shown.add("shopWarranty");
  return {
    subtitle: [
      unit.version,
      unit.storage,
      unit.ram && "运行内存 " + unit.ram,
      unit.color,
      unit.grade,
    ]
      .filter(present)
      .join(" · "),
    info,
    publicFields: (unit.publicFields || []).filter(
      (f) => present(f.value) && !shown.has(f.key),
    ),
  };
}
module.exports = { productInfo };
