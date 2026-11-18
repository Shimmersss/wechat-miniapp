/**
 * 顾客端（对应 server/src/shop-share.js）。覆盖首页、在售列表、详情及分类目录；咨询/预约按请求前缀交由 customer。
 */
const { createHandler, rpc, fail, text } = require("./shared/gateway");
const { resolveThumbnails } = require("./shared/stock-files");
const { currentUser } = require("./shared/identity");
const sharedChannel = require("./shared/shop-channel");
const { SENSITIVE_FIELDS } = require("./shared/roles");
const { expandBrandKey } = require("./shared/shop-brands");

// 公开参数里永远不展示的字段（与 share-service.js publicView 一致）
const FORBIDDEN = new Set([
  ...Object.keys(SENSITIVE_FIELDS),
  "imei1",
  "imei2",
  "serialNo",
  "noSerialReason",
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
  if (
    !Number.isInteger(p) ||
    p < 1 ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 100
  )
    fail(400, "分页参数无效");
  return { page: p, pageSize: size, offset: (p - 1) * size };
}

/** 公开视图：只按模板对该渠道公开且非内部的字段取值。图片在PG侧按scope/模板可见范围筛选，并由服务端签名 */
function publicView(u, audience) {
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
    ram: value("ram"),
    color: value("color") || "",
    grade: value("grade") || "",
    battery: value("battery"),
    version: value("version"),
    images: (u.attached || [])
      .filter(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
      )
      .map((f) => f.resolved_url).filter(Boolean),
    videos: (u.attached || [])
      .filter(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("video/"),
      )
      .map((f) => f.resolved_url).filter(Boolean),
    thumbUrl: u.thumb_url,
    posterUrl: u.poster_url || (u.attached || []).find(f => f.field_key === "publicImages" && f.poster_url)?.poster_url,
    cover:
      u.thumb_url || u.poster_url ||
      (u.attached || []).find(
        (f) => f.field_key === "publicImages" && f.mime.startsWith("image/"),
      )?.resolved_url || "",
    desc: u.desc,
    price: Number(u.price),
    priceType: audience === "peer" ? "wholesale" : "retail",
    imeiMasked: u.imei_masked,
    serialMasked: u.serial_masked || null,
    // 按数量入库的同批设备在列表里折叠为一张卡片，lotCount 为在售件数
    lotCount: u.lot_count ? Number(u.lot_count) : null,
    // 未填写时属性可能是 null，不能转成 0 天（与 common/public-unit.js 一致）
    warrantyDays:
      warranty === undefined || warranty === null || String(warranty).trim() === "" ||
      !Number.isFinite(Number(warranty))
        ? null
        : Number(warranty),
    publicFields: fields
      .filter((f) => !FORBIDDEN.has(f.key) && open(f))
      .map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        value:
          f.type === "image"
            ? (u.attached || [])
                .filter((file) => file.field_key === f.key && file.resolved_url)
                .map((file) => ({ fileId: file.id, url: file.resolved_url }))
            : a[f.key],
      }))
      .filter((f) => f.value !== undefined && f.value !== ""),
  };
}

async function units(ctx) {
  if (sharedChannel.sid(ctx))
    return sharedChannel.list(ctx, await currentUser(ctx));
  const q = ctx.data,
    p = page(q),
    user = await currentUser(ctx),
    peer = user?.role === "peer";
  const amount = (v, label) => {
    if (v === undefined || v === "") return undefined;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(String(v)))
      fail(400, label + "须为非负金额，最多两位小数");
    return String(v);
  };
  const priceMin = amount(q.priceMin, "最低价"),
    priceMax = amount(q.priceMax, "最高价");
  if (
    priceMin !== undefined &&
    priceMax !== undefined &&
    Number(priceMin) > Number(priceMax)
  )
    fail(400, "最低价不能高于最高价");
  let batteryMin;
  if (q.batteryMin !== undefined && q.batteryMin !== "") {
    if (!/^\d{1,3}$/.test(String(q.batteryMin)) || Number(q.batteryMin) > 100)
      fail(400, "电池健康须为0～100的整数");
    batteryMin = String(q.batteryMin);
  }
  if (q.condition && !["used", "new"].includes(q.condition))
    fail(400, "设备类型无效");
  if (q.sort && !["price_asc", "price_desc"].includes(q.sort))
    fail(400, "排序方式无效");
  const opt = (v, label, max) => (v ? text(v, label, max) : undefined);
  // 首页入口只传 key，品牌别名由服务端展开，不接受客户端传品牌数组
  let entry = {};
  if (q.brandKey) {
    entry = expandBrandKey(text(q.brandKey, "品牌入口", 30));
    if (!entry) fail(400, "品牌入口无效");
  }
  const res = await rpc("api_shop_units", {
    p: {
      flag: peer ? "sharePeer" : "showInShop",
      audience: peer ? "peer" : "customer",
      brand: opt(q.brand, "品牌", 50),
      category: entry.category || opt(q.category, "分类", 60),
      brandNames: entry.brandNames,
      excludeBrandNames: entry.excludeBrandNames,
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
  await resolveThumbnails(res.rows, user);
  return {
    list: res.rows.map((u) => publicView(u, peer ? "peer" : "customer")),
    total: Number(res.total),
    page: p.page,
    pageSize: p.pageSize,
  };
}

async function home(ctx) {
  if (sharedChannel.sid(ctx))
    return sharedChannel.home(ctx, await currentUser(ctx));
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
  [
    "GET",
    "/shop/categories",
    async () =>
      require("./shared/shop-catalog").categories(
        await rpc("api_shop_catalog", {}),
      ),
  ],
  ["GET", "/shop/units", units],
  [
    "GET",
    "/shop/units/:id",
    async (ctx) => sharedChannel.detail(ctx, await currentUser(ctx)),
  ],
]);
