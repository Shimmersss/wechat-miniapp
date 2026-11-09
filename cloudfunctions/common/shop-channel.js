/** 最多50台分享设备已由PG整体验证快照/资格；只在这组公开结果内筛选和分页。 */
const { rpc, fail } = require("./gateway");
const { resolveFiles } = require("./stock-files");
const { publicView } = require("./public-unit");
const { integer, money, text } = require("./stock-input");
const sid = (ctx) => ctx.headers["X-Channel"] || ctx.headers["x-channel"];
async function share(ctx, user) {
  const r = await rpc("api_agents", {
    p_action: "share.get",
    p_id: sid(ctx),
    p_data: {},
    p_user: user,
    p_request_id: ctx.requestId,
    p_config: {},
  });
  await resolveFiles(r, user);
  return {
    channel: r.link.channel,
    brands: [
      ...new Map(
        r.units.map((u) => [
          u.brand,
          { value: u.brand, label: u.brand_label || u.brand },
        ]),
      ).values(),
    ],
    units: r.units.map((v) => publicView(v, r.link.channel)),
  };
}
async function list(ctx, user) {
  const { units } = await share(ctx, user),
    q = ctx.data,
    page = integer(q.page || 1, "页码", 1, 1000000),
    pageSize = integer(q.pageSize || 20, "每页数量", 1, 1000);
  let rows = units;
  const min =
      q.priceMin !== undefined && q.priceMin !== ""
        ? Number(money(q.priceMin))
        : null,
    max =
      q.priceMax !== undefined && q.priceMax !== ""
        ? Number(money(q.priceMax))
        : null;
  if (min !== null && max !== null && min > max)
    fail(400, "最低价不能高于最高价");
  if (q.sort && !["price_asc", "price_desc"].includes(q.sort))
    fail(400, "排序方式无效");
  if (q.condition && !["used", "new"].includes(q.condition))
    fail(400, "设备类型无效");
  const battery =
    q.batteryMin !== undefined && q.batteryMin !== ""
      ? integer(q.batteryMin, "电池健康", 0, 100)
      : null;
  for (const k of ["brand", "category", "modelId"])
    if (q[k] && q[k] !== "all") rows = rows.filter((r) => r[k] === q[k]);
  if (q.condition) rows = rows.filter((r) => r.condition === q.condition);
  if (q.grade) rows = rows.filter((r) => r.grade === q.grade);
  if (q.keyword) {
    const kw = text(q.keyword, "搜索", 100).toLowerCase();
    rows = rows.filter((r) =>
      [r.name, r.storage, r.color].some((v) =>
        String(v).toLowerCase().includes(kw),
      ),
    );
  }
  rows = rows.filter(
    (r) =>
      (min === null || r.price >= min) &&
      (max === null || r.price <= max) &&
      (battery === null ||
        (r.battery !== undefined &&
          Number(String(r.battery).replace("%", "")) >= battery)),
  );
  if (q.sort)
    rows.sort((a, b) =>
      q.sort === "price_asc" ? a.price - b.price : b.price - a.price,
    );
  return {
    list: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  };
}
async function home(ctx, user) {
  const { units, brands } = await share(ctx, user);
  return {
    todayStock: units.length,
    brands: [{ value: "all", label: "全部" }, ...brands],
    banners: [],
  };
}
async function detail(ctx, user) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      ctx.params.id,
    )
  )
    fail(400, "记录标识无效");
  if (sid(ctx)) {
    const { units } = await share(ctx, user),
      r = units.find((r) => r.id === ctx.params.id);
    if (!r) fail(404, "商品不在本分享内");
    return r;
  }
  const r = await rpc("agent_shop_unit", { p_id: ctx.params.id, p_user: user });
  await resolveFiles(r, user);
  return publicView(r, user?.role === "peer" ? "peer" : "customer");
}
module.exports = { sid, list, home, detail };
