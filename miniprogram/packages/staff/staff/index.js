const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM, STAFF_ROLES, ROLE_LABELS } = require('../../../constants/roles');
const { confirmSensitive } = require('../../../utils/confirm');
const { isPhone } = require('../../../utils/validate');
const { date } = require('../../../utils/format');

/**
 * 员工管理（框架文档 需求 1）：新增员工后由本人用手机号短信登录并绑定微信；
 * 改角色、停用/恢复、解绑微信均需二次确认并填写原因，停用与解绑立即使其登录失效。
 * 非老板不能添加或修改老板账号；不能停用或更改自己（服务端同样校验）。
 */
createPage({
  requireStaff: true,
  permission: PERM.STAFF_MANAGE,
  data: {
    list: [], page: 1, total: 0, hasMore: true, loading: false, saving: false, error: '', keyword: '', status: 'active',
    filters: [{ value: 'active', label: '在职' }, { value: 'disabled', label: '已停用' }, { value: '', label: '全部' }],
    roles: [], editor: null, isBoss: false
  },
  onLoad() {
    const isBoss = this.data.user.role === 'boss';
    this.setData({ isBoss, roles: STAFF_ROLES.filter((r) => isBoss || r !== 'boss').map((key) => ({ key, label: ROLE_LABELS[key] })) });
    return this.load(true);
  },
  onPullDownRefresh() { this.load(true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { if (this.data.hasMore && !this.data.loading) this.load(false); },
  async load(reset) {
    const revision = this.revision = (this.revision || 0) + 1, page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.staff.list({ status: this.data.status || undefined, keyword: this.data.keyword.trim() || undefined, page, pageSize: 30 });
      if (revision !== this.revision) return;
      const rows = res.list.map((s) => ({ ...s, loginText: s.lastLoginAt ? date(new Date(s.lastLoginAt), 'MM-DD HH:mm') : '' }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({ list, page, total: res.total, hasMore: list.length < res.total });
    } catch (e) { if (revision === this.revision) this.setData({ error: e.message }); }
    finally { if (revision === this.revision) this.setData({ loading: false }); }
  },
  onFilter(e) { this.setData({ status: e.currentTarget.dataset.value }); return this.load(true); },
  onKeyword(e) { this.setData({ keyword: e.detail.value }); },
  onSearch() { return this.load(true); },

  onCreate() { this.setData({ editor: { mode: 'create', name: '', phone: '', roleIndex: Math.max(0, this.data.roles.findIndex((r) => r.key === 'sales')) } }); },
  onEdit(e) {
    const s = this.data.list.find((x) => x.id === e.currentTarget.dataset.id);
    if (!s) return;
    if (s.roleKey === 'boss' && !this.data.isBoss) return this.$toast('仅老板可修改老板账号');
    this.setData({ editor: { mode: 'edit', id: s.id, version: s.version, name: s.name, phone: s.phone, roleIndex: Math.max(0, this.data.roles.findIndex((r) => r.key === s.roleKey)) } });
  },
  onCloseEditor() { if (!this.data.saving) this.setData({ editor: null }); },
  onEditorInput(e) { this.setData({ [`editor.${e.currentTarget.dataset.field}`]: e.detail.value }); },
  onRole(e) { this.setData({ 'editor.roleIndex': Number(e.detail.value) }); },

  async run(task, confirm) {
    if (this.data.saving) return;
    const c = await confirmSensitive({ needReason: true, ...confirm });
    if (!c.confirmed) return;
    this.setData({ saving: true, error: '' });
    try { await task(c.reason); this.setData({ editor: null }); this.$toast('已保存'); await this.load(true); }
    catch (e) { this.setData({ error: e.message }); if (Number(e.code) === 409) await this.load(true); }
    finally { this.setData({ saving: false }); }
  },
  onSaveEditor() {
    const ed = this.data.editor;
    if (!ed) return;
    if (!ed.name.trim()) return this.$toast('请填写姓名');
    const roleKey = this.data.roles[ed.roleIndex].key;
    if (ed.mode === 'create') {
      if (!isPhone(ed.phone.trim())) return this.$toast('请填写 11 位手机号');
      return this.run((reason) => api.staff.create({ name: ed.name.trim(), phone: ed.phone.trim(), roleKey, reason }), { title: '新增员工', content: '填写原因（如入职、岗位）' });
    }
    return this.run((reason) => api.staff.update(ed.id, { name: ed.name.trim(), roleKey, reason, version: ed.version }), { title: '保存员工资料', content: '填写调整原因' });
  },
  onToggle(e) {
    const s = this.data.list.find((x) => x.id === e.currentTarget.dataset.id), status = s.status === 'active' ? 'disabled' : 'active';
    return this.run((reason) => api.staff.update(s.id, { status, reason, version: s.version }),
      { title: status === 'disabled' ? `停用 ${s.name}` : `恢复 ${s.name}`, content: status === 'disabled' ? '停用后其登录立即失效，填写原因' : '填写恢复原因' });
  },
  onUnbind(e) {
    const s = this.data.list.find((x) => x.id === e.currentTarget.dataset.id);
    return this.run((reason) => api.staff.unbind(s.id, { reason, version: s.version }), { title: `解绑 ${s.name} 的微信`, content: '解绑后需用手机号重新登录绑定，填写原因' });
  }
});
