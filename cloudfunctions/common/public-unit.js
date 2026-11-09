const { SENSITIVE_FIELDS } = require("./roles");
// 公开参数里永远不展示的字段（与 share-service.js publicView 一致）
const FORBIDDEN = new Set([
  ...Object.keys(SENSITIVE_FIELDS),
  "imei1",
  "imei2",
  "receipt",
  "supplier",
  "internalNote",
  "cost",
  "retail",
  "wholesale",
  "agentBase",
]);

/** 公开视图：只按模板对该渠道公开且非内部的字段取值。图片在PG侧按scope/模板可见范围筛选，并由服务端签名 */
function publicView(u, channel) {
  const audience = channel === "peer" ? "peer" : "customer";
  const a = u.attributes || {},
    fields = u.template_snapshot?.fields || [];
  const open = (f) =>
    f.visibility.includes(audience) && !f.visibility.includes("internal");
  const value = (key) =>
    fields.some((f) => f.key === key && open(f)) ? a[key] : undefined;
  const warranty = value("shopWarranty");
  return {
    id: u.id,
    modelId: u.model_id,
    name: u.name,
    brand: u.brand,
    category: u.category_id,
    condition: u.condition_type,
    storage: value("storage") || "",
    color: value("color") || "",
    grade: value("grade") || "",
    battery: value("battery"),
    version: value("version"),
    images: (u.attached || [])
      .filter(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
      )
      .map((f) => f.resolved_url),
    videos: (u.attached || [])
      .filter(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("video/"),
      )
      .map((f) => f.resolved_url),
    cover:
      (u.attached || []).find(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
      )?.resolved_url || "",
    desc: u.desc,
    price: Number(u.price),
    priceType:
      channel === "agent"
        ? "agent"
        : audience === "peer"
          ? "wholesale"
          : "retail",
    imeiMasked: u.imei_masked,
    warrantyDays:
      warranty !== undefined && warranty !== "" ? Number(warranty) : null,
    publicFields: fields
      .filter((f) => !FORBIDDEN.has(f.key) && open(f))
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        value:
          f.type === "image"
            ? (u.attached || [])
                .filter((file) => file.field_key === f.key)
                .map((file) => ({ fileId: file.id, url: file.resolved_url }))
            : a[f.key],
      }))
      .filter((f) => f.value !== undefined && f.value !== ""),
  };
}

module.exports = { publicView };
