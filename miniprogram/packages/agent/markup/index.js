const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');

/**
 * 代理加价（框架文档 3.2、十三.1）：分享价 = 代理底价 + 加价；加价为固定金额 0～上限。
 * 前端只提交 markup，分享价由服务端计算返回；已发出的分享按当时价格快照，改价后需重新转发。
 * 入口参数：unitId（可选，高亮该设备）
 */
createPage({
  requireAgent: true,
  data: { units: [], drafts: {}, focusId: '', loading: false, savingId: '', error: '' },

  onLoad(query = {}) { this.setData({ focusId: query.unitId || '' }); return this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.agent.units({ page: 1, pageSize: 100 });
      this.setData({ units: res.list, drafts: Object.fromEntries(res.list.map((u) => [u.id, String(u.markup)])) });
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  onDraft(e) { this.setData({ [`drafts.${e.currentTarget.dataset.id}`]: e.detail.value }); },
  async onSave(e) {
    const { id, index } = e.currentTarget.dataset, value = String(this.data.drafts[id] || '').trim(), unit = this.data.units[index];
    if (this.data.savingId) return;
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(value)) return this.$toast('请输入不小于 0 的金额，最多两位小数');
    if (Number(value) > unit.markupMax) return this.$toast(`加价不能超过上限 ¥${unit.markupMax}`);
    this.setData({ savingId: id, error: '' });
    try {
      const saved = await api.agent.setMarkup(id, { markup: value });
      this.setData({ [`units[${index}]`]: saved, [`drafts.${id}`]: String(saved.markup) });
      this.$toast('已保存，新转发按此价格');
    } catch (err) { this.setData({ error: err.message }); }
    finally { this.setData({ savingId: '' }); }
  }
});
