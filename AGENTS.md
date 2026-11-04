# AGENTS.md — 夏目数码微信小程序

给后续实现功能的编码代理（Codex 等）的工作说明。先读完本文件再动手。

## 需求来源（唯一事实依据）

- `夏目数码_小程序与ERP整体框架_V0.3.md`：角色、价格体系、库存状态机、接口安全底线、实施顺序。**有冲突时以它为准。**
- `夏目数码_高保真交互原型_V0.3.html`：13 个核心界面的交互与文案。
- `assets/xiamu_mockups/*.png`、`assets/mockups/*.png`：早期视觉稿，仅作布局参考。2026-11-03 起界面统一为苹果式简约风（浅灰底、白卡片、近黑主色），以 `styles/theme.wxss` 为准。
- 文档“十三、上线前确认事项”已于 2026-11-03 定案（第 8 项品牌信息暂缓），按定案实现：代理加价归代理、固定金额上限、按单记账线下转账；同行只发意向；借还首期不收费；快递首期手动录入不查轨迹；不做 Excel 导入；不存开机密码；代理只转发标记“允许代理转发”的设备。其他未定事项仍做成可配置并写 `TODO(confirm):`，不要自行拍板。

## 运行

1. 微信开发者工具 → 导入项目 → 选择本仓库根目录（`project.config.json` 已指定 `miniprogramRoot: miniprogram/`）。
2. AppID 已在 `project.config.json` 中配置；真机预览、登录与分享能力仍须确认对应微信账号权限及平台配置。
3. 开发版默认 `useMock: true`（`miniprogram/config/index.js`），所有请求走 `miniprogram/mock/index.js`，无需后端。
4. 切换身份调试：“我的”页 →“开发调试 / 切换模拟身份”；员工登录页在 mock 模式下可选择以哪个员工角色登录。

## 真实后端（独立于微信上传目录）

