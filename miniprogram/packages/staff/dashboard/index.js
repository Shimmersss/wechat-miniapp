const { createPage } = require('../../../utils/page');
const api = require('../../../api/index');
const { can } = require('../../../utils/permission');
const { PERM, ROLE_LABELS } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');

/** 快捷操作按权限过滤（需求 13：角色化快捷入口） */
const QUICK_ACTIONS = [
  { text: '顾客跟进', icon: 'chat', url: ROUTES.CUSTOMER_REQUESTS, perm: PERM.CONSULT_MANAGE },
  { text: '入库登记', icon: 'inbound', url: ROUTES.INBOUND, perm: PERM.INBOUND },
  { text: '快递验收', icon: 'truck', url: ROUTES.PURCHASE_LIST, perm: [PERM.PURCHASE_MANAGE, PERM.ACCEPTANCE] },
  { text: '扫码收银', icon: 'scan', url: ROUTES.POS, perm: PERM.SALES_CREATE },
  { text: '库存查询', icon: 'box', url: ROUTES.INVENTORY, perm: PERM.INVENTORY_VIEW },
  { text: '维修开单', icon: 'wrench', url: ROUTES.REPAIR_BOARD, perm: [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH] },
  { text: '维修配件', icon: 'parts', url: ROUTES.REPAIR_PARTS, perm: [PERM.PARTS_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH] },
  { text: '出借借入', icon: 'swap', url: ROUTES.LOANS, perm: PERM.LOAN_MANAGE },
  { text: '分渠道分享', icon: 'share', url: ROUTES.SHARE, perm: PERM.SHARE },
  { text: '型号模板', icon: 'layers', url: ROUTES.TEMPLATES, perm: PERM.TEMPLATE_MANAGE },
  { text: '代理审核', icon: 'check', url: ROUTES.AGENT_REVIEW, perm: PERM.AGENT_REVIEW },
  { text: '代理订单', icon: 'forward', url: ROUTES.AGENT_ORDERS_ADMIN, perm: [PERM.AGENT_REVIEW, PERM.SALES_CREATE] },
  { text: '代理收益', icon: 'chart', url: ROUTES.AGENT_SETTLEMENT, perm: PERM.AGENT_SETTLE },
  { text: '员工权限', icon: 'users', url: ROUTES.STAFF, perm: PERM.STAFF_MANAGE },
  { text: '操作日志', icon: 'list', url: ROUTES.AUDIT, perm: PERM.AUDIT_VIEW }
];

createPage({
  requireStaff: true,
  permission: PERM.DASHBOARD_VIEW,
  data: {
    roleLabel: '',
    canProfit: false,
    stats: null, todoTotal: 0, loading: false, error: '',
    quickActions: []
  },

  onLoad() {
    const { user } = this.data;
    this.setData({
      roleLabel: ROLE_LABELS[user.role],
      canProfit: can(user, PERM.PROFIT_VIEW),
      quickActions: QUICK_ACTIONS.filter((a) => can(user, a.perm))
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
        // 数据卡已迁到报表页，工作台只保留待办，这里顺便算出总项数给标题用
        const todoTotal = (stats.todos || []).reduce((n, t) => n + (t.count ? 1 : 0), 0);
        this.setData({ stats, todoTotal });
      })
      .catch((e) => this.setData({ error: e.message }))
      .finally(() => this.setData({ loading: false }));
  }
});
