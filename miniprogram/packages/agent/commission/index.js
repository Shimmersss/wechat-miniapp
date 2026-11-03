const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { SETTLEMENT_STATUS } = require('../../../constants/status');
const { date } = require('../../../utils/format');

/**
 * 收益明细（框架文档 十三.1）：每笔成交按加价快照记一条收益，公司线下转账后由财务标记已转账；
 * 退货时未转账的收益直接冲回，已转账的生成负数冲回记录，在后续转账中抵扣。
 */
createPage({
  requireAgent: true,
  data: {
    list: [], summary: null, page: 1, total: 0, hasMore: true, loading: false, error: '', status: '',
    filters: [{ value: '', label: '全部' }, { value: 'pending', label: '待转账' }, { value: 'settled', label: '已转账' }, { value: 'reversed', label: '已冲回' }]
  },
  onLoad(query = {}) { this.setData({ statusMap: SETTLEMENT_STATUS, status: SETTLEMENT_STATUS[query.status] ? query.status : '' }); return this.load(true); },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.agent.commissions({ status: this.data.status || undefined, page, pageSize: 20 });
      if (revision !== this.revision) return;
      const rows = res.list.map((e) => ({ ...e, createdText: date(new Date(e.createdAt)), settledText: e.settledAt ? date(new Date(e.settledAt)) : '' }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, summary: res.summary, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); }
});
