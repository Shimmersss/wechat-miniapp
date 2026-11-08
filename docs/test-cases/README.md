# 夏目数码 · 测试用例

按业务流程整理的手工与接口测试用例，覆盖小程序、后端和数据层。用例的预期来自 2026-11-06 的 `server/src` 与 `miniprogram` 代码，以及框架文档 V0.3。代码和文档冲突时以框架文档为准，并记入本页“疑点”。

本目录是**测试点库**：只写“测什么、预期是什么”，**用例本身还没有逐条执行**。业务验收以 [`docs/role-tests/`](../role-tests/README.md) 为准；旧的手工走查表已归档到 [`docs/archive/`](../archive/README.md)。后端迁到云开发后，涉及 MySQL、HTTP 接口路径的预期要按新实现复核。

## 模块索引

| 文件 | 内容 | 用例数 |
|---|---|---|
| [01-auth-session.md](01-auth-session.md) | 微信登录、短信、员工绑定、会话、页面守卫 | 55 |
| [02-staff-permission-audit.md](02-staff-permission-audit.md) | 权限矩阵、字段裁剪、员工、角色、操作日志 | 67 |
| [03-catalog-template.md](03-catalog-template.md) | 分类、型号、模板版本、TAC、迁移 | 64 |
| [04-purchase-acceptance.md](04-purchase-acceptance.md) | 供应商、采购、运单、验收、异常 | 93 |
| [05-inbound.md](05-inbound.md) | 定价辅助、单台与批量入库 | 55 |
| [06-inventory.md](06-inventory.md) | 库存、改价、共享开关、流水、复检、标签 | 68 |
| [07-stocktake.md](07-stocktake.md) | 盘点单、扫码、差异处理 | 56 |
| [08-sales-refund.md](08-sales-refund.md) | 收银、收款凭证、销售单、退款 | 87 |
| [09-repair.md](09-repair.md) | 维修单、报价确认、配件、收支、完工 | 129 |
| [10-loans.md](10-loans.md) | 出借、借入、归还、复检完结、逾期 | 69 |
| [11-shop-share.md](11-shop-share.md) | 顾客端、分渠道分享、失效、海报 | 75 |
| [12-customer-requests.md](12-customer-requests.md) | 咨询、预约、同行意向、意向成交 | 55 |
| [13-agent.md](13-agent.md) | 代理申请、审核、加价、锁库、收益、邀请 | 102 |
| [14-stats-export.md](14-stats-export.md) | 访问上报、工作台、统计口径、导出 | 61 |
| [15-files-common.md](15-files-common.md) | 文件上传读取、接口通用规则、防御分支 | 50 |
| [16-e2e-state-machine.md](16-e2e-state-machine.md) | 单机状态机全矩阵、20 条端到端流程、身份走查 | 29 |
| [17-ui-device-mock.md](17-ui-device-mock.md) | 界面、主题、真机、mock 一致性 | 32 |

合计 1147 条：P0 542 条，P1 534 条，P2 57 条，外部 12 条，待开发 2 条。

## 用例格式

| 列 | 含义 |
|---|---|
| 编号 | 模块前缀 + 序号，跨文件唯一，可用于缺陷单和自动化测试命名 |
| 级 | P0 钱、库存、越权、数据一致性；P1 主流程和主要校验；P2 边界与体验；外部 = 依赖正式配置或真机；待开发 = 功能未实现 |
| 层 | API 接口；页面 开发者工具；并发 同时发两个以上请求；数据 查库或核对跨表结果；真机、部署；代码、单元 开发自查 |
| 身份 | 执行者。未说明时按默认角色权限 |
| 预期 | 「」内是接口返回的原文，可直接断言；未写状态码的「」文案以接口实际状态码为准 |

## 环境

| 环境 | 用途 | 准备 |
|---|---|---|
| mock | 页面走查 | 微信开发者工具导入仓库根目录，默认 `useMock: true`，在“我的 → 开发调试”切身份。重新编译会清空数据 |
| 本机真实后端 | API、并发、数据类用例 | `./scripts/local-dev.sh start`；改过 `server/src` 必须 `restart`；用 `xiamu_verification` 验证库，不用业务库 |
| 真机 + 正式配置 | 外部类用例 | 需要 `WX_APP_ID`、`WX_APP_SECRET`、腾讯云短信、合法域名 |

短信和微信在本机用替身（参考 `server/test/helpers.js`），不代表外部账号已联调。

## 测试数据

| 数据 | 要求 |
|---|---|
| 账号 | 7 个员工角色各 1 个；额外 1 名老板、1 名工程师、1 名销售用于互斥和隔离用例；顾客 2 个、同行 1 个、代理 2 个 |
| 自定义角色 | 部分用例需要临时调整权限（如“有开单权、无批发价字段”），用完恢复 |
| 分类型号 | 手机分类 + 1 个配了容量、颜色和 TAC 的型号 + 1 个未配规格的型号 + 另一分类 |
| 设备 | 12 种状态各至少 1 台；3 个分享开关分别单开的 3 台 |
| 串码 | 必须过 Luhn 校验，用 `server/test/helpers.js` 的 `imei()` 生成；另备校验位错误的样本 |
| 时间 | 过期类用例（分享 72 小时、锁库 30 分钟、验证码 5 分钟、导出 15 分钟、签名 5 分钟、会话 12 小时）改库里的到期时间或缩短配置，不要真等 |
| 文件 | JPEG、PNG、WebP、MP4 各一，截断图片、改名的非图片、超过 32MB 的文件 |

