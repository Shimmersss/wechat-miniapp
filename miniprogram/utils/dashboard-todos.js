const drafts = require("./inbound-draft-key");
const { ROUTES } = require("./router");
function withDrafts(todos, user) {
  const local = [];
  for (const batch of [false, true]) {
    const key = drafts.keyFor(user, batch);
    if (!key) continue;
    try {
      if (wx.getStorageSync(key)?.savedAt)
        local.push({
          key: "inboundDraft",
          text: "有未提交的入库草稿" + (batch ? "（批量）" : "（单台）"),
          count: 1,
          url: (batch ? ROUTES.INBOUND_BATCH : ROUTES.INBOUND) + "?restore=1",
        });
    } catch (e) {}
  }
  return local.concat((todos || []).filter((t) => Number(t.count) > 0));
}
// 超期维修已包含在“维修中”里：列表单独提示，计数时不重复相加
const SUBSET_OF = { repairOverdue: "repairActive" };
// 库龄预警是提醒不是待办，不计入数量
const UNCOUNTED = new Set(["ageing"]);
/** 参与数量合计的待办：去掉提醒类和被其他项包含的子集 */
function countable(todos) {
  const list = (todos || []).filter((t) => Number(t.count) > 0);
  const present = new Set(list.map((t) => t.key));
  return list.filter(
    (t) => !UNCOUNTED.has(t.key) && !present.has(SUBSET_OF[t.key]),
  );
}
const total = (todos) =>
  countable(todos).reduce((sum, t) => sum + Number(t.count), 0);
module.exports = { withDrafts, countable, total };
