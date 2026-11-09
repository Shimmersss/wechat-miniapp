const { fail, hash } = require("./gateway");
const { text, integer } = require("./stock-input");
const { isPhone } = require("./validate");
const { DEFAULT_SLOTS } = require("./customer-requests");
const id = (v) => {
  const s = text(v, "设备编号", 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  )
    fail(400, "记录标识无效");
  return s;
};
function config() {
  try {
    const days = Number(process.env.APPOINTMENT_DAYS || 30),
      slots = process.env.APPOINTMENT_SLOTS
        ? JSON.parse(process.env.APPOINTMENT_SLOTS)
        : process.env.APPOINTMENT_SLOTS_B64
          ? JSON.parse(
              Buffer.from(process.env.APPOINTMENT_SLOTS_B64, "base64").toString(
                "utf8",
              ),
            )
          : DEFAULT_SLOTS;
    if (
      !Number.isInteger(days) ||
      days < 1 ||
      days > 90 ||
      !Array.isArray(slots) ||
      !slots.length ||
      slots.length > 12 ||
      new Set(slots).size !== slots.length ||
      slots.some(
        (s) =>
          typeof s !== "string" || !s.trim() || s.length > 60 || s !== s.trim(),
      )
    )
      return { valid: false };
    return { valid: true, days, slots };
  } catch {
    return { valid: false };
  }
}
function options(c = config(), now = new Date()) {
  if (!c.valid) fail(503, "预约时段配置无效");
  const minDate = new Date(now.getTime() + 28800000).toISOString().slice(0, 10);
  return {
    timeSlots: c.slots,
    minDate,
    maxDate: new Date(Date.parse(minDate + "T00:00:00Z") + c.days * 86400000)
      .toISOString()
      .slice(0, 10),
    notice: "提交后由门店确认时间；预约不锁库存或价格。",
  };
}
function prepare(action, input, params = {}, headers = {}) {
  const d = { ...input },
    p = { ...params };
  if (p.id) p.id = id(p.id);
  if (
    ["consult.create", "appointment.create", "order.create"].includes(action)
  ) {
    const kind = action.split(".")[0];
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) =>
          ![
            "unitId",
            "content",
            "phone",
            "name",
            "date",
            "timeSlot",
            "requestKey",
          ].includes(k),
      )
    )
      fail(400, "提交参数无效");
    d.unitId = text(d.unitId, "设备编号", 36, true) || null;
    if (d.unitId) d.unitId = id(d.unitId);
    if (kind === "order" && !d.unitId) fail(400, "请选择要下单的设备");
    d.content = text(d.content, "咨询内容", 2000, kind !== "consult");
    d.phone = text(d.phone, "联系电话", 30);
    d.name = text(d.name, "称呼", 100, kind === "consult");
    d.requestKey = text(d.requestKey, "提交标识", 100);
    if (!isPhone(d.phone)) fail(400, "请填写11位手机号");
    d.date = kind === "appointment" ? text(d.date, "预约日期", 10) : null;
    d.timeSlot =
      kind === "appointment" ? text(d.timeSlot, "预约时段", 60) : null;
    if (
      kind === "appointment" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) ||
        !Number.isFinite(Date.parse(d.date + "T00:00:00Z")) ||
        new Date(d.date + "T00:00:00Z").toISOString().slice(0, 10) !== d.date)
    )
      fail(400, "预约日期无效");
    if (kind !== "appointment" && (input.date || input.timeSlot))
      fail(400, "咨询或下单无需预约日期");
    d.shareId = headers["X-Channel"] || headers["x-channel"] || "";
    if (typeof d.shareId !== "string" || d.shareId.length > 100)
      fail(400, "分享标识无效");
    d.signature = hash(
      JSON.stringify({
        kind,
        unitId: d.unitId,
        content: d.content,
        phone: d.phone,
        name: d.name,
        date: d.date,
        slot: d.timeSlot,
        source: d.shareId,
      }),
    );
  }
  if (["list", "staff.list"].includes(action)) {
    d.page = integer(d.page || 1, "页码", 1, 1000000);
    d.pageSize = integer(d.pageSize || 20, "每页数量", 1, 1000);
    d.offset = (d.page - 1) * d.pageSize;
    if (d.kind && !["consult", "appointment", "order"].includes(d.kind))
      fail(400, "筛选条件无效");
    if (
      d.status &&
      ![
        "new",
        "contacted",
        "confirmed",
        "completed",
        "closed",
        "cancelled",
      ].includes(d.status)
    )
      fail(400, "筛选条件无效");
    if (action === "staff.list" && d.keyword)
      d.keyword = text(d.keyword, "搜索", 100);
  }
  if (["cancel", "staff.status"].includes(action)) {
    d.requestKey = text(d.requestKey, "操作标识", 100);
    d.reason = text(d.reason, "处理说明", 500);
    d.status =
      action === "cancel" ? "cancelled" : text(d.status, "目标状态", 20);
    d.version = integer(d.version, "记录版本", 1, 2147483647);
    d.signature = hash(
      JSON.stringify({ status: d.status, version: d.version, note: d.reason }),
    );
  }
  return { d, p };
}
module.exports = { prepare, config, options };
