const { createPage } = require("../../../utils/page"),
  api = require("../../../api/index");
const { confirmSensitive } = require("../../../utils/confirm");
const { writeReport, shareReport } = require("../../../utils/report-file");
const { PERM } = require("../../../constants/roles"),
  { can } = require("../../../utils/permission"),
  { ROUTES } = require("../../../utils/router");
createPage({
  requireStaff: true,
  permission: [PERM.STATS_VIEW, PERM.DASHBOARD_VIEW],
  data: {
    ranges: [
      { value: "day", label: "今日" },
      { value: "week", label: "本周" },
      { value: "month", label: "本月" },
    ],
    exporting: false,
    exportPending: null,
    exportReport: null,
    exportFileReady: false,
    canExport: false,
    range: "day",
    dimension: "model",
    dimensions: [
      { value: "model", label: "型号" },
      { value: "staff", label: "员工" },
      { value: "store", label: "门店" },
    ],
    overview: null,
    visits: null,
    trend: [],
    breakdown: [],
    ageing: [],
    ageingTotal: 0,
    ageingPage: 0,
    ageingMore: false,
    loading: false,
    error: "",
    canInventory: false,
    canRepairStats: false,
    repair: null,
    canAgent: false,
    agentReport: null,
    trendMetric: "amount",
    trendMetrics: [
      { value: "amount", label: "销售净额" },
      { value: "profit", label: "净毛利" },
      { value: "uv", label: "访客UV" },
    ],
  },
  onLoad() {
    this.setData({
      canRepairStats: can(this.data.user, [
        PERM.STATS_VIEW,
        PERM.REPAIR_HANDLE,
        PERM.REPAIR_QUOTE,
        PERM.REPAIR_CASH,
      ]),
      canInventory: can(this.data.user, PERM.INVENTORY_VIEW),
      canExport: can(this.data.user, PERM.EXPORT),
      canAgent: can(this.data.user, [PERM.AGENT_SETTLE, PERM.AGENT_REVIEW]),
    });
    return this.load();
  },
  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },
  async load() {
    const revision = (this.revision = (this.revision || 0) + 1),
      params = { range: this.data.range };
    this.setData({ loading: true, error: "" });
    try {
      const [
        overview,
        visits,
        trend,
        visitTrend,
        breakdown,
        repair,
        agentReport,
      ] = await Promise.all([
        api.stats.overview(params),
        api.stats.visits(params),
        api.stats.trend(params),
        api.stats.visitTrend(params),
        api.stats.breakdown({ ...params, dimension: this.data.dimension }),
        this.data.canRepairStats
          ? api.repair.stats(params)
          : Promise.resolve(null),
        this.data.canAgent
          ? api.stats.agentEarnings(params)
          : Promise.resolve(null),
      ]);
      if (revision !== this.revision) return;
      const rows = trend.list.map((row) => ({
        ...row,
        uv: (visitTrend.list.find((v) => v.day === row.day) || {}).uv || 0,
      }));
      this.setData({
        overview,
        visits,
        repair,
        agentReport,
        trend: rows,
        breakdown: breakdown.list,
        trendMetric:
          this.data.trendMetric === "profit" && overview.profit === undefined
            ? "amount"
            : this.data.trendMetric,
      });
      this.chart();
      if (this.data.canInventory) await this.loadAgeing(true);
    } catch (e) {
      if (revision === this.revision) this.setData({ error: e.message });
    } finally {
      if (revision === this.revision) this.setData({ loading: false });
    }
  },
  async loadAgeing(reset) {
    try {
      const page = reset ? 1 : this.data.ageingPage + 1,
        res = await api.stats.ageing({ days: 31, page, pageSize: 20 }),
        ageing = reset ? res.list : this.data.ageing.concat(res.list);
      this.setData({
        ageing,
        ageingPage: page,
        ageingTotal: res.total,
        ageingMore: ageing.length < res.total,
      });
    } catch (e) {
      this.setData({ error: e.message });
    }
  },
  onMoreAgeing() {
    return this.loadAgeing(false);
  },
  onRangeTap(e) {
    this.setData({ range: e.currentTarget.dataset.value });
    return this.load();
  },
  onDimension(e) {
    this.setData({ dimension: e.currentTarget.dataset.value });
    return this.load();
  },
  onMetric(e) {
    if (
      e.currentTarget.dataset.value === "profit" &&
      this.data.overview.profit === undefined
    )
      return;
    this.setData({ trendMetric: e.currentTarget.dataset.value });
    this.chart();
  },
  chart() {
    const rows = this.data.trend,
      metric = this.data.trendMetric;
    const max = Math.max(
      1,
      ...rows.map((r) => Math.abs(Number(r[metric]) || 0)),
    );
    this.setData({
      chartRows: rows.map((row) => ({
        ...row,
        chartValue: row[metric],
        width: Math.max(
          1,
          Math.round((Math.abs(Number(row[metric]) || 0) / max) * 100),
        ),
        negative: Number(row[metric]) < 0,
      })),
    });
  },

  async onExport() {
    if (this.data.exporting || this.data.exportPending || !this.data.canExport)
      return;
    this.setData({ exporting: true, error: "" });
    try {
      const confirmation = await confirmSensitive({
        title: "导出销售退款明细",
        content: "填写导出原因，文件含授权可见的经营数据",
        needReason: true,
      });
      if (!confirmation.confirmed) return;
      this.setData({
        exportPending: {
          requestKey:
            "report_" + Date.now() + "_" + Math.random().toString(36).slice(2),
          range: this.data.range,
          reason: confirmation.reason,
        },
      });
      await this.sendExport();
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ exporting: false });
    }
  },
  async sendExport() {
    const input = this.data.exportPending;
    if (!input) return;
    try {
      const report = await api.stats.exportReport(
        JSON.parse(JSON.stringify(input)),
      );
      this.setData({
        exportReport: { ...report, range: input.range },
        exportPending: null,
      });
    } catch (e) {
      if (Number(e.code) >= 400 && Number(e.code) < 500)
        this.setData({ exportPending: null });
      throw e;
    }
  },
  async onRetryExport() {
    if (this.data.exporting || !this.data.exportPending) return;
    this.setData({ exporting: true, error: "" });
    try {
      await this.sendExport();
    } catch (e) {
      this.setData({ error: e.message });
    } finally {
      this.setData({ exporting: false });
    }
  },
  async onDownloadExport() {
    if (this.data.exporting || !this.data.exportReport) return;
    this.setData({ exporting: true, error: "", exportFileReady: false });
    try {
      const report = await api.stats.exportContent(this.data.exportReport.id),
        filePath = await writeReport(report);
      this.setData({ exportFileReady: true });
      await shareReport(filePath, report.filename);
    } catch (e) {
      if (!String(e.errMsg || "").includes("cancel"))
        this.setData({
          error:
            (this.data.exportFileReady
              ? "CSV已保存，分享未完成："
              : "保存文件失败：") + (e.message || e.errMsg || "请重试"),
        });
    } finally {
      this.setData({ exporting: false });
    }
  },
  /** 代理对账：点代理进入收益转账，只看该代理的待转账记录 */
  onAgentTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.$go(ROUTES.AGENT_SETTLEMENT, {
      agentId: id,
      agentName: name,
      status: "pending",
    });
  },
  onUnit(e) {
    this.$go(ROUTES.INVENTORY_DETAIL, { id: e.currentTarget.dataset.id });
  },
});
