const { createPage } = require("../../../utils/page");
const api = require("../../../api/index");
const { PERM } = require("../../../constants/roles");
const { REPAIR_STATUS } = require("../../../constants/status");
const { PAYMENT_TYPES } = require("../../../constants/repair");
const { confirmSensitive } = require("../../../utils/confirm");
const { upload } = require("../../../utils/request");
const events = require("../../../utils/events");
const terminal = (status) => ["completed", "cancelled"].includes(status);
const timeLabel = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? new Date(at + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ")
    : "";
};
let sequence = 0;
createPage({
  requireStaff: true,
  permission: [PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.REPAIR_QUOTE],
  data: {
    id: "",
    detail: null,
    statusMap: REPAIR_STATUS,
    paymentLabels: PAYMENT_TYPES,
    methods: ["微信", "支付宝", "现金", "银行卡", "其他"],
    editor: null,
    focusAmount: false,
    pending: null,
    loading: false,
    saving: false,
    uploading: false,
    confirming: false,
    error: "",
  },
  onLoad(query) {
    this.setData({ id: query.id || "" });
    return this.load();
  },
  onShow() {
    if (this.loaded && !this.locked() && !this.data.editor) return this.load();
  },
  onUnload() {
    this.destroyed = true;
  },
  onPullDownRefresh() {
    if (this.locked() || this.data.editor) return wx.stopPullDownRefresh();
    return this.load().finally(() => wx.stopPullDownRefresh());
  },
  locked() {
    return (
      this.data.loading ||
      this.data.saving ||
      this.data.uploading ||
      this.data.confirming ||
      !!this.data.pending
    );
  },
  apply(detail) {
    this.loaded = true;
    this.setData({
      detail: {
        ...detail,
        timeline: (detail.timeline || []).map((item) => ({
          ...item,
          timeLabel: timeLabel(item.time),
        })),
      },
      active: !terminal(detail.status),
    });
  },
  async load() {
    if (this.locked()) return;
    this.setData({ loading: true, error: "" });
    try {
      const detail = await api.repair.detail(this.data.id);
      if (!detail) throw Error("维修单不存在");
      if (!this.destroyed) this.apply(detail);
    } catch (e) {
      if (!this.destroyed) this.setData({ error: e.message });
    } finally {
      if (!this.destroyed) this.setData({ loading: false });
    }
  },
  onOpen(e) {
    if (this.locked()) return;
    const mode = e.currentTarget.dataset.mode,
      d = this.data.detail;
    if (
      !d ||
      !this.data.active ||
      (mode === "close"
        ? !d.canCash
        : mode === "cancel"
          ? !(d.canManage || d.canRefund)
          : !d.canManage)
    )
      return;
    this.setData({
      editor: {
        mode,
        amount: "",
        cost: "",
        note: mode === "update" ? d.diagnosis || "" : "",
        methodIndex: 0,
        photos: [],
      },
      focusAmount: false,
      error: "",
    }, () => {
      if (mode !== "close" || this.destroyed || this.data.editor?.mode !== mode) return;
      wx.pageScrollTo({ selector: "#close-editor", offsetTop: -16, duration: 200 });
      this.setData({ focusAmount: true });
    });
  },
  onAmountBlur() {
    if (this.data.focusAmount) this.setData({ focusAmount: false });
  },
  onInput(e) {
    if (!this.locked())
      this.setData({
        ["editor." + e.currentTarget.dataset.field]: e.detail.value,
      });
  },
  onDismiss() {
    if (!this.locked()) this.setData({ editor: null });
  },
  async onPhotos() {
    if (
      this.locked() ||
      !this.data.editor ||
      this.data.editor.photos.length >= 9
    )
      return;
    this.setData({ uploading: true });
    try {
      const selected = await wx.chooseMedia({
        count: 9 - this.data.editor.photos.length,
        mediaType: ["image"],
        sizeType: ["compressed"],
      });
      const photos = await Promise.all(
        selected.tempFiles.map((f) =>
          upload({
            filePath: f.tempFilePath,
            scope: "internal",
            bizType: "repair",
          }),
        ),
      );
      if (!this.destroyed)
        this.setData({
          "editor.photos": this.data.editor.photos.concat(photos),
        });
    } catch (e) {
      if (!/cancel/.test(e.errMsg || ""))
        this.$toast(e.message || "上传未完成");
    } finally {
      if (!this.destroyed) this.setData({ uploading: false });
    }
  },
  onRemovePhoto(e) {
    if (!this.locked())
      this.setData({
        "editor.photos": this.data.editor.photos.filter(
          (f, i) => i !== Number(e.currentTarget.dataset.index),
        ),
      });
  },
  async onSubmit(e) {
    if (this.locked() || !this.data.editor) return;
    const editor = this.data.editor,
      detail = this.data.detail;
    const refund = e?.currentTarget?.dataset?.refund;
    const money = (v) => /^\d{1,12}(\.\d{1,2})?$/.test(String(v));
    if (
      editor.mode === "close" &&
      (!money(editor.amount) ||
        (detail.canExpense && editor.cost !== "" && !money(editor.cost)))
    )
      return this.$toast("请填写有效收费，最多两位小数");
    let action = editor.mode,
      body = {};
    const photos = editor.photos.map((f) => ({ fileId: f.fileId }));
    if (action === "close")
      body = {
        amount: editor.amount,
        method: this.data.methods[Number(editor.methodIndex)],
        confirmed: true,
        note: editor.note,
        proof: photos,
        ...(detail.canExpense && editor.cost !== ""
          ? { cost: editor.cost }
          : {}),
      };
    if (action === "update")
      body = {
        diagnosis: editor.note || detail.diagnosis || "补充照片",
        photos,
      };
    if (action === "cancel") {
      if (refund && detail.canRefund && detail.received > 0) {
        action = "payment";
        body = {
          kind: "refund",
          amount: String(detail.received),
          method: this.data.methods[Number(editor.methodIndex)],
          confirmed: true,
          proof: photos,
        };
      } else {
        if (!detail.canManage) return this.$toast("无权限取消维修");
        if (detail.received > 0) return this.$toast("请先退清已收款");
        action = "transition";
        body = { to: "cancelled" };
      }
    }
    this.setData({ confirming: true });
    const confirmation = await confirmSensitive({
      title:
        action === "close"
          ? "确认结单收款"
          : action === "payment"
            ? "确认已实际退款"
            : "确认维修处理",
      needReason: true,
      content: "填写处理原因，确认已实际办理",
    });
    if (this.destroyed) return;
    this.setData({ confirming: false });
    if (!confirmation.confirmed) return;
    body = {
      ...body,
      version: detail.version,
      reason: confirmation.reason,
      requestKey: "repair_" + Date.now() + "_" + ++sequence,
    };
    this.setData({ pending: { action, body } });
    return this.onRetry();
  },
  async onRetry() {
    if (!this.data.pending || this.data.saving) return;
    this.setData({ saving: true, error: "" });
    try {
      const { action, body } = this.data.pending;
      const detail = await api.repair[action](this.data.id, body);
      if (this.destroyed) return;
      this.setData({ pending: null, editor: null });
      this.apply(detail);
      if (action === "close") wx.pageScrollTo({ scrollTop: 0, duration: 200 });
      events.emit("inventory:changed", { repairId: detail.id });
    } catch (e) {
      if (!this.destroyed)
        this.setData({
          error: e.message,
          ...(Number(e.code) >= 400 && Number(e.code) < 500
            ? { pending: null }
            : {}),
        });
    } finally {
      if (!this.destroyed) this.setData({ saving: false });
    }
  },
});
