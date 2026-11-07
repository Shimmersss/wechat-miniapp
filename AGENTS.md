# AGENTS.md — 夏目数码微信小程序

给后续实现功能的编码代理（Codex 等）的工作说明。先读完本文件再动手。

## 需求来源（唯一事实依据）

- `夏目数码_小程序与ERP整体框架_V0.3.md`：角色、价格体系、库存状态机、接口安全底线、实施顺序。**有冲突时以它为准。**
- `夏目数码_高保真交互原型_V0.3.html`：13 个核心界面的交互与文案。
- `assets/xiamu_mockups/*.png`、`assets/mockups/*.png`：早期视觉稿，仅作布局参考。现行界面为方案 G「雾白层叠」，提供浅色、深色、零售绿三套主题，以 `styles/theme.wxss` 为准。
- 文档“十三、上线前确认事项”已于 2026-11-03 定案（第 8 项品牌信息暂缓），按定案实现：代理加价归代理、固定金额上限、按单记账线下转账；同行只发意向；借还首期不收费；快递首期手动录入不查轨迹；不做 Excel 导入；不存开机密码；代理只转发标记“允许代理转发”的设备。其他未定事项仍做成可配置并写 `TODO(confirm):`，不要自行拍板。

## 运行

1. 微信开发者工具 → 导入项目 → 选择本仓库根目录（`project.config.json` 已指定 `miniprogramRoot: miniprogram/`）。
2. **AppID 不进版本库**：`project.config.json` 固定为占位 `touristappid`，真实 AppID 写在已忽略的 `project.private.config.json`（开发者工具优先读它）。
   本机设置：`./scripts/appid.sh wx…`（用自己微信有开发者权限的那个），`./scripts/appid.sh` 查看，`./scripts/appid.sh clear` 去掉。
   不要把真实 AppID 写进任何被跟踪的文件，`tests/appid.test.js` 会拦截。
3. **开发版默认连测试服务器**（`miniprogram/config/index.js` 的 `develop`：`useMock: false`），靠开发者工具 `urlCheck: false` 放行 HTTP + IP。员工用手机号和验证码登录；未配置 `WX_APP_SECRET` 时，顾客、同行、代理的微信静默登录不可用。
4. 需要本地 mock 时，把 `develop` 的 `useMock` 改为 `true` 后重新编译，**不要提交这项改动**。mock 模式下才有“我的 → 开发调试”：切换模拟身份、加载测试设备（`docs/role-tests`）；员工登录页也可选择模拟角色。
5. 本机需要 `project.config.json` 的 `watchOptions.ignore` 排除 `.local/`、`server/node_modules/`、`.git/`：桌面程序占满了 inotify 额度，不排除会卡在初始化文件监听。

## 真实后端（独立于微信上传目录）

- `server/`：Fastify + MySQL，运行与凭据说明见 `server/README.md`。本机项目专属数据库使用 `127.0.0.1:3307`，不要重置现有 3306 服务。
- **本机（Ubuntu）用 `scripts/local-dev.sh`**：`start` / `stop` / `restart` / `status` / `logs` / `open`。服务由 systemd 用户服务 `xiamu-api.service`、`xiamu-mysql.service` 管理，MySQL 跑在 Docker 容器 `xiamu-wechat-mysql` 里。
- **不要在本机运行 `npm --prefix server start` 或 `npm --prefix server run db:start`**：前者会与 systemd 实例抢 3000 端口，后者依赖 macOS Homebrew。仅当不使用 systemd 的其它环境（macOS/新机器）才用这两条命令。
- API 没有热重载：改 `server/src` 或 `server/.env` 后必须 `scripts/local-dev.sh restart`。
- 迁移执行 `npm --prefix server run migrate`；API 只加载 `server/.env`，迁移专用凭据放 `server/.env.migration`，二者都禁止进入 `miniprogram/` 或版本库。
- 本机新增表的迁移完成后执行 `npm --prefix server run db:grants`，为项目应用/报表/备份账号补充表级权限；此命令仅用于项目专属本机实例，不用于生产部署。
- 服务端验证：`npm --prefix server run test:db` 准备专用验证库，然后在 `server/` 下 `node --env-file=.env --test --test-concurrency=2 test/*.test.js`；小程序回归 `node --test tests/*.test.js`。
- `.local/mysql/` 和 `.local/files/` 是持久数据，不是构建缓存。真实业务切换必须以对应接口、事务和权限验证为依据，不得让未实现接口回退假成功。

## 测试服务器

