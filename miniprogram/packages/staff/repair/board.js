const { createPage } = require("../../../utils/page");
const api = require("../../../api/index");
const { PERM } = require("../../../constants/roles");
const { can } = require("../../../utils/permission");
const { REPAIR_STATUS, REPAIR_FLOW } = require("../../../constants/status");
const { ROUTES } = require("../../../utils/router");
createPage({
  requireStaff: true,
  permission: [PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.REPAIR_QUOTE],
  data: {
    columns: [...REPAIR_FLOW, "cancelled"].map((key) => ({
      key,
      label: REPAIR_STATUS[key].label,
      list: [],
    })),
    activeKey: "pending_check",
    stats: null,
    loading: false,
    error: "",
    engineers: [],
    engineerIndex: 0,
    keyword: "",
    waitingParts: false,
    overdue: false,
    page: 0,
    more: false,
    canCreate: false,
    canParts: false,
    swimlanes: false,
  },
  onLoad(query = {}) {
    this.setData({
      overdue: query.overdue === "true",
      waitingParts: query.waitingParts === "true",
      activeKey: REPAIR_STATUS[query.status] ? query.status : "pending_check",
      canCreate: can(this.data.user, PERM.REPAIR_HANDLE),
      canParts: [PERM.REPAIR_HANDLE, PERM.REPAIR_CASH, PERM.PARTS_MANAGE].some(
        (p) => can(this.data.user, p),
      ),
    });
    return api.repair
      .options()
      .then((o) =>
        this.setData({
          engineers: [{ id: "", name: "全部获授权工程师" }, ...o.engineers],
        }),
      )
      .catch((e) => this.setData({ error: e.message }));
  },
  onShow() {
    return this.load(true);
  },
  onUnload() {
    this._revision = (this._revision || 0) + 1;
  },
  onPullDownRefresh() {
    return this.load(true).finally(() => wx.stopPullDownRefresh());
  },
  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },
  onSearch() {
    return this.load(true);
  },
  onEngineer(e) {
    this.setData({ engineerIndex: Number(e.detail.value) });
    return this.load(true);
  },
  onOverdue() {
    this.setData({ overdue: !this.data.overdue });
    return this.load(true);
  },
  onWaiting() {
    this.setData({ waitingParts: !this.data.waitingParts });
    return this.load(true);
  },
  async load(reset = true) {
    if (this.data.loading && !reset) return;
    const revision = (this._revision = (this._revision || 0) + 1),
      page = reset ? 1 : this.data.page + 1;
    this.setData({
      loading: true,
      error: "",
      ...(reset
        ? { columns: this.data.columns.map((c) => ({ ...c, list: [] })) }
        : {}),
    });
    try {
      const engineerId = this.data.engineers[this.data.engineerIndex]?.id || "",
        query = {
          keyword: this.data.keyword.trim(),
          engineerId,
          waitingParts: this.data.waitingParts ? "true" : undefined,
          overdue: this.data.overdue ? "true" : undefined,
          page,
        };
      const [board, stats] = await Promise.all([
        api.repair.board(query),
        api.repair.stats({ engineerId }),
      ]);
      if (revision !== this._revision) return;
      this.setData({
        columns: this.data.columns.map((c) => ({
          ...c,
          list: reset
            ? board.columns[c.key] || []
            : c.list.concat(board.columns[c.key] || []),
        })),
        page,
        more: board.hasMore,
        stats,
      });
    } catch (e) {
      if (revision === this._revision) this.setData({ error: e.message });
    } finally {
      if (revision === this._revision) this.setData({ loading: false });
    }
  },
  onParts() {
    if (this.data.canParts) this.$go(ROUTES.REPAIR_PARTS);
  },
  onMode() {
    this.setData({ swimlanes: !this.data.swimlanes });
  },
  onMore() {
    return this.load(false);
  },
  onTabTap(e) {
    this.setData({ activeKey: e.currentTarget.dataset.key });
  },
  onTicketTap(e) {
    this.$go(ROUTES.REPAIR_DETAIL, { id: e.currentTarget.dataset.id });
  },
  onCreate() {
    if (this.data.canCreate) this.$go(ROUTES.REPAIR_EDIT);
  },
});
