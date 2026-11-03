const { createPage } = require("../../../utils/page");
const api = require("../../../api/index");
const { PERM } = require("../../../constants/roles");
const { REPAIR_STATUS } = require("../../../constants/status");
const { TRANSITIONS, PAYMENT_TYPES } = require("../../../constants/repair");
const { confirmSensitive } = require("../../../utils/confirm");
const { upload } = require("../../../utils/request");
const { isPhone } = require("../../../utils/validate");
const { ROUTES } = require("../../../utils/router");
const events = require("../../../utils/events");
let sequence = 0;
const key = () =>
  "repair_action_" +
  Date.now() +
  "_" +
  ++sequence +
  "_" +
  Math.random().toString(36).slice(2);
const copy = (v) => JSON.parse(JSON.stringify(v));
const amount = (v) => /^\d{1,12}(\.\d{1,2})?$/.test(String(v));
const count = (v) =>
  /^\d+$/.test(String(v)) && Number(v) > 0 && Number(v) <= 1000000;
const terminal = (status) => ["completed", "cancelled"].includes(status);
const time = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? new Date(at + 28800000).toISOString().slice(0, 16).replace("T", " ")
    : "";
};
const ACTION_LABELS = {
  create: "创建维修单",
  update: "更新维修资料",
  quote: "维修报价",
  confirm: "确认当前报价",
  issue: "领用配件",
  return_parts: "退回配件",
  payment: "收支登记",
  transition: "节点处理",
};
const API_METHODS = {
  update: "update",
  quote: "quote",
  confirm: "confirm",
  issue: "issueParts",
  returnParts: "returnParts",
  payment: "payment",
  transition: "transition",
};
createPage({
  requireStaff: true,
  permission: [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH],
  data: {
    id: "",
    detail: null,
    statusMap: REPAIR_STATUS,
    paymentLabels: PAYMENT_TYPES,
    actionLabels: ACTION_LABELS,
    options: null,
    engineers: [],
    loading: false,
    saving: false,
    uploading: false,
    confirming: false,
    error: "",
    editor: null,
    pending: null,
    transitions: [],
    paymentKinds: [],
    canEdit: false,
    canQuote: false,
    canConfirm: false,
    canIssue: false,
    canReturn: false,
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
    this._load = (this._load || 0) + 1;
    this._search = (this._search || 0) + 1;
  },
  onPullDownRefresh() {
    if (this.locked() || this.data.editor) {
      wx.stopPullDownRefresh();
      return this.$toast("请先保存或关闭当前操作");
    }
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
    const active = !terminal(detail.status),
      transitions = detail.canManage
        ? (TRANSITIONS[detail.status] || []).map((to) => ({
            to,
            label: REPAIR_STATUS[to].label,
          }))
        : [],
      paymentKinds = [];
    if (detail.canCash) {
      if (detail.kind === "external") {
        if (detail.quote !== null && detail.status !== "cancelled")
          paymentKinds.push({ value: "receipt", label: "登记收款" });
        if (detail.canRefund && detail.received > 0)
          paymentKinds.push({ value: "refund", label: "登记退款" });
      }
      if (detail.canExpense && (detail.kind !== "inventory" || active)) {
        paymentKinds.push({ value: "expense", label: "登记维修费用" });
        if (detail.canRefund && detail.expenses > 0)
          paymentKinds.push({ value: "expense_refund", label: "登记费用退回" });
      }
    }
    this.setData({
      detail: {
        ...detail,
        timeline: detail.timeline.map((t) => ({
          ...t,
          timeLabel: time(t.time),
        })),
        payments: detail.payments.map((p) => ({
          ...p,
          timeLabel: time(p.time),
        })),
      },
      transitions,
      paymentKinds,
      canEdit: detail.canManage && active,
      canQuote:
        detail.canQuote &&
        ["checking", "pending_confirm"].includes(detail.status),
      canConfirm:
        detail.canManage &&
        detail.status === "pending_confirm" &&
        detail.quote !== null &&
        detail.confirmedVersion !== detail.quoteVersion &&
        (detail.kind === "external" || detail.canAssign),
      canIssue: detail.canManage && detail.status === "repairing",
      canReturn:
        detail.canManage &&
        ["repairing", "pending_pickup"].includes(detail.status),
    });
  },
  async load() {
    if (this.locked()) return;
    const revision = (this._load = (this._load || 0) + 1);
    this.setData({ loading: true, error: "" });
    try {
      const [detail, options] = await Promise.all([
        api.repair.detail(this.data.id),
        api.repair.options(),
      ]);
      if (this.destroyed || revision !== this._load) return;
      this.apply(detail);
      this.setData({
        options,
        engineers: [{ id: "", name: "暂不分派" }, ...options.engineers],
      });
      this.loaded = true;
    } catch (e) {
      if (!this.destroyed && revision === this._load)
        this.setData({ detail: null, error: e.message });
    } finally {
      if (!this.destroyed && revision === this._load)
        this.setData({ loading: false });
    }
  },
  open(kind, title, extra = {}) {
    if (this.locked() || this.data.editor || !this.data.detail) return false;
    this._search = (this._search || 0) + 1;
    this.setData(
      {
        error: "",
        editor: {
          kind,
          title,
          version: this.data.detail.version,
          photos: [],
          values: {},
          conflict: false,
          ...extra,
        },
      },
      () => wx.pageScrollTo({ selector: "#repair-editor", duration: 200 }),
    );
    return true;
  },
  onEdit() {
    const d = this.data.detail;
    if (!this.data.canEdit) return;
    const values = {
      fault: d.fault,
      diagnosis: d.diagnosis || "",
      expectedAt: d.expectedAt || "",
      waitingParts: d.waitingParts,
      ...(d.canAssign
        ? {
            engineerId: d.engineerId || "",
            ...(d.kind === "external"
              ? { customer: d.customer, phone: d.phone }
              : {}),
          }
        : {}),
    };
    this.open("update", "更新检测与维修资料", {
      values: copy(values),
      baseline: copy(values),
      engineerIndex: Math.max(
        0,
        this.data.engineers.findIndex((e) => e.id === values.engineerId),
      ),
    });
  },
  onQuote() {
    if (this.data.canQuote)
      this.open("quote", "记录维修报价", {
        values: {
          amount:
            this.data.detail.quote === null
              ? ""
              : String(this.data.detail.quote),
        },
      });
  },
  onConfirmQuote() {
    if (this.data.canConfirm)
      this.open("confirm", "确认当前维修方案与报价", {
        quoteVersion: this.data.detail.quoteVersion,
        values: { accepted: false },
      });
  },
  onTransition(e) {
    const to = e.currentTarget.dataset.to;
    if (!this.data.transitions.some((t) => t.to === to)) return;
    this.open("transition", "转为" + REPAIR_STATUS[to].label, {
      to,
      values: { result: "", pickupName: "", warrantyDays: "" },
    });
  },
  onPayment(e) {
    const kind = e.currentTarget.dataset.kind,
      item = this.data.paymentKinds.find((p) => p.value === kind);
    if (item)
      this.open("payment", item.label, {
        paymentKind: kind,
        methodIndex: 0,
        methods: ["微信", "支付宝", "现金", "银行卡", "其他"],
        values: { amount: "", accepted: false },
      });
  },
  async onIssue() {
    if (!this.data.canIssue) return;
    if (
      this.open("issue", "领用维修配件", {
        values: { quantity: "1", partId: "" },
        keyword: "",
        parts: [],
        partPage: 0,
        partMore: false,
        searching: false,
      })
    )
      return this.searchParts(true);
  },
  onReturn(e) {
    if (!this.data.canReturn) return;
    const part = this.data.detail.parts.find(
      (p) => p.id === e.currentTarget.dataset.id,
    );
    if (part && part.quantity > part.returned)
      this.open("returnParts", "退回未使用配件", {
        issueId: part.id,
        partName: part.name,
        remaining: part.quantity - part.returned,
        values: { quantity: "1" },
      });
  },
  onClose() {
    if (!this.locked()) {
      this._search = (this._search || 0) + 1;
      this.setData({ editor: null, error: "" });
    }
  },
  onInput(e) {
    if (!this.locked() && !this.data.editor?.conflict)
      this.setData({
        ["editor.values." + e.currentTarget.dataset.field]: e.detail.value,
      });
  },
  onEngineer(e) {
    if (this.locked() || this.data.editor?.conflict) return;
    const index = Number(e.detail.value),
      person = this.data.engineers[index];
    if (person)
      this.setData({
        "editor.engineerIndex": index,
        "editor.values.engineerId": person.id,
      });
  },
  onMethod(e) {
    if (!this.locked() && !this.data.editor?.conflict)
      this.setData({ "editor.methodIndex": Number(e.detail.value) });
  },
  onPartKeyword(e) {
    if (!this.locked()) this.setData({ "editor.keyword": e.detail.value });
  },
  onSearchParts() {
    return this.searchParts(true);
  },
  onMoreParts() {
    return this.searchParts(false);
  },
  async searchParts(reset) {
    if (this.data.editor?.kind !== "issue" || this.locked()) return;
    const revision = (this._search = (this._search || 0) + 1),
      page = reset ? 1 : this.data.editor.partPage + 1;
    this.setData({ "editor.searching": true });
    try {
      const r = await api.repair.parts({
        keyword: this.data.editor.keyword.trim(),
        page,
        pageSize: 20,
      });
      if (
        this.destroyed ||
        revision !== this._search ||
        this.data.editor?.kind !== "issue"
      )
        return;
      this.setData({
        "editor.parts": reset ? r.list : this.data.editor.parts.concat(r.list),
        "editor.partPage": page,
        "editor.partMore": page * 20 < r.total,
      });
    } catch (e) {
      if (!this.destroyed && revision === this._search)
        this.setData({ error: e.message });
    } finally {
      if (
        !this.destroyed &&
        revision === this._search &&
        this.data.editor?.kind === "issue"
      )
        this.setData({ "editor.searching": false });
    }
  },
  onSelectPart(e) {
    if (this.locked() || this.data.editor?.conflict) return;
    const p = this.data.editor.parts.find(
      (p) => p.id === e.currentTarget.dataset.id,
    );
    if (p)
      this.setData({ "editor.values.partId": p.id, "editor.partName": p.name });
  },
  photoPurpose() {
    const e = this.data.editor;
    return e?.kind === "update"
      ? "appearance"
      : e?.kind === "payment"
        ? e.paymentKind.startsWith("expense")
          ? "expense"
          : "payment"
        : e?.kind === "transition" && e.to === "completed"
          ? "pickup"
          : null;
  },
  async onPhotos() {
    const purpose = this.photoPurpose();
    if (this.locked() || !purpose || this.data.editor?.conflict) return;
    const remaining =
      9 -
      this.data.detail.files.filter((f) => f.purpose === purpose).length -
      this.data.editor.photos.length;
    if (remaining <= 0) return this.$toast("本组附件已达9张");
    this.setData({ uploading: true, error: "" });
    try {
      const selected = await wx.chooseMedia({
        count: remaining,
        mediaType: ["image"],
        sizeType: ["compressed"],
      });
      const results = await Promise.allSettled(
        selected.tempFiles.map((f) =>
          upload({
            filePath: f.tempFilePath,
            scope: "internal",
            bizType: "repair_" + purpose,
          }),
        ),
      );
      if (this.destroyed) return;
      const files = results
        .filter((r) => r.status === "fulfilled")
        .map((r) => r.value);
      this.setData({ "editor.photos": this.data.editor.photos.concat(files) });
      if (files.length < results.length)
        this.setData({
          error: "已保留成功上传的照片，部分照片未上传，请重试。",
        });
    } catch (e) {
      if (!this.destroyed && !/cancel/.test(e.errMsg || ""))
        this.setData({ error: e.message || e.errMsg || "照片未上传" });
    } finally {
      if (!this.destroyed) this.setData({ uploading: false });
    }
  },
  onRemovePhoto(e) {
    if (!this.locked() && !this.data.editor?.conflict)
      this.setData({
        "editor.photos": this.data.editor.photos.filter(
          (p, i) => i !== Number(e.currentTarget.dataset.index),
        ),
      });
  },
  build() {
    const e = this.data.editor,
      v = e.values,
      photos = e.photos.map((p) => ({ fileId: p.fileId }));
    if (e.kind === "update") {
      const body = {};
      for (const name of Object.keys(e.baseline))
        if (v[name] !== e.baseline[name]) body[name] = v[name];
      if (body.fault !== undefined && !body.fault.trim())
        throw new Error("请填写故障");
      if (body.diagnosis !== undefined && !body.diagnosis.trim())
        throw new Error("请填写检测结果");
      if (body.phone !== undefined && !isPhone(body.phone))
        throw new Error("请填写11位联系电话");
      if (body.customer !== undefined && !body.customer.trim())
        throw new Error("请填写联系人");
      if (photos.length) body.photos = photos;
      if (!Object.keys(body).length) throw new Error("资料未修改");
      return body;
    }
    if (e.kind === "quote") {
      if (!amount(v.amount)) throw new Error("报价须为非负金额，最多两位小数");
      return { amount: v.amount };
    }
    if (e.kind === "confirm") {
      if (v.accepted !== true)
        throw new Error("请确认已获得当前报价与方案的认可");
      return { quoteVersion: e.quoteVersion, confirmed: true };
    }
    if (e.kind === "issue") {
      if (!v.partId || !count(v.quantity))
        throw new Error("请选择配件并填写正整数数量");
      return { partId: v.partId, quantity: Number(v.quantity) };
    }
    if (e.kind === "returnParts") {
      if (!count(v.quantity) || Number(v.quantity) > e.remaining)
        throw new Error("退料数量不能超过原领用剩余数量");
      return { issueId: e.issueId, quantity: Number(v.quantity) };
    }
    if (e.kind === "payment") {
      if (!amount(v.amount) || Number(v.amount) <= 0)
        throw new Error("金额须大于零，最多两位小数");
      if (v.accepted !== true) throw new Error("请确认已实际办理本次收支");
      return {
        kind: e.paymentKind,
        amount: v.amount,
        method: e.methods[e.methodIndex],
        confirmed: true,
        ...(photos.length ? { proof: photos } : {}),
      };
    }
    if (e.kind === "transition") {
      const d = this.data.detail;
      if (e.to === "pending_confirm" && (!d.diagnosis || d.quote === null))
        throw new Error("请先保存检测结果并由有权限人员报价");
      if (
        e.to === "repairing" &&
        (d.quote === null || d.confirmedVersion !== d.quoteVersion)
      )
        throw new Error("请先记录对当前报价的确认");
      if (e.to === "pending_pickup" && d.waitingParts)
        throw new Error("请先确认配件齐备并关闭待配件标记");
      if (
        e.to === "completed" &&
        d.kind === "external" &&
        d.received !== d.quote
      )
        throw new Error("请先结清当前维修报价");
      const body = { to: e.to };
      if (e.to === "pending_pickup") {
        if (!v.result.trim()) throw new Error("请填写维修结果");
        body.result = v.result.trim();
      }
      if (e.to === "completed") {
        if (
          !v.pickupName.trim() ||
          !/^\d+$/.test(String(v.warrantyDays)) ||
          Number(v.warrantyDays) > 3650
        )
          throw new Error("请填写交接人及0～3650的质保天数");
        if (!photos.length) throw new Error("请上传取机或交接凭证");
        Object.assign(body, {
          pickupName: v.pickupName.trim(),
          pickupProof: photos,
          warrantyDays: Number(v.warrantyDays),
        });
      }
      return body;
    }
    throw new Error("未知处理操作");
  },
  async onSubmitEditor() {
    if (this.locked() || !this.data.editor || this.data.editor.conflict) return;
    let body;
    try {
      body = this.build();
    } catch (e) {
      return this.$toast(e.message);
    }
    const e = this.data.editor,
      revision = this._load;
    this.setData({ confirming: true, error: "" });
    try {
      const c = await confirmSensitive({
        title: e.title,
        content:
          e.kind === "payment"
            ? "确认已实际办理本次" + PAYMENT_TYPES[e.paymentKind] + "，填写说明"
            : "填写本次处理说明，将保留审计记录",
        needReason: true,
      });
      if (!c.confirmed || this.destroyed || revision !== this._load) return;
      this.setData({
        pending: {
          method: API_METHODS[e.kind],
          body: {
            ...copy(body),
            version: e.version,
            requestKey: key(),
            reason: c.reason,
          },
        },
      });
      await this.send();
    } catch (error) {
      if (!this.destroyed) this.setData({ error: error.message });
    } finally {
      if (!this.destroyed) this.setData({ confirming: false });
    }
  },
  async send() {
    const pending = this.data.pending;
    if (!pending) return;
    this.setData({ saving: true });
    try {
      const detail = await api.repair[pending.method](
        this.data.id,
        copy(pending.body),
      );
      if (this.destroyed) return;
      this.apply(detail);
      this._search = (this._search || 0) + 1;
      this.setData({ pending: null, editor: null, error: "" });
      events.emit("inventory:changed", { repairId: detail.id });
    } catch (e) {
      if (this.destroyed) return;
      if (Number(e.code) >= 400 && Number(e.code) < 500) {
        this.setData({ pending: null });
        if (Number(e.code) === 409 && this.data.editor)
          this.setData({ "editor.conflict": true });
        if ([401, 403, 404].includes(Number(e.code)))
          this.setData({
            detail: null,
            editor: null,
            transitions: [],
            paymentKinds: [],
          });
      }
      throw e;
    } finally {
      if (!this.destroyed) this.setData({ saving: false });
    }
  },
  async onRetry() {
    if (this.data.saving || this.data.uploading || !this.data.pending) return;
    try {
      await this.send();
    } catch (e) {
      if (!this.destroyed) this.setData({ error: e.message });
    }
  },
  async onRefresh() {
    if (this.locked()) return;
    this.setData({ editor: null });
    return this.load();
  },
  async onPreview(e) {
    try {
      const f = await api.file.detail(e.currentTarget.dataset.id);
      wx.previewImage({ urls: [f.url], current: f.url });
    } catch (error) {
      this.$toast(error.message);
    }
  },
  onParts() {
    if (!this.locked() && !this.data.editor) this.$go(ROUTES.REPAIR_PARTS);
  },
});