`.local/mysql/` 和 `.local/files/` 是持久数据，不要为了测试清空。

## 建议执行顺序

1. **冒烟（约 30 分钟）**：`WLK-001`～`WLK-006`、`E2E-001`、`E2E-003`、`E2E-009`，以及 `PERM-002`、`PERM-003`、`SHOP-103`。
2. **资金和库存（P0 主线）**：08 销售退款、13 代理收益、09 维修收支、16 状态机矩阵。
3. **权限**：`PERM-001` 矩阵和 2.2 字段裁剪；任何权限改动后都要重跑。
4. **并发**：层为“并发”的用例，只能在真实后端跑。mock 是单线程，通过不代表没问题。
5. **其余 P1、P2**，最后是外部类。

发版回归至少跑 1、2、3、4。

## 与现有自动化的关系

`server/test`（26 个测试文件，含 `*-pages.test.js` 页面控制器集成测试）和 `tests/`（18 个测试文件）已覆盖大量 P0 主干，比如并发一机一卖、退款累计、文件认领互斥、验证码防重放。对照关系按模块：

| 模块 | 现有测试文件 |
|---|---|
| 01、15 | `foundation`、`rate-limit`、`file-claims`、`tests/auth-session` |
| 02 | `staff-admin`、`staff-pages`、`tests/staff-admin` |
| 03 | `category-templates`、`tests/template`、`tests/catalog-inbound` |
| 04、05、06、07 | `inventory-purchase`、`inventory-pages`、`purchase-pages`、`tests/inventory`、`tests/purchase`、`tests/inbound-page` |
| 08 | `sales`、`sales-pages`、`tests/sales` |
| 09 | `repair`、`repair-pages`、`repair-operation-pages`、`repair-dashboard`、`tests/repair` |
| 10 | `loans`、`loan-pages`、`tests/loans` |
| 11、12 | `shop-share`、`shop-share-pages`、`customer-requests`、`customer-request-pages`、`wechat-code` |
| 13 | `agents`、`agent-pages`、`tests/agents` |
| 14 | `analytics`、`report-export`、`tests/analytics` |

现有测试一条往往覆盖多个场景，所以这里只对照到模块，没有逐条标注“已自动化”。逐条对照需要在真实后端上跑一遍带路由埋点的测试，本次未做（本机 MySQL 和 API 当前是停止状态）。

## 覆盖核对

2026-11-06 用脚本核对过：

- `server/src` 注册的 144 个接口，全部出现在用例的“涉及接口”或步骤里。
- `server/src` 中 360 条 `fail()` 错误提示，全部能在用例中找到对应文案。
- 用例编号无重复。

这只说明接口和错误分支都有对应用例，不说明它们都能通过。

## 疑点：读代码发现、尚未实测

下面的问题都来自代码阅读，没有实际运行验证。对应用例跑到时请确认，确实有问题再转缺陷或定案。

| # | 位置 | 现象 | 对应用例 | 需要谁定 |
|---|---|---|---|---|
| Q1 | `agents.js` `saleItem`、`PATCH /admin/agents/:id` | 代理被停用后，已锁定的订单不释放，门店仍可成交并给该代理记收益 | AGR-012、补测 | 老板：停用时是否释放锁定单、是否还记收益 |
| Q2 | `shop-share.js` `POST /share/links` | 生成分享时直接取已存的加价，不和当前上限比较。上限调低后，超限的旧加价仍可用于新分享 | AGU-012 | 开发：大概率要补校验 |
| Q3 | `agents.js` `/admin/agent-earnings/settle` | 冲回记录（负数）可以单独标记“已转账”。框架文档说的是“在后续订单中抵扣”，系统里没有抵扣动作，只是合计相减 | AGE-019、AGE-021 | 财务：线下怎么操作这笔负数 |
| Q4 | `constants/roles.js` | 工程师默认没有 repair:quote，而框架文档 2.1 写工程师能报价（6.2 又写改报价单独授权）。店长有 parts:manage，但默认看不到成本，新增配件、配件入库、登记维修费用都会 403 | PERM-001、PRT-004、RPP-009 | 老板：定默认权限 |
| Q5 | `staff-admin.js` `PATCH /staff/:id` | “至少保留一名老板”的计数没有加锁，两名老板同时互相停用，可能两边都通过，系统变成零老板 | STAFF-010 | 开发：实测后决定是否加锁 |
| Q6 | `constants/roles.js` | 批发价可见范围多了店长，框架文档 3.2 只列老板、销售、同行 | FIELD-002 | 老板 |
| Q7 | `app.json` | `packages/demo` 视觉演示分包已注册，会进入上线包 | DEV-010 | 开发：上线前移除 |
| Q8 | `utils/channel.js`、`share-service.js` | 分享 ID 存在本地且一直带在请求头上，分享失效后 `/shop/*` 都会返回 404/410，要靠用户点“浏览全部”才清除 | SHO-026、SHO-027 | 开发：确认所有入口都有兜底 |
| Q9 | `shop-share.js` revoke | 只有分享人能撤销，老板不能撤销员工的分享（员工停用后链接会自动失效） | SHO-006 | 老板 |

## 缺陷记录

每条缺陷写：用例编号、环境（mock 或真实后端、提交号）、身份、实际结果、期望结果、截图或请求响应。

## 维护

- 新增接口或错误分支时，在对应模块加用例，编号往后排，不复用旧编号。
- 新增功能走通后，把“待开发”改成正式用例。
- 上线前确认事项变化时，同步改受影响的预期。
