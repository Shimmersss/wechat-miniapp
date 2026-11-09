const { fail, hash } = require("./gateway");
const { text, integer, money } = require("./stock-input");
const { isPhone } = require("./validate");
const uuid = (v) => {
  const s = text(v, "记录标识", 36);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)
  )
    fail(400, "记录标识无效");
  return s;
};
function prepare(a, input, params, user, headers) {
  const d = { ...input },
    p = { ...params };
  if (p.id) {
    if (a.startsWith("share.") || a === "share.get") {
      if (!/^[A-Za-z0-9_-]{16}$/.test(p.id)) fail(404, "分享不存在");
    } else p.id = uuid(p.id);
  }
  if (
    /\.list$/.test(a) ||
    [
      "units",
      "orders",
      "commissions",
      "admin.orders",
      "admin.earnings",
      "requests",
      "admin.requests",
    ].includes(a)
  ) {
    d.page = integer(d.page || 1, "页码", 1, 1000000);
    d.pageSize = integer(d.pageSize || 20, "每页数量", 1, 1000);
    d.offset = (d.page - 1) * d.pageSize;
    if (d.keyword) d.keyword = text(d.keyword, "搜索", 100);
  }
  const allowed = (keys) => {
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !keys.includes(k))
    )
      fail(400, "参数无效");
  };
  if (a === "apply") {
    allowed(["name", "phone", "region", "inviteCode", "agreed"]);
    if (d.agreed !== true) fail(400, "请先阅读并同意代理协议");
    d.name = text(d.name, "姓名/昵称", 50);
    d.phone = text(d.phone, "手机号", 30);
    d.region = text(d.region, "所在地区", 100);
    d.inviteCode = text(d.inviteCode, "邀请码", 8, true).toUpperCase();
    if (!isPhone(d.phone)) fail(400, "请填写11位手机号");
  }
  if (a === "markup") {
    allowed(["markup"]);
    d.markup = money(d.markup);
  }
  if (a === "admin.settings.update") {
    d.defaultMarkupMax = money(d.defaultMarkupMax);
    if (Number(d.defaultMarkupMax) > 100000) fail(400, "加价上限过大");
    d.reason = text(d.reason, "调整原因", 500);
    d.version = integer(d.version, "版本", 1, 2147483647);
  }
  if (a === "admin.review") {
    if (typeof d.approve !== "boolean") fail(400, "请选择通过或拒绝");
    d.remark = text(d.remark, "审核说明", 500);
    d.version = integer(d.version, "版本", 1, 2147483647);
    if (
      d.approve &&
      d.markupMax !== undefined &&
      d.markupMax !== null &&
      d.markupMax !== ""
    )
      d.markupMax = money(d.markupMax);
    else delete d.markupMax;
  }
  if (a === "admin.update") {
    allowed(["status", "markupMax", "reason", "version"]);
    if (d.status !== undefined && !["active", "disabled"].includes(d.status))
      fail(400, "代理状态无效");
    d.reason = text(d.reason, "调整原因", 500);
    d.version = integer(d.version, "版本", 1, 2147483647);
    if (d.markupMax !== undefined) d.markupMax = money(d.markupMax);
  }
  if (d.markupMax !== undefined && Number(d.markupMax) > 100000)
    fail(400, "加价上限过大");
  if (a === "admin.settle") {
    d.reason = text(d.reason, "转账说明", 500);
    if (!Array.isArray(d.ids) || !d.ids.length || d.ids.length > 100)
      fail(400, "请选择1～100条收益记录");
    d.ids = [...new Set(d.ids.map(uuid))].sort();
  }
  if (d.agentId) d.agentId = uuid(d.agentId);
  if (d.status) {
    let choices = ["pending", "active", "rejected", "disabled"];
    if (["orders", "admin.orders"].includes(a))
      choices = ["locked", "sold", "released"];
    if (["commissions", "admin.earnings"].includes(a))
      choices = ["pending", "settled", "reversed"];
    if (["requests", "admin.requests", "admin.request.status"].includes(a))
      choices = ["new", "contacted", "closed", "cancelled"];
    if (!choices.includes(d.status)) fail(400, "筛选状态无效");
  }
  if (a === "share.create") {
    d.channel = d.channel || "customer";
    if (!["customer", "peer", "agent"].includes(d.channel))
      fail(400, "分享渠道无效");
    const ids = d.unitIds || [d.unitId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 50)
      fail(400, "请选择1～50台不重复设备");
    d.unitIds = ids.map(uuid);
    if (new Set(d.unitIds).size !== d.unitIds.length)
      fail(400, "请选择不重复设备");
  }
  if (a === "share.revoke") d.reason = text(d.reason, "撤销说明", 500);
  if (a === "order.create") {
    allowed([
      "unitId",
      "content",
      "phone",
      "name",
      "date",
      "timeSlot",
      "requestKey",
    ]);
    d.unitId = uuid(d.unitId);
    d.content = text(d.content, "咨询内容", 2000, true);
    d.phone = text(d.phone, "联系电话", 30);
    d.name = text(d.name, "称呼", 100);
    d.requestKey = text(d.requestKey, "提交标识", 100);
    if (!isPhone(d.phone)) fail(400, "请填写11位手机号");
    if (d.date || d.timeSlot) fail(400, "下单无需预约日期");
    d.shareId = headers["X-Channel"] || headers["x-channel"] || "";
    if (typeof d.shareId !== "string" || d.shareId.length > 100)
      fail(400, "分享标识无效");
    d.signature = hash(
      JSON.stringify({
        kind: "order",
        unitId: d.unitId,
        content: d.content,
        phone: d.phone,
        name: d.name,
        date: null,
        slot: null,
        source: d.shareId,
      }),
    );
  }
  if (["order.cancel", "admin.request.status"].includes(a)) {
    d.reason = text(d.reason, "处理说明", 500);
    d.requestKey = text(d.requestKey, "操作标识", 100);
    d.version = integer(d.version, "版本", 1, 2147483647);
    d.status =
      a === "order.cancel" ? "cancelled" : text(d.status, "目标状态", 20);
    d.signature = hash(
      JSON.stringify({ status: d.status, version: d.version, note: d.reason }),
    );
  }
  return { d, p };
}
module.exports = { prepare };
