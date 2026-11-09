const { fail, hash } = require("./gateway");
const { text, integer } = require("./stock-input");
const DAY = 86400000;
function date(v) {
  const s = text(v, "日期", 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    fail(400, "日期格式无效");
  return s;
}
function period(q = {}, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3600000)
      .toISOString()
      .slice(0, 10),
    day = new Date(today + "T00:00:00+08:00");
  let start = new Date(day),
    end = new Date(day.getTime() + DAY);
  if (q.from || q.to) {
    if (!q.from || !q.to) fail(400, "请同时填写起止日期");
    start = new Date(date(q.from) + "T00:00:00+08:00");
    end = new Date(Date.parse(date(q.to) + "T00:00:00+08:00") + DAY);
    if (end <= start || end - start > 366 * DAY)
      fail(400, "统计范围需为1～366天");
  } else {
    const range = q.range || "day";
    if (!["day", "week", "month"].includes(range)) fail(400, "统计周期无效");
    if (range === "week")
      start = new Date(
        day.getTime() -
          ((new Date(day.getTime() + 8 * 3600000).getUTCDay() + 6) % 7) * DAY,
      );
    if (range === "month")
      start = new Date(today.slice(0, 8) + "01T00:00:00+08:00");
  }
  return { start: start.toISOString(), end: end.toISOString() };
}
function prepare(a, input, params) {
  const d = a === "dashboard" ? {} : { ...input },
    p = { ...params };
  if (
    p.id &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      p.id,
    )
  )
    fail(400, "记录标识无效");
  if (!a.startsWith("audit.") && a !== "export.get")
    Object.assign(d, period(a === "dashboard" ? {} : d));
  if (a === "breakdown") {
    d.dimension = d.dimension || "model";
    if (!["model", "staff", "store"].includes(d.dimension))
      fail(400, "统计维度无效");
  }
  if (a === "ageing" || a === "audit.list") {
    d.page = integer(d.page || 1, "页码", 1, 1000000);
    d.pageSize = integer(d.pageSize || 20, "每页数量", 1, 1000);
    d.offset = (d.page - 1) * d.pageSize;
  }
  if (a === "ageing") d.days = integer(d.days ?? 30, "库龄", 0, 36500);
  if (a === "audit.list") {
    if (d.actorId) {
      d.actorId = text(d.actorId, "操作人", 36);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          d.actorId,
        )
      )
        fail(400, "操作人编号无效");
    }
    if (d.action) d.action = text(d.action, "动作", 80);
    if (d.objectId) d.objectId = text(d.objectId, "对象编号", 120);
    if (d.from)
      d.fromTime = new Date(date(d.from) + "T00:00:00+08:00").toISOString();
    if (d.to)
      d.toTime = new Date(
        Date.parse(date(d.to) + "T00:00:00+08:00") + DAY,
      ).toISOString();
  }
  if (a === "export.create") {
    d.reason = text(d.reason, "导出原因", 500);
    d.requestKey = text(d.requestKey, "提交标识", 80);
    d.signature = hash(
      JSON.stringify({
        range: d.range || "day",
        from: d.from || null,
        to: d.to || null,
        reason: d.reason,
      }),
    );
  }
  return { d, p };
}
module.exports = { period, prepare };