- 部署信息与凭据只写在本机的 `docs/HANDOFF-*.md`（已被 `.gitignore` 排除），不要把服务器密码、COS 密钥、固定验证码、员工手机号写进被跟踪的文件。
- 服务器配置了 `OTP_DEV_CODE`：非 `production` 环境下用固定验证码登录，跳过短信校验和微信 openid 换取，验证码接口还会返回该固定码。知道在职员工手机号即可登录，**这台服务器只放测试数据**。
- 上线前必须把 `NODE_ENV` 改为 `production` 并删除 `OTP_DEV_CODE`，同时关闭公网 3000 端口，改由 HTTPS 反向代理访问。
- 改 `server/src` 后要重新部署并重启服务器上的 API；部署步骤见交接文档，目前没有自动化。
- 文件存储由 `server/src/file-store.js` 切换：`COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY` 四项全填才走腾讯云 COS，否则用本地磁盘。存储桶保持私有，读取由后端判权后跳转到临时签名地址。

## 目录结构

```
miniprogram/
  app.js / app.json / app.wxss   入口、路由（主包 + shop/agent/staff/demo 四个分包，共 59 页）、全局样式
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
    theme.js                     主题管理（浅色 / 深色 / 零售绿），由 theme-shell 组件应用
    validate.js / scan.js / router.js / events.js
  api/index.js + api/modules/*   按业务域划分的接口函数（每个函数都有接口注释）
  mock/index.js + mock/data.js   路由式 mock，模拟“服务端按角色裁剪字段、按渠道决定价格”
  mock/test-seed.js              角色测试预置数据，手动加载，详见 docs/role-tests
  components/                    brand-header, section-card, status-pill, price-tag, metric-item,
                                 empty-state, product-card, staff-tabbar, todo-block,
                                 template-fields, theme-shell
  custom-tab-bar/                顾客端自定义 tabBar（图标 + 较大字号）
  assets/icons/                  线性 SVG 图标（深色 / -gray / -white 三套）
  pages/                         主包：顾客端 tabBar 四页 + 员工登录
  components/shop-filter         首页排序筛选栏（下拉面板、型号弹层、筛选抽屉）
  assets/brands/<key>.png        首页品牌配图，替换同名文件即可，说明见 constants/shop-brands.js
  packages/shop                  顾客端分包：搜索、单机详情、咨询预约、分享海报
  packages/agent                 代理端分包：申请、代理中心、加价、订单、收益明细、邀请
  packages/staff                 员工经营端分包：工作台、采购/验收、入库、模板、库存、收银、销售、
                                 维修、出借、分享、代理审核与收益转账、统计、员工权限、审计日志、我的
  packages/demo                  早期视觉演示，上线前确认是否移除
```

## 必须遵守的约定

### 页面
- 所有页面用 `createPage({...})`（`utils/page.js`），不要直接调用 `Page()`。
- 每个页面的 WXML 用 `<theme-shell>` 包住全部内容，否则主题变量不生效。
- 工作台工具集中在 `staff/dashboard/tools.js`，图标放同目录 `tools/<key>.svg`。常用工具布局按账号存本机（`storageKeys.workbenchTools`），入口显示仍以权限点为准。
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
- 颜色、圆角、阴影只用 `styles/theme.wxss` 中的 CSS 变量，变量挂在 `.theme-root` 上，不是 `page`；墨色块上的文字用 `--c-on-ink`，选中态用 `--c-selected` / `--c-on-selected`；通用类见 `app.wxss`（`.card` `.btn-*` `.chip` `.field` `.list-item` `.footer-bar` 等）。
- 图标用 `assets/icons/<名称>.svg`（深色）、`-gray.svg`（未选中/次要）、`-white.svg`（深色底），不要用 Unicode 符号充当图标。
- 顾客端 tabBar 为自定义组件 `custom-tab-bar/`（原生 tabBar 字号不可调），选中项由 `createPage` 的 `onShow` 同步；新增 tab 页需同时改 `app.json` 与组件里的 `TABS`。
- 单位用 `rpx`；组件样式隔离，组件内不要依赖 `app.wxss` 的类。
- 自定义组件的布尔属性写成 `dark="{{true}}"`，不要写无值属性。
- `.footer-bar` 是悬浮胶囊底栏，内容区用 `.footer-space` 留位；`.notice` 是中性灰提示条，不用来表达错误或告警。
- 主包上限 2MB：大图放 CDN 或分包，`assets/images` 只放占位小图（当前为压缩后的 600px JPG）。

## 待实现功能清单（按框架文档“十二、实施顺序”）

状态按 2026-11-04 代码实测标注：**页面与 mock 已接通**记 `[x]`；仅剩外部实机条件（真机、蓝牙、正式微信/SMS/小程序码）或缺口的记 `[ ]` 并注明。勾选依据是页面控制器中的实际调用，不是文档里的历史记录。

