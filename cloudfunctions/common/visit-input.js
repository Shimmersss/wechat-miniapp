const { fail, hmac, secret } = require("./gateway");
const { text } = require("./stock-input");
const routes = new Set(require("./analytics-routes.json"));
function prepare(d, headers) {
  const visitor = text(d.visitorId, "匿名标识", 100);
  if (
    !/^[A-Za-z0-9_-]{8,100}$/.test(visitor) ||
    !Array.isArray(d.events) ||
    !d.events.length ||
    d.events.length > 100
  )
    fail(400, "访问上报格式无效");
  const share = headers["X-Channel"] || headers["x-channel"] || "";
  if (share && (typeof share !== "string" || share.length > 100))
    fail(400, "分享标识无效");
  const events = [];
  for (const e of d.events) {
    if (!e || !["pv", "event"].includes(e.type)) fail(400, "事件类型无效");
    const eventId = text(e.eventId, "事件标识", 100);
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(eventId)) fail(400, "事件标识无效");
    const route = e.route
      ? text(e.route, "页面路径", 150).replace(/^\//, "")
      : "";
    if (e.type === "pv" && !routes.has(route)) continue;
    const name = e.type === "event" ? text(e.name, "事件名称", 40) : "";
    if (name && !["consult_click", "share", "poster_save"].includes(name))
      continue;
    events.push({
      eventId,
      type: e.type,
      name,
      route,
      unitId: e.unitId ? text(e.unitId, "设备编号", 60) : null,
    });
  }
  const key = secret("OTP_HASH_KEY");
  return {
    events,
    total: d.events.length,
    visitorHash: hmac(key, "visitor:" + visitor),
    shareId: share || null,
    shareHash: share ? hmac(key, "share:" + share) : null,
  };
}
module.exports = { prepare };
