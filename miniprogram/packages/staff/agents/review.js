const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { AGENT_STATUS } = require('../../../constants/status');
const { confirmSensitive } = require('../../../utils/confirm');
const { date } = require('../../../utils/format');

/**
 * 代理审核与管理（框架文档 7.2、十三.1）：默认加价上限由老板设定（固定金额）；审核通过时可单独设上限，
 * 留空用默认值；停用/恢复与调整上限属权限变更，需二次确认并填写原因。
 */
createPage({
  requireStaff: true,
  permission: PERM.AGENT_REVIEW,
  data: {
    settings: null, defaultDraft: '', list: [], drafts: {}, page: 1, total: 0, hasMore: true, loading: false, saving: false, error: '',
    filters: [{ value: 'pending', label: '待审核' }, { value: 'active', label: '已通过' }, { value: 'rejected', label: '未通过' }, { value: 'disabled', label: '已停用' }],
    status: 'pending'
  },

  onLoad(query = {}) {
    this.setData({ statusMap: AGENT_STATUS, status: AGENT_STATUS[query.status] ? query.status : 'pending' });
    return Promise.all([this.loadSettings(), this.load(true)]);
  },
  onPullDownRefresh() { Promise.all([this.loadSettings(), this.load(true)]).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async loadSettings() {
    try { const settings = await api.adminAgent.settings(); this.setData({ settings, defaultDraft: String(settings.defaultMarkupMax) }); }
    catch (e) { this.setData({ error: e.message }); }
  },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await (this.data.status === 'pending' ? api.adminAgent.applications : api.adminAgent.agents)({ status: this.data.status, page, pageSize: 20 });
      if (revision !== this.revision) return;
      const rows = res.list.map((a) => ({ ...a, appliedText: date(new Date(a.appliedAt)) }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total, drafts: Object.fromEntries(list.map((a) => [a.id, a.markupMax === null ? '' : String(a.markupMax)])) });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); },
  onDefaultDraft(e) { this.setData({ defaultDraft: e.detail.value }); },
  onDraft(e) { this.setData({ [`drafts.${e.currentTarget.dataset.id}`]: e.detail.value }); },
  money(value, allowEmpty) {
    const v = String(value || '').trim();
    if (allowEmpty && !v) return '';
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) { this.$toast('上限须为不小于 0 的金额，最多两位小数'); return null; }
    return v;
  },

  async run(task, confirm) {
    if (this.data.saving) return;
    const c = await confirmSensitive({ needReason: true, ...confirm });
    if (!c.confirmed) return;
    this.setData({ saving: true, error: '' });
    try { await task(c.reason); this.$toast('已保存'); await this.load(true); }
    catch (e) { this.setData({ error: e.message }); if (Number(e.code) === 409) await this.load(true); }
    finally { this.setData({ saving: false }); }
  },
  onSaveDefault() {
    const value = this.money(this.data.defaultDraft);
    if (value === null || !this.data.settings) return;
    return this.run(async (reason) => {
      const settings = await api.adminAgent.updateSettings({ defaultMarkupMax: value, version: this.data.settings.version, reason });
      this.setData({ settings, defaultDraft: String(settings.defaultMarkupMax) });
    }, { title: '调整默认加价上限', content: '填写调整原因（仅影响之后审核通过的代理）' });
  },
  onReview(e) {
    const { id, approve } = e.currentTarget.dataset, item = this.data.list.find((a) => a.id === id), ok = approve === '1';
    const max = ok ? this.money(this.data.drafts[id], true) : '';
    if (max === null) return;
    return this.run((remark) => api.adminAgent.review(id, { approve: ok, remark, version: item.version, ...(max !== '' ? { markupMax: max } : {}) }),
      { title: ok ? `通过 ${item.name} 的申请` : `拒绝 ${item.name} 的申请`, content: ok ? '填写审核说明（上限留空则用默认值）' : '填写拒绝原因（申请人可见）' });
  },
  onSaveMarkup(e) {
    const id = e.currentTarget.dataset.id, item = this.data.list.find((a) => a.id === id), max = this.money(this.data.drafts[id]);
    if (max === null) return;
    return this.run((reason) => api.adminAgent.updateAgent(id, { markupMax: max, reason, version: item.version }), { title: `调整 ${item.name} 的加价上限`, content: '填写调整原因' });
  },
  onToggle(e) {
    const id = e.currentTarget.dataset.id, item = this.data.list.find((a) => a.id === id), status = item.status === 'active' ? 'disabled' : 'active';
    return this.run((reason) => api.adminAgent.updateAgent(id, { status, reason, version: item.version }),
      { title: status === 'disabled' ? `停用 ${item.name}` : `恢复 ${item.name}`, content: status === 'disabled' ? '停用后其分享链接立即失效，填写原因' : '填写恢复原因' });
  }
});