### 阶段 A：营业与库存可信
- [x] 员工登录：短信验证码、微信绑定、登录失败提示（`pages/login`，`utils/auth.js`）；正式短信/微信交换待外部配置
- [x] 型号模板：每个分类一套模板（字段编辑、版本发布），型号单独配置容量/颜色，作为入库型号选择器回传 `modelId`（`staff/templates/*`）；入库/采购/验收统一读 `GET /models/:id/form`
- [x] 采购单：供应商选择、明细行增删、运单绑定与扫码（首期不查轨迹）（`staff/purchase/*`、`staff/suppliers`）
- [x] 到货验收：逐台验收表单、异常分支、数量比对（`staff/acceptance`）
- [x] 单台入库：按模板字段动态渲染（`staff/inbound/index`）
- [x] 批量入库：连续扫码逐台行编辑（`staff/inbound/batch`，与单台共用 `inbound/form.js`）
- [x] 库存：搜索/扫码查找、筛选、改价弹层、库存流水、分享开关（含批量代理转发）、手动/扫码出库、复检、盘点单（开单快照、边扫边勾、差异只记录不改库存，`staff/inventory/stocktake*`）、详情借还入口（`staff/inventory/*`）
- [ ] 标签打印：标签数据接口与页面已完成，**蓝牙打印机对接未做**（`staff/inventory/label.js` 仍是 `TODO(codex)`，点击提示“打印机对接待实现”）
- [x] 收银与销售：顾客信息、优惠改价留痕、退款权限、收款凭证（开单可选上传/详情补传）、代理来源（`staff/pos`、`staff/sales/*`）
- [ ] 收银小票/收款码打印（发票首期不做，已定案）
- [x] 经营统计：趋势图、维度拆分、库龄预警、代理收益对账（`staff/stats`）
- [x] 员工与权限：新增员工、角色权限点勾选、字段可见性、审计筛选（`staff/staff/*`、`staff/audit`）
- [x] 顾客端：搜索页（历史、成色/价格/电池/新旧筛选）、分类按型号精确筛选、详情检测报告与相似在售、咨询预约（`pages/*`、`packages/shop/*`）

### 阶段 B：业务扩展
- [x] 维修：开单照片、报价权限、配件领用、节点时间线、收退款、取机（`staff/repair/*`）
- [x] 出借/借入：类型选择器、扫码/库存选设备、逾期提醒（首期不收押金/逾期费/赔偿）、逐台归还与复检后完结（`staff/loans/*`）
- [x] 分渠道分享：选设备、合集分享（`staff/share`）、Canvas 海报绘制与保存（`shop/poster`）
- [ ] 正式小程序码与真机扫码/转发：缺 `WX_APP_ID`/`WX_APP_SECRET` 时后端返回 `qrcode: null` + `unconfigured`，页面明确禁用可扫码海报
- [x] 销售列表按销售员筛选（`staff/sales/list`）

### 阶段 C：代理增长（必须在库存锁定、订单快照、退款冲回完成后上线）
- [x] 代理申请协议、地区选择（`agent/apply`）
- [x] 代理订单、收益汇总（`agent/orders`、`agent/commission`）；顾客代理链接下单锁库（`shop/consult` mode=order）
- [x] 邀请码、直属代理列表、`open-type="share"` 邀请卡片（`agent/invite`）
- [ ] 邀请海报成图：依赖上面的正式小程序码，未配置时不生成假二维码
- [x] 代理审核通过/拒绝（设固定金额加价上限）、代理订单、收益逐单标记已转账（`staff/agents/*`）

### 还需要的外部条件（非前端可完成）
- ~~后端服务~~ 已实现：`server/` 为真实 Fastify + MySQL，22 个迁移，80 项集成测试用例；测试服务器已部署并有数据库定时备份，生产部署、备份异地存储与恢复演练仍未做。
- 正式微信凭据：`WX_APP_ID`、`WX_APP_SECRET`（`server/.env`），缺配置时静默登录与小程序码返回明确错误，不伪造。
- 腾讯云短信：`SMS_APP_ID`、`SMS_SIGN`、`SMS_TEMPLATE_ID`，缺配置时发送验证码返回 503（设置 `OTP_DEV_CODE` 的非生产环境除外）。
- request 合法域名与 HTTPS 后端地址；`miniprogram/config/index.js` 的 `trial`/`release` 仍是 `example.com` 占位。
- `getwxacodeunlimit` 小程序码（服务端 `server/src/wechat-code.js` 已实现，需正式凭据 + 已发布页面）。

## 完成标准

- 微信开发者工具编译无报错、无 WXML 警告；控制台没有 `[mock] 未实现` 警告。
- 临时切到 mock（见“运行”第 4 条），切换 顾客 / 同行 / 代理 / 老板 / 销售 身份走一遍对应页面：顾客端看不到同行价，销售看不到成本和毛利，非代理进不了代理页。
- 新增接口都有 mock，且 mock 同样遵守字段裁剪规则。
