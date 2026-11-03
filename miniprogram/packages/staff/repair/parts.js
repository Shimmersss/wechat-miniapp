const { createPage } = require("../../../utils/page");
const api = require("../../../api/index");
const { PERM } = require("../../../constants/roles");
const { confirmSensitive } = require("../../../utils/confirm");
let sequence = 0;
const copy = (v) => JSON.parse(JSON.stringify(v));
const time = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t)
    ? new Date(t + 28800000).toISOString().slice(0, 16).replace("T", " ")
    : "";
};
createPage({
  requireStaff: true,
  permission: [PERM.PARTS_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH],
  data: {
    list: [],
    keyword: "",
    page: 0,
    more: false,
    loading: false,
    error: "",
    canManage: false,
    editor: null,
    pending: null,
    saving: false,
    confirming: false,
    ledger: null,
    ledgerLoading: false,
    ledgerLabels: {
      receive: "采购入库",
      issue: "维修领用",
      return: "维修退料",
    },
  },
  onLoad() {
    return this.load(true);
  },
  onUnload() {
    this.destroyed = true;
    this._revision = (this._revision || 0) + 1;
    this._ledger = (this._ledger || 0) + 1;
  },
  onPullDownRefresh() {
    if (this.busy() || this.data.editor) {
      wx.stopPullDownRefresh();
      return;
    }
    return this.load(true).finally(() => wx.stopPullDownRefresh());
  },
  busy() {
    return this.data.saving || this.data.confirming || !!this.data.pending;
  },
  onKeyword(e) {
    if (!this.busy() && !this.data.editor)
      this.setData({ keyword: e.detail.value });
  },
  onSearch() {
    if (!this.busy() && !this.data.editor) return this.load(true);
  },
  onMore() {
    if (!this.busy() && !this.data.editor) return this.load(false);
  },
  async load(reset) {
    if (this.busy() || this.data.loading) return;
    const revision = (this._revision = (this._revision || 0) + 1),
      page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: "" });
    try {
      const [r, o] = await Promise.all([
        api.repair.parts({
          keyword: this.data.keyword.trim(),
          page,
          pageSize: 20,
        }),
        api.repair.options(),
      ]);
      if (this.destroyed || revision !== this._revision) return;
      this.setData({
        list: reset ? r.list : this.data.list.concat(r.list),
        page,
        more: page * 20 < r.total,
        canManage: o.canManageParts,
      });
    } catch (e) {
      if (!this.destroyed && revision === this._revision)
        this.setData({
          error: e.message,
          ...([401, 403].includes(Number(e.code))
            ? { list: [], canManage: false, ledger: null }
            : {}),
        });
    } finally {
      if (!this.destroyed && revision === this._revision)
        this.setData({ loading: false });
    }
  },
  open(kind, title, extra) {
    if (
      !this.data.canManage ||
      this.busy() ||
      this.data.loading ||
      this.data.editor
    )
      return;
    this.setData(
      { editor: { kind, title, conflict: false, ...extra }, error: "" },
      () => wx.pageScrollTo({ selector: "#parts-editor", duration: 200 }),
    );
  },
  onCreate() {
    this.open("create", "新增配件", {
      values: { sku: "", name: "", unit: "件" },
    });
  },
  onReceive(e) {
    const p = this.data.list.find((p) => p.id === e.currentTarget.dataset.id);
    if (p)
      this.open("receive", "配件采购入库", {
        part: copy(p),
        values: { quantity: "1", unitCost: "" },
      });
  },
  onInput(e) {
    if (!this.busy() && !this.data.editor?.conflict)
      this.setData({
        ["editor.values." + e.currentTarget.dataset.field]: e.detail.value,
      });
  },
  onClose() {
    if (!this.busy()) this.setData({ editor: null, error: "" });
  },
  async onRefresh() {
    if (this.busy()) return;
    this.setData({ editor: null, ledger: null });
    return this.load(true);
  },
  build() {
    const e = this.data.editor,
      v = e.values;
    if (e.kind === "create") {
      if (!v.sku.trim() || !v.name.trim() || !v.unit.trim())
        throw new Error("请填写SKU、配件名称和单位");
      return { sku: v.sku.trim(), name: v.name.trim(), unit: v.unit.trim() };
    }
    if (
      !/^\d+$/.test(String(v.quantity)) ||
      Number(v.quantity) < 1 ||
      Number(v.quantity) > 1000000
    )
      throw new Error("数量须为1～1000000的整数");
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(String(v.unitCost)))
      throw new Error("采购单价须为非负金额，最多两位小数");
    return {
      quantity: Number(v.quantity),
      unitCost: v.unitCost,
      version: e.part.version,
    };
  },
  async onSubmit() {
    if (this.busy() || !this.data.editor || this.data.editor.conflict) return;
    let body;
    try {
      body = this.build();
    } catch (e) {
      return this.$toast(e.message);
    }
    const e = this.data.editor;
    this.setData({ confirming: true, error: "" });
    try {
      if (e.kind === "receive") {
        const c = await confirmSensitive({
          title: e.title,
          content: "确认配件已到货，登记实际采购成本和说明",
          needReason: true,
        });
        if (!c.confirmed || this.destroyed) return;
        body = {
          ...body,
          reason: c.reason,
          requestKey:
            "repair_receive_" +
            Date.now() +
            "_" +
            ++sequence +
            "_" +
            Math.random().toString(36).slice(2),
        };
      }
      this.setData({
        pending: { kind: e.kind, id: e.part?.id, body: copy(body) },
      });
      await this.send();
    } catch (error) {
      if (!this.destroyed) this.setData({ error: error.message });
    } finally {
      if (!this.destroyed) this.setData({ confirming: false });
    }
  },
  async send() {
    const p = this.data.pending;
    if (!p) return;
    this.setData({ saving: true });
    try {
      const result =
        p.kind === "create"
          ? await api.repair.createPart(copy(p.body))
          : await api.repair.receivePart(p.id, copy(p.body));
      if (this.destroyed) return;
      this.setData({
        pending: null,
        editor: null,
        ledger: null,
        error: "",
        keyword: result.sku,
      });
    } catch (e) {
      if (!this.destroyed && Number(e.code) >= 400 && Number(e.code) < 500) {
        this.setData({ pending: null });
        if (Number(e.code) === 409) this.setData({ "editor.conflict": true });
        if ([401, 403].includes(Number(e.code)))
          this.setData({
            editor: null,
            list: [],
            ledger: null,
            canManage: false,
          });
      }
      throw e;
    } finally {
      if (!this.destroyed) this.setData({ saving: false });
    }
    if (!this.destroyed) {
      /* confirmation remains locked until the caller completes */ this.setData(
        { confirming: false },
      );
      await this.load(true);
    }
  },
  async onRetry() {
    if (this.data.saving || !this.data.pending) return;
    try {
      await this.send();
    } catch (e) {
      if (!this.destroyed) this.setData({ error: e.message });
    }
  },
  onLedger(e) {
    if (this.busy() || this.data.editor || this.data.ledgerLoading) return;
    const p = this.data.list.find((p) => p.id === e.currentTarget.dataset.id);
    if (!p) return;
    this._ledger = (this._ledger || 0) + 1;
    this.setData({
      ledger: { id: p.id, name: p.name, list: [], page: 0, more: false },
    });
    return this.loadLedger(true);
  },
  onMoreLedger() {
    return this.loadLedger(false);
  },
  async loadLedger(reset) {
    if (!this.data.ledger || this.data.ledgerLoading || this.busy()) return;
    const revision = (this._ledger = (this._ledger || 0) + 1),
      l = this.data.ledger,
      page = reset ? 1 : l.page + 1;
    this.setData({ ledgerLoading: true, error: "" });
    try {
      const r = await api.repair.partLedger(l.id, { page, pageSize: 20 });
      if (this.destroyed || revision !== this._ledger) return;
      const rows = r.list.map((v) => ({ ...v, timeLabel: time(v.time) }));
      this.setData({
        "ledger.list": reset ? rows : l.list.concat(rows),
        "ledger.page": page,
        "ledger.more": page * 20 < r.total,
      });
    } catch (e) {
      if (!this.destroyed && revision === this._ledger)
        this.setData({ error: e.message });
    } finally {
      if (!this.destroyed && revision === this._ledger)
        this.setData({ ledgerLoading: false });
    }
  },
});
