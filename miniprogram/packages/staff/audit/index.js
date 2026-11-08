const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM } = require('../../../constants/roles');
const { date } = require('../../../utils/format');

/**
 * 操作日志（框架文档 二、2.2）：只读、追加写入，按操作人 / 动作 / 日期筛选，展开看改前改后、原因、IP 与请求号。
 * 改前改后内容由服务端按查看人的字段权限脱敏。
 */
const pretty = (v) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 1).replace(/[{}"]/g, '').replace(/\n\s*\n/g, '\n').trim());
/** 维修日志的动作存的是内部代码，显示时换成中文；筛选仍提交原值 */
const REPAIR_ACTIONS = { update: '更新资料', quote: '报价', confirm: '报价确认', issue: '领用配件', return_parts: '退回配件', payment: '登记收支', transition: '变更节点' };
const actionText = (action) => String(action || '').replace(/^维修处理:(\w+)$/, (m, key) => `维修${REPAIR_ACTIONS[key] || '处理'}`);

createPage({
  requireStaff: true,
  permission: PERM.AUDIT_VIEW,
  data: { list: [], page: 1, total: 0, hasMore: true, loading: false, error: '', actions: ['全部动作'], actionLabels: ['全部动作'], actors: [{ id: '', name: '全部人员' }], actionIndex: 0, actorIndex: 0, from: '', to: '', expanded: '' },
  onLoad(query = {}) {
    this.objectId = query.objectId || '';
    api.audit.filters().then((f) => this.setData({ actions: ['全部动作', ...f.actions], actionLabels: ['全部动作', ...f.actions.map(actionText)], actors: [{ id: '', name: '全部人员' }, ...f.actors] })).catch(() => {});
    return this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.audit.list({
        action: this.data.actionIndex ? this.data.actions[this.data.actionIndex] : undefined,
        actorId: this.data.actors[this.data.actorIndex].id || undefined,
        objectId: this.objectId || undefined, from: this.data.from || undefined, to: this.data.to || undefined, page, pageSize: 30
      });
      if (revision !== this.revision) return;
      const rows = res.list.map((a) => ({ ...a, actionText: actionText(a.action), timeText: a.createdAt ? date(new Date(a.createdAt), 'MM-DD HH:mm') : a.timeText || '', beforeText: pretty(a.before), afterText: pretty(a.after) }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onAction(e) { this.setData({ actionIndex: Number(e.detail.value) }); return this.load(true); },
  onActor(e) { this.setData({ actorIndex: Number(e.detail.value) }); return this.load(true); },
  onDate(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); return this.load(true); },
  onClear() { this.objectId = ''; this.setData({ actionIndex: 0, actorIndex: 0, from: '', to: '' }); return this.load(true); },
  onExpand(e) { const id = e.currentTarget.dataset.id; this.setData({ expanded: this.data.expanded === id ? '' : id }); }
});
