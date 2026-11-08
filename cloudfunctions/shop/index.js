/**
 * 顾客端（对应 server/src/shop-share.js）。最小闭环迁移首页与在售列表，其余路由返回“尚未迁移”。
 */
const { createHandler, rpc, fail, text } = require("./shared/gateway");
const { currentUser } = require("./shared/identity");
const { SENSITIVE_FIELDS } = require("./shared/roles");

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

function page(q) {
  const p = Number(q.page || 1),
    size = Number(q.pageSize || 20);
  if (!Number.isInteger(p) || p < 1 || !Number.isInteger(size) || size < 1 || size > 100)
    fail(400, "分页参数无效");
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/** 公开视图：只按模板对该渠道公开且非内部的字段取值。图片待文件迁到云存储后补上 */
function publicView(u, audience) {
  const a = u.attributes || {},
    fields = u.template_snapshot?.fields || [];
  const open = (f) => f.visibility.includes(audience) && !f.visibility.includes("internal");
  const value = (key) => (fields.some((f) => f.key === key && open(f)) ? a[key] : undefined);
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
    // TODO(codex): 设备照片/视频迁到云存储后返回
    images: [],
    videos: [],
    cover: "",
    desc: u.desc,
    price: Number(u.price),
    priceType: audience === "peer" ? "wholesale" : "retail",
    imeiMasked: u.imei_masked,
    warrantyDays: warranty !== undefined && warranty !== "" ? Number(warranty) : null,
    publicFields: fields
      .filter((f) => !FORBIDDEN.has(f.key) && open(f) && f.type !== "image")
      .map((f) => ({ key: f.key, label: f.label, type: f.type, value: a[f.key] }))
      .filter((f) => f.value !== undefined && f.value !== ""),
  };
}

async function units(ctx) {
  // TODO(codex): 分享链接（X-Channel）按分享快照价展示，需迁移 share-service 后再支持
  if (ctx.headers["X-Channel"]) fail(501, "分享链接列表尚未迁移到云开发");
  const q = ctx.data,
    p = page(q),
    user = await currentUser(ctx),
    peer = user?.role === "peer";
  const amount = (v, label) => {
    if (v === undefined || v === "") return undefined;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(v))) fail(400, label + "须为非负金额，最多两位小数");
    return String(v);
  };
  const priceMin = amount(q.priceMin, "最低价"),
    priceMax = amount(q.priceMax, "最高价");
  if (priceMin !== undefined && priceMax !== undefined && Number(priceMin) > Number(priceMax))
    fail(400, "最低价不能高于最高价");
  let batteryMin;
  if (q.batteryMin !== undefined && q.batteryMin !== "") {
    if (!/^\d{1,3}$/.test(String(q.batteryMin)) || Number(q.batteryMin) > 100)
      fail(400, "电池健康须为0～100的整数");
    batteryMin = String(q.batteryMin);
  }
  if (q.condition && !["used", "new"].includes(q.condition)) fail(400, "设备类型无效");
  if (q.sort && !["price_asc", "price_desc"].includes(q.sort)) fail(400, "排序方式无效");
  const opt = (v, label, max) => (v ? text(v, label, max) : undefined);
  const res = await rpc("api_shop_units", {
    p: {
      flag: peer ? "sharePeer" : "showInShop",
      audience: peer ? "peer" : "customer",
      brand: opt(q.brand, "品牌", 50),
      category: opt(q.category, "分类", 60),
      modelId: opt(q.modelId, "型号", 60),
      condition: q.condition || undefined,
      keyword: opt(q.keyword, "搜索", 100),
      priceMin,
      priceMax,
      grade: opt(q.grade, "成色", 20),
      batteryMin,
      sort: q.sort || undefined,
      limit: p.pageSize,
      offset: p.offset,
    },
  });
  return {
    list: res.rows.map((u) => publicView(u, peer ? "peer" : "customer")),
    total: Number(res.total),
    page: p.page,
    pageSize: p.pageSize,
  };
}

async function home(ctx) {
  // TODO(codex): 分享链接（X-Channel）只展示分享内设备，需迁移 share-service 后再支持
  if (ctx.headers["X-Channel"])
    fail(501, "分享链接首页尚未迁移到云开发");
  const user = await currentUser(ctx);
  const flag = user?.role === "peer" ? "sharePeer" : "showInShop";
  const { count, brands } = await rpc("api_shop_home", { p_flag: flag });
  return {
    todayStock: Number(count),
    brands: [{ value: "all", label: "全部" }, ...brands],
    banners: [],
  };
}

exports.main = createHandler([
  ["GET", "/shop/home", home],
  ["GET", "/shop/units", units],
]);
