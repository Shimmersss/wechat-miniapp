const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const config = require('../../../config/index');
const { can } = require('../../../utils/permission');
const { PERM, ROLE_LABELS } = require('../../../constants/roles');
const tools = require('./tools');

const { ROW_SIZE } = tools;
const CELL_RPX = 200; // 编辑网格的行高，与 index.wxss 的 .edit-tool 保持一致
const DRAG_START = 6; // 手指移动超过这个距离才算拖动，避免点删除时误触发

/** 给编辑网格的工具算出所在格子，位置变化由 CSS 过渡完成动画 */
const placed = (list, order) => list.map((t) => {
  const index = order.indexOf(t.key);
  return { ...t, col: index % ROW_SIZE, row: Math.floor(index / ROW_SIZE) };
});

createPage({
  requireStaff: true,
  permission: PERM.DASHBOARD_VIEW,
  data: {
    roleLabel: '', greeting: '', dateText: '', displayName: '',
    stats: null, todos: [], todoTotal: 0, badges: {}, loading: false, error: '',
    pinned: [], more: [], moreOpen: false,
    // 编辑模式：editItems 只增减不换位，顺序记在 this.order，这样格子能平滑移动
    editing: false, editItems: [], editMore: [], editRows: 0,
    dragKey: '', dragCol: 0, dragRow: 0, dragX: 0, dragY: 0
  },

  onLoad() {
    const { user } = this.data;
    const now = new Date();
    this.tools = tools.allowedTools((perm) => can(user, perm));
    this.storageKey = `${config.storageKeys.workbenchTools}:${user.id}`;
    this.setData({
      roleLabel: ROLE_LABELS[user.role],
      displayName: user.name || user.nickname || ROLE_LABELS[user.role],
      greeting: tools.greeting(now.getHours()),
      dateText: tools.dateText(now),
      ...tools.resolveLayout(this.tools, this.readSaved())
    });
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh());
  },

  load() {
    this.setData({ loading: true, error: '' });
    return api.dashboard.overview()
      .then((stats) => {
        const todos = tools.pendingTodos(stats.todos);
        this.setData({ stats, todos, todoTotal: todos.length, badges: tools.toolBadges(stats.todos) });
      })
      .catch((e) => this.setData({ error: e.message }))
      .finally(() => this.setData({ loading: false }));
  },

  /** 布局按账号存在本机，换手机后回到默认布局 */
  readSaved() {
    try { return wx.getStorageSync(this.storageKey) || null; } catch (e) { return null; }
  },

  onToggleMore() {
    this.setData({ moreOpen: !this.data.moreOpen });
  },

  // ---------- 编辑常用工具 ----------

  applyDraft(order, more) {
    this.order = order;
    const pinned = order.map((key) => this.tools.find((t) => t.key === key));
    this.setData({ editItems: placed(pinned, order), editMore: more, editRows: Math.ceil(order.length / ROW_SIZE) });
  },

  onStartEdit() {
    this.useDefault = false;
    this.applyDraft(this.data.pinned.map((t) => t.key), this.data.more);
    this.setData({ editing: true, moreOpen: false }, () => this.measure());
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },

  /** 量出格子尺寸，用来把手指位移换算成行列 */
  measure() {
    const { windowWidth } = wx.getWindowInfo();
    this.cellHeight = (CELL_RPX * windowWidth) / 750;
    wx.createSelectorQuery().select('.edit-area').boundingClientRect((rect) => {
      this.cellWidth = rect ? rect.width / ROW_SIZE : windowWidth / ROW_SIZE;
    }).exec();
  },

  onCancelEdit() {
    this.drag = null;
    this.setData({ editing: false, dragKey: '' });
  },

  onSaveEdit() {
    const saved = this.order.slice();
    try {
      // 恢复默认后不存具体顺序，以后默认布局调整时才能跟上
      if (this.useDefault) wx.removeStorageSync(this.storageKey);
      else wx.setStorageSync(this.storageKey, saved);
    } catch (e) {
      return this.$toast('保存失败，请重试');
    }
    this.setData({ editing: false, dragKey: '', ...tools.resolveLayout(this.tools, saved) });
    return this.$toast('已保存');
  },

  onResetEdit() {
    const { pinned, more } = tools.resolveLayout(this.tools, null);
    this.applyDraft(pinned.map((t) => t.key), more);
    this.useDefault = true;
    this.$toast('已恢复，点完成后生效');
  },

  onRemoveTool(e) {
    const { key } = e.currentTarget.dataset;
    const order = this.order.filter((k) => k !== key);
    const more = this.tools.filter((t) => !order.includes(t.key));
    this.useDefault = false;
    this.applyDraft(order, more);
  },

  onAddTool(e) {
    const { key } = e.currentTarget.dataset;
    const order = this.order.concat(key);
    this.useDefault = false;
    this.applyDraft(order, this.data.editMore.filter((t) => t.key !== key));
  },

  onDragStart(e) {
    const touch = e.touches[0];
    const { key } = e.currentTarget.dataset;
    const index = this.order.indexOf(key);
    this.drag = { key, startX: touch.clientX, startY: touch.clientY, col: index % ROW_SIZE, row: Math.floor(index / ROW_SIZE), active: false, at: 0 };
  },

  onDragMove(e) {
    const drag = this.drag;
    if (!drag) return;
    const touch = e.touches[0];
    const x = touch.clientX - drag.startX;
    const y = touch.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(x) + Math.abs(y) < DRAG_START) return;
      drag.active = true;
      this.setData({ dragKey: drag.key, dragCol: drag.col, dragRow: drag.row });
    }
    const now = Date.now();
    if (now - drag.at < 16) return;
    drag.at = now;
    const col = drag.col + Math.round(x / this.cellWidth);
    const row = drag.row + Math.round(y / this.cellHeight);
    const to = tools.indexAt(col, row, this.order.length);
    const patch = { dragX: x, dragY: y };
    if (to !== this.order.indexOf(drag.key)) {
      this.order = tools.moveKey(this.order, drag.key, to);
      this.useDefault = false;
      patch.editItems = placed(this.data.editItems, this.order);
      wx.vibrateShort({ type: 'light' });
    }
    this.setData(patch);
  },

  onDragEnd() {
    this.drag = null;
    this.setData({ dragKey: '', dragX: 0, dragY: 0 });
  }
});
