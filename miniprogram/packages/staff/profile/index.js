const { createPage } = require('../../../utils/page');
const auth = require('../../../utils/auth');
const { can } = require('../../../utils/permission');
const { PERM, ROLE_LABELS } = require('../../../constants/roles');
const { ROUTES } = require('../../../utils/router');

/** 员工“我的”：身份信息、管理入口（按权限）、切回顾客端、退出 */
const ENTRIES = [
  { text: '顾客咨询 / 预约', url: ROUTES.CUSTOMER_REQUESTS, perm: PERM.CONSULT_MANAGE },
  { text: '销售记录', url: ROUTES.SALES_LIST, perm: PERM.SALES_CREATE },
  { text: '采购与快递', url: ROUTES.PURCHASE_LIST, perm: PERM.PURCHASE_MANAGE },
  { text: '维修看板', url: ROUTES.REPAIR_BOARD, perm: [PERM.REPAIR_HANDLE, PERM.REPAIR_QUOTE, PERM.REPAIR_CASH] },
  { text: '维修配件', url: ROUTES.REPAIR_PARTS, perm: [PERM.PARTS_MANAGE, PERM.REPAIR_HANDLE, PERM.REPAIR_CASH] },
  { text: '出借 / 借入', url: ROUTES.LOANS, perm: PERM.LOAN_MANAGE },
  { text: '型号模板', url: ROUTES.TEMPLATES, perm: PERM.TEMPLATE_MANAGE },
  { text: '供应商', url: ROUTES.SUPPLIERS, perm: PERM.SUPPLIER_VIEW },
  { text: '代理审核', url: ROUTES.AGENT_REVIEW, perm: PERM.AGENT_REVIEW },
  { text: '代理订单', url: ROUTES.AGENT_ORDERS_ADMIN, perm: [PERM.AGENT_REVIEW, PERM.AGENT_SETTLE, PERM.SALES_CREATE] },
  { text: '代理收益转账', url: ROUTES.AGENT_SETTLEMENT, perm: PERM.AGENT_SETTLE },
  { text: '员工与角色', url: ROUTES.STAFF, perm: PERM.STAFF_MANAGE },
  { text: '操作日志', url: ROUTES.AUDIT, perm: PERM.AUDIT_VIEW }
];

createPage({
  requireStaff: true,
  data: {
    roleLabel: '',
    entries: []
  },

  onLoad() {
    const { user } = this.data;
    this.setData({ roleLabel: ROLE_LABELS[user.role], entries: ENTRIES.filter((e) => can(user, e.perm)) });
  },

  onCustomerView() {
    wx.reLaunch({ url: ROUTES.SHOP });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需重新验证才能进入经营端',
      success: (res) => res.confirm && auth.logout().then(() => wx.reLaunch({ url: ROUTES.MINE }))
    });
  }
});