- `server/`：Fastify + MySQL，运行与凭据说明见 `server/README.md`。本机项目专属数据库使用 `127.0.0.1:3307`，不要重置现有 3306 服务。
- 项目根目录运行 `npm --prefix server start`；数据库未运行时先在另一终端运行 `npm --prefix server run db:start`。
- 迁移执行 `npm --prefix server run migrate`；API 只加载 `server/.env`，迁移专用凭据放 `server/.env.migration`，二者都禁止进入 `miniprogram/` 或版本库。
- 本机新增表的迁移完成后执行 `npm --prefix server run db:grants`，为项目应用/报表/备份账号补充表级权限；此命令仅用于项目专属本机实例，不用于生产部署。
- 服务端验证：`npm --prefix server run test:db` 准备专用验证库，然后 `npm --prefix server test`；小程序回归 `node --test tests/*.test.js`。
- `.local/mysql/` 和 `.local/files/` 是持久数据，不是构建缓存。真实业务切换必须以对应接口、事务和权限验证为依据，不得让未实现接口回退假成功。

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss   入口、路由（主包 + 3 个分包）、全局样式
  config/index.js                环境配置（baseUrl、useMock、品牌文案、storage key）
  constants/
    roles.js                     角色、权限点 PERM、默认角色权限、敏感字段可见角色
    status.js                    单机状态 + 状态流转表、采购/维修/出借/销售/代理/结算状态、渠道、四套价格
    routes.js                    所有页面路径常量
  utils/
    page.js                      createPage 页面工厂（登录/权限守卫、PV 埋点、金额遮挡、$go/$toast）
    request.js                   请求层（信封解包、令牌、渠道头、访客 ID、mock 切换、上传）
    auth.js                      静默登录、员工登录、登出
    channel.js                   分享来源捕获（s=shareId，scene 解析）
    track.js                     UV/PV/事件批量上报
    permission.js                isStaff / isAgent / can / canSeeField
    confirm.js                   敏感操作二次确认（可要求填写原因）
    format.js / filters.wxs      JS 与 WXML 两套格式化（金额、遮挡、百分比、IMEI 脱敏、状态 label/tone）
    validate.js / scan.js / router.js / events.js
  api/index.js + api/modules/*   按业务域划分的接口函数（每个函数都有接口注释）
  mock/index.js + mock/data.js   路由式 mock，模拟“服务端按角色裁剪字段、按渠道决定价格”
  components/                    brand-header, section-card, status-pill, price-tag, metric-item,
                                 empty-state, product-card, staff-tabbar, todo-block
  custom-tab-bar/                顾客端自定义 tabBar（图标 + 较大字号）
  assets/icons/                  线性 SVG 图标（深色 / -gray / -white 三套）
  pages/                         主包：顾客端 tabBar 四页 + 员工登录
  packages/shop                  顾客端分包：搜索、单机详情、咨询预约、分享海报
  packages/agent                 代理端分包：申请、代理中心、加价、订单、收益明细、邀请
  packages/staff                 员工经营端分包：工作台、采购/验收、入库、模板、库存、收银、销售、
                                 维修、出借、分享、代理审核与收益转账、统计、员工权限、审计日志、我的
```

## 必须遵守的约定

### 页面
- 所有页面用 `createPage({...})`（`utils/page.js`），不要直接调用 `Page()`。
- 员工页加 `requireStaff: true` + `permission: PERM.xxx`；代理页加 `requireAgent: true`。
- 跳转用 `ROUTES` 常量 + `this.$go(path, query)`；WXML 里可用 `bindtap="onNavigate" data-url="..."`。
- 员工端一级页（工作台/库存/收银/报表/我的）底部放 `<staff-tabbar active="..." />`，容器加 `has-staff-tabbar`。
- 每个页面里的 `<todo-block items="...">` 列出了该页待实现功能；**做完一项就从列表删掉，全部完成后删除该组件**。JS 里的 `TODO(codex):` 同理。

### 数据与接口
- 新增接口：①在 `api/modules/<域>.js` 加函数并写注释（参数、返回）；②在 `mock/index.js` 的 `routes` 加 mock；③页面只通过 `api.<域>.<fn>()` 调用。
- 后端响应信封固定为 `{ code: 0, data, message }`；列表统一 `{ list, total, page, pageSize }`。
- 金额单位前端统一为“元”。
- mock 路由按顺序匹配，固定路径（如 `/repair-orders/board`）必须写在 `/:id` 之前。

### 安全底线（框架文档 二、十一）
- **价格由服务端计算**：前端不计算零售价/同行价/代理分享价，提交的金额只是意图；代理加价只提交 `markup`，由服务端校验范围并返回 `sharePrice`。
- **字段裁剪在服务端**：成本、供应商、内部备注、完整 IMEI、毛利，服务端按角色不返回；前端字段为 `undefined` 时显示“无权限查看”，不要在前端用角色判断去“隐藏”已经拿到的数据。
- 公开页面只能显示 `imeiMasked`，完整 IMEI 不进入任何顾客/同行/代理页面。
- 分享链接、小程序码只带 `s=<shareId>`（scene 限 32 字符），不带价格；`app.js` 会捕获并通过 `X-Channel` 头传给服务端。
- 退款、改价、导出、代理收益标记转账、权限变更必须走 `confirmSensitive({ needReason: true })`，原因随请求提交。
- 金额遮挡（`privacy`）只遮屏幕，不能替代授权。
- 设备照片（`scope: 'public'`）与收货凭证（`scope: 'internal'`）分开上传。
- 小程序代码里禁止出现任何密钥。根目录 `.env` 存的是本地开发用密钥，**绝不能**复制或引用到 `miniprogram/` 下（该目录会被打包上传，可被反编译）。

### 样式
- 颜色、圆角、阴影只用 `styles/theme.wxss` 中的 CSS 变量；通用类见 `app.wxss`（`.card` `.btn-*` `.chip` `.field` `.list-item` `.footer-bar` 等）。
- 图标用 `assets/icons/<名称>.svg`（深色）、`-gray.svg`（未选中/次要）、`-white.svg`（深色底），不要用 Unicode 符号充当图标。
- 顾客端 tabBar 为自定义组件 `custom-tab-bar/`（原生 tabBar 字号不可调），选中项由 `createPage` 的 `onShow` 同步；新增 tab 页需同时改 `app.json` 与组件里的 `TABS`。
- 单位用 `rpx`；组件样式隔离，组件内不要依赖 `app.wxss` 的类。
- 自定义组件的布尔属性写成 `dark="{{true}}"`，不要写无值属性。
- 主包上限 2MB：大图放 CDN 或分包，`assets/images` 只放占位小图（当前为压缩后的 600px JPG）。

## 待实现功能清单（按框架文档“十二、实施顺序”）

### 阶段 A：营业与库存可信
- [ ] 员工登录：短信验证码、微信绑定、登录失败提示（`pages/login`）
- [ ] 型号模板：模板字段编辑弹层、版本发布、作为入库型号选择器回传 `modelId`（`staff/templates/*`）
- [ ] 采购单：供应商选择、明细行增删、运单绑定与扫码（首期不查轨迹）（`staff/purchase/*`、`staff/suppliers`）
- [ ] 到货验收：逐台验收表单、异常分支、数量比对（`staff/acceptance`）
- [ ] 单台入库：按模板字段动态渲染（`staff/inbound/index`）
- [ ] 批量入库：连续扫码逐台行编辑（`staff/inbound/batch`）
- [ ] 库存：搜索/扫码查找、筛选、改价弹层、库存流水、分享开关（含批量代理转发）、手动/扫码出库、状态操作按钮（按 `UNIT_TRANSITIONS`）、盘点（`staff/inventory/*`）
- [ ] 标签打印：蓝牙打印机（`staff/inventory/label`）
- [ ] 收银与销售：顾客信息、优惠改价留痕、退款权限、收款凭证（开单可选上传/详情补传）、代理来源已完成；剩实际收款码与小票打印（发票首期不做）（`staff/pos`、`staff/sales/*`）
- [x] 经营统计：趋势图、维度拆分、库龄预警、代理收益对账（`staff/stats`）
- [x] 员工与权限：新增员工、角色权限点勾选、字段可见性、审计筛选（`staff/staff/*`、`staff/audit`）
- [x] 顾客端：搜索页（历史、成色/价格/电池/新旧筛选）、分类按型号精确筛选、详情检测报告与相似在售、咨询预约（`pages/*`、`packages/shop/*`）

### 阶段 B：业务扩展
- [ ] 维修：开单照片、报价权限、配件领用、节点时间线（`staff/repair/*`）
- [x] 出借/借入：类型选择器、扫码/库存选设备、逾期提醒（首期不收押金/逾期费/赔偿）、逐台归还与复检后完结（`staff/loans/*`）
- [ ] 分渠道分享：选设备、合集分享（`staff/share`）、Canvas 海报（`shop/poster`）

### 阶段 C：代理增长（必须在库存锁定、订单快照、退款冲回完成后上线）
- [x] 代理申请协议、地区选择（`agent/apply`）
- [x] 代理订单、收益汇总（`agent/orders`、`agent/commission`）；顾客代理链接下单锁库（`shop/consult` mode=order）
- [ ] 邀请海报（`agent/invite`，邀请码与直属代理列表已完成）
- [x] 代理审核通过/拒绝（设固定金额加价上限）、代理订单、收益逐单标记已转账（`staff/agents/*`）

### 还需要的外部条件（非前端可完成）
- 后端服务（按 `api/modules` 的接口注释实现；MySQL/Redis 不开公网，数据库账号分离见框架文档 2.2）
- 正式 AppID、request 合法域名、`getwxacodeunlimit` 小程序码（服务端生成）

## 完成标准

- 微信开发者工具编译无报错、无 WXML 警告；控制台没有 `[mock] 未实现` 警告。
- 用 mock 切换 顾客 / 同行 / 代理 / 老板 / 销售 身份走一遍对应页面：顾客端看不到同行价，销售看不到成本和毛利，非代理进不了代理页。
- 新增接口都有 mock，且 mock 同样遵守字段裁剪规则。
