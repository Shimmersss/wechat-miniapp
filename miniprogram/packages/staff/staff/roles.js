const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { PERM, PERM_GROUPS, FIELD_LABELS } = require('../../../constants/roles');
const { confirmSensitive } = require('../../../utils/confirm');

/**
 * 角色与字段权限（框架文档 二、2.2）：按角色勾选权限点与可见敏感字段（成本、供应商、内部备注、完整串码、毛利、同行价）。
 * 只有老板能修改；老板角色固定全部权限。保存后该角色所有员工下一次请求即按新配置生效，服务端同时裁剪字段。
 */
createPage({
  requireStaff: true,
  permission: PERM.STAFF_MANAGE,
  data: { roles: [], canEdit: false, active: '', draft: null, loading: false, saving: false, error: '', groups: PERM_GROUPS.map((g) => ({ label: g.label, items: g.items.map(([key, label]) => ({ key, label })) })), fields: Object.keys(FIELD_LABELS).map((key) => ({ key, label: FIELD_LABELS[key] })) },
  onLoad(query = {}) { this.setData({ active: query.role || '' }); return this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.staff.roles();
      const active = res.list.some((r) => r.key === this.data.active) ? this.data.active : (res.list.find((r) => r.editable) || res.list[0]).key;
      this.setData({ roles: res.list, canEdit: res.canEdit });
      this.select(active);
    } catch (e) { this.setData({ error: e.message }); }
    finally { this.setData({ loading: false }); }
  },
  select(key) {
    const role = this.data.roles.find((r) => r.key === key);
    if (!role) return;
    this.setData({ active: key, activeEditable: role.editable, draft: { perms: Object.fromEntries(role.permissions.map((p) => [p, true])), fields: Object.fromEntries(role.visibleFields.map((f) => [f, true])), dirty: false } });
  },
  onRole(e) {
    if (this.data.draft && this.data.draft.dirty) return this.$toast('请先保存或还原当前修改');
    this.select(e.currentTarget.dataset.key);
  },
  editable() { const role = this.data.roles.find((r) => r.key === this.data.active); return this.data.canEdit && role && role.editable && !this.data.saving; },
  onTogglePerm(e) { if (this.editable()) { const k = e.currentTarget.dataset.key; this.setData({ 'draft.perms': { ...this.data.draft.perms, [k]: !this.data.draft.perms[k] }, 'draft.dirty': true }); } },
  onToggleField(e) { if (this.editable()) { const k = e.currentTarget.dataset.key; this.setData({ 'draft.fields': { ...this.data.draft.fields, [k]: !this.data.draft.fields[k] }, 'draft.dirty': true }); } },
  onReset() { this.select(this.data.active); },
  async onSave() {
    const role = this.data.roles.find((r) => r.key === this.data.active), d = this.data.draft;
    if (!this.editable() || !d.dirty) return;
    const permissions = Object.keys(d.perms).filter((k) => d.perms[k]), visibleFields = Object.keys(d.fields).filter((k) => d.fields[k]);
    const c = await confirmSensitive({ title: `保存「${role.label}」权限`, content: `该角色 ${role.staffCount} 名员工立即生效，填写调整原因`, needReason: true });
    if (!c.confirmed) return;
    this.setData({ saving: true, error: '' });
    try {
      const saved = await api.staff.updateRole(role.key, { permissions, visibleFields, reason: c.reason, version: role.version });
      this.setData({ roles: this.data.roles.map((r) => (r.key === saved.key ? saved : r)) });
      this.select(saved.key);
      this.$toast('已保存');
    } catch (e) { this.setData({ error: e.message }); if (Number(e.code) === 409) await this.load(); }
    finally { this.setData({ saving: false }); }
  }
});
