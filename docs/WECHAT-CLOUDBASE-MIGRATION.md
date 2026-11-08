# 微信云开发迁移方案

定案日期：2026-11-09。后端整体迁到微信云开发（CloudBase 国内站），路线为 **云函数 + CloudBase PostgreSQL 共享实例**。本文是实施方案；截至定案日尚未部署、迁库或切换客户端，小程序开发版仍指向旧测试服务器。

环境 ID、AppID、API Key 等标识与凭据只写本机忽略的 `docs/HANDOFF-*.md`，不写进本文或任何被跟踪文件。

## 一、为什么选这条路

### 目标环境实况（2026-11-09 `queryEnv` 查询）

- 地域上海，套餐 **体验版**（免费，每月 3000 资源点，2027-05-09 到期）。
- PostgreSQL 为 **共享实例（SHARED）**：只能经 SDK / HTTP 网关访问，**没有 TCP 直连地址**。现有 `mysql2`/`pg` 驱动式后端在这里连不上。
- **没有文档型数据库（NoSQL）**：新建 PG 环境不再开 NoSQL，`wx.cloud.database()` 不可用。
- 已有云存储桶、云函数命名空间、静态托管。

### 两条可行路线对比

| | 云函数 + 共享 PG（选定） | 云托管 + 独享 PG |
| --- | --- | --- |
| 套餐门槛 | 个人版即可 | PG 独享需 **标准版及以上**（个人版不支持；控制台另有“企业版及以上”的说法，未核实） |
| 月成本估算 | 约 20–45 元 | 约 199 元起 |
| 现有代码 | 数据访问层重写；多表事务改为 PG 存储过程 | 基本保留 Fastify，只改 SQL 方言 |
| 运维 | 无服务器、无域名、无证书 | 同左，但实例常驻计费 |
| 以后升级 | 可升标准版、换独享 PG，存储过程与函数代码不用重写 | — |

成本估算方法（资源点价格文档，1000 点 ≈ 1 元，以下为推算，文档未直接给总价）：

- 共享 PG：每个有访问的 5 分钟按 0.5 核计；PG CPU 342 点/核·小时 → 活跃 1 小时约 171 点。每天活跃 8–12 小时 ≈ 每月 4–6 万点。
- 云函数：调用 13.3 点/万次，资源 0.111 点/GB·秒，小店量级可忽略。
- 个人版 19.9 元/月含 4 万点，超出按 1:1 扣费 → 合计约 20–45 元/月。
- 独享 PG 1 核 2G 不论有无访问都计费，每月约 24.6 万点，所以另一条路要上 199 元的标准版（含 33 万点）。

### 套餐建议

1. 开发和联调期：继续用 **体验版**（免费）。注意资源点耗尽后云函数会返回 410 `InsufficientBalance`。
2. 正式上线前：转 **个人版**。
3. 量起来、或 3 秒超时成为瓶颈时：升 **标准版**，必要时 PG 升独享。

## 二、目标架构

```
小程序页面
  └─ utils/request.js（保持 { code, data, message } 信封，页面不改）
       └─ wx.cloud.callFunction ──► 云函数（Event 函数，按业务域划分）
                                      ├─ 身份：平台注入的 OPENID（可信）→ 查员工/代理/顾客角色
                                      ├─ 权限校验、字段裁剪、价格计算（沿用 server/src 规则）
                                      └─ PG HTTP 网关（service_role API Key，仅在函数环境变量里）
                                           ├─ 简单读写：PostgREST 风格表接口
                                           └─ 多表事务：RPC 调用 PG 存储过程（行锁、唯一约束在库内保证）
  └─ 文件上传：云存储（设备照片 public / 收货与收款凭证 internal 分开）
```

### 东西放在哪

| 东西 | 位置 |
| --- | --- |
| 业务数据 | 环境内 PG 共享实例（腾讯托管） |
| 表结构、存储过程、RLS 源码 | 仓库 `cloudbase/migrations/<14位版本>_<名称>.sql`（git 为准）；用 MCP `managePgDatabase(action="applyMigration")` 或 `tcb db pg migration` 执行，二者都以这个目录为准 |
| 云函数源码 | 仓库 `cloudfunctions/<函数名>/`（git 为准），部署后在云端运行 |
| 设备照片、凭证等文件 | 环境云存储 |
| 密钥（API Key、短信、微信） | 云函数环境变量；不进仓库，不进 `miniprogram/` |
| 小程序前端 | 不变，由微信发布 |
| 备份 | 个人版无数据回档，需自建定时导出（见第五节） |

日常运行不依赖本机；只有改代码、部署时用到本机仓库，GitHub 上另有副本。

### 安全底线（沿用框架文档二、十一）

- 前端 **不直连 PG**：不在小程序里使用 `rdb()`，也不下发任何 PG 凭据。
- 业务表全部开启 RLS 且不给 `anon`/`authenticated` 授权、不建策略 → 只有云函数持有的 `service_role` 能读写。`service_role` 绕过 RLS，所以角色判断与字段裁剪仍在函数里做，不能省。
- 身份只取平台注入的 OPENID，不信任客户端传来的 openid、角色、价格。
- 员工登录仍需短信验证 + 微信绑定，微信身份不直接等于员工权限。
- 改价、退款、导出、代理收益转账、权限变更继续要求原因并写审计；审计表只追加（存储过程内写入，表上撤销 UPDATE/DELETE）。
- 函数返回值不得包含 `event`、`context`、`process.env` 原样内容。

## 三、代码改造

### 3.1 云函数划分

按业务域分少量函数，函数内用 `action` 路由，减少冷启动次数：

| 函数 | 覆盖接口（对应现有 `server/src`） |
| --- | --- |
| `shop` | 顾客端首页、搜索、详情、咨询预约、分享落地（`catalog`、`shop-share`、`customer-requests`） |
| `auth` | 静默登录、员工短信登录与绑定、登出 |
| `staff-stock` | 模板、采购、验收、入库、库存、盘点、出库、标签数据 |
| `staff-sales` | 收银、销售、退款、维修、借还 |
| `agent` | 代理申请、订单、收益、邀请；员工端代理审核与转账 |
| `admin` | 员工权限、审计、统计报表、导出 |
| `files` | 上传登记、文件认领、凭证临时链接 |

划分可在第一阶段验证冷启动与超时后调整。

### 3.2 复用现有代码

- `miniprogram/constants/*`、`utils/validate.js`、`utils/template.js` 继续作为前后端共享规则，打包进需要的函数（现在 `server/src` 已经这样引用）。
- `server/src` 的业务规则（状态流转、字段裁剪、价格计算、权限点）搬进函数，只替换数据访问部分。
- `miniprogram/mock/` 保留，开发时仍可 `useMock: true` 离线调试；mock 继续遵守字段裁剪规则。
- `miniprogram/utils/request.js` 增加云函数传输层：URL 路径映射到 `{ name, data: { action, ... } }`，返回仍解包为现有信封，页面和 `api/modules/*` 不改调用方式。
- `server/test` 的业务断言改写为针对云函数 + 真实 PG 的集成测试，不改用 mock 冒充通过。

### 3.3 数据访问分层

| 操作类型 | 做法 |
| --- | --- |
| 只读查询（列表、详情、统计） | 表接口或只读视图；复杂聚合写成只读 PG 函数 |
| 单表写（改备注、上下架开关） | 表接口 |
| 多表写 / 需要锁或唯一占用 | **PG 存储过程 + RPC**，一次调用完成整个事务 |

必须走存储过程的流程：采购验收入库、单台/批量入库、收银下单锁库、销售退款冲回、改价留痕、借出与归还、维修收退款与取机、代理订单锁库与收益生成/冲回/标记转账、盘点开单与提交、文件跨业务独占认领、员工权限变更与审计写入。

每次请求尽量只发 1–2 次网关调用，避免触发个人版 3 秒超时。

### 3.4 MySQL → PostgreSQL 改造清单

按 2026-11-09 代码统计（`server/src`、`server/migrations`、`server/scripts`）：

| MySQL 写法 | 出现位置 | PG 处理 |
| --- | --- | --- |
| `ON DUPLICATE KEY UPDATE` | 3 个文件 | `INSERT ... ON CONFLICT (...) DO UPDATE` |
| `INSERT IGNORE` | 3 个文件 | `ON CONFLICT DO NOTHING`；IGNORE 还会吞掉其他错误，逐处核对 |
| `ENUM(...)` 列 | 12 个迁移 | `CHECK` 约束或 PG 枚举类型 |
| `AUTO_INCREMENT` | 2 个迁移 | `GENERATED ... AS IDENTITY`，取新 ID 用 `RETURNING` |
| `affectedRows` 判断 | 3 个文件 | 存储过程内用 `GET DIAGNOSTICS` / `FOUND`；MySQL 在 ON DUPLICATE 更新时返回 2 |
| `JSON_TABLE` | `shop-share.js` | `jsonb_to_recordset` / `jsonb_array_elements` |
| `JSON_EXTRACT`、`->>`、`JSON_OBJECT` | 3 个文件 | `jsonb` 运算符、`jsonb_build_object`；`->>` 语义不同，逐处核对 |
| `DATE_FORMAT`、`TIMESTAMPDIFF`、`DATE_SUB`、`CURDATE` 等 | 7 个文件 | `to_char`、区间运算、`CURRENT_DATE` |
| `ER_DUP_ENTRY` / `errno` | 6 个文件 | PG 错误码 `23505` 等；存储过程把业务错误转成明确错误码返回 |
| `FOR UPDATE` 行锁 | 16 个文件 | 移入存储过程，语义基本一致 |
| 报表视图 `report_catalog`、`report_inventory` | 2 个视图 | 重建并只授权给报表用途 |

- **大小写**：MySQL 默认排序规则不区分大小写和重音，PG 区分。`server/src` 有 12 处 `LIKE` 搜索，唯一约束也受影响；逐处决定用 `ILIKE`、`citext` 或统一小写存储，并补测试。
- **金额**：统一 `numeric(12,2)`，前端仍以“元”为单位；网关返回的 numeric 可能是字符串，函数层统一转换。
- **时间**：统一 `timestamptz`，按 `Asia/Shanghai` 展示。

## 四、实施步骤

每步完成标准都以真实云端验证为准，不让未实现的接口回退到 mock 或假成功。

1. **最小闭环**（体验版）
   - 建 `cloudbase/migrations/`；在 PG 建核心表（角色、用户、员工、会话、短信挑战、审计、分类、型号、单机），开 RLS。
   - 创建 API Key（`service_role`）放入函数环境变量；部署 `auth` 与 `shop` 两个函数。
   - 小程序 `request.js` 接入云函数传输层，开发版切到云开发。
   - 完成标准：顾客首页能从云端 PG 读出数据；员工能登录；客户端直接请求 PG 网关被拒绝；记录冷启动与单次耗时。
   - **进展（2026-11-09）**：
     - 已完成：迁移 `20261109010000_core_identity_shop`、`20261109020000_shop_units` 已上线；`auth`（微信登录、短信、员工登录、`/auth/me`、登出）与 `shop`（`/shop/home`、`/shop/units`）已部署；`anon` 公钥直连表和存储过程均被拒绝；`/shop/units` 直调热启动约 0.5 秒。
     - 已接通：`request.js` 增加云函数传输层（`useCloud`），未迁移的路径直接报“尚未迁移到云开发”，不回退旧服务器；文件上传在云模式下明确报未迁移。
     - 模拟器验收通过：首页从云端 PG 读出在售设备，未开商城展示的设备不出现；微信静默登录建用户；销售测试账号短信验证码（开发固定码）登录进入工作台，身份与工具按销售权限显示，数据库写入员工会话与审计记录。端到端单次调用约 0.45–0.6 秒（热启动）。
     - 开发期小程序：测试号不支持云开发，本机 AppID 改用云环境已关联的小程序（AppID 只写本机 `project.private.config.json`）。TODO(confirm)：正式上线用哪个小程序，届时可能要新建环境并重新部署迁移与云函数。
     - 未测：冷启动耗时（环境未开日志服务，开通会消耗资源点）；工作台等未迁移接口按预期提示“尚未迁移到云开发”。
   - 部署：`node scripts/deploy-cloudfunctions.js [函数名]`，函数环境变量读本机 `.local/cloudbase/functions.env`（不入库）。云函数共享代码放 `cloudfunctions/common/`，部署前由 `scripts/sync-cloudfunctions.js` 复制到各函数的 `shared/`。
2. **库存主链路**：全部表结构迁移；入库、库存查询、并发一机一卖（同一设备两个并发下单只成功一个）、失败回滚。
3. **业务全量**：采购验收、收银退款冲回、借还、维修、代理订单与收益、盘点、统计导出、审计；文件上传与内部凭证判权。
4. **回归**：用顾客、同行、代理、老板、销售身份走一遍；顾客看不到同行价，销售看不到成本和毛利，非代理进不了代理页；身份停用、退出后凭证访问失效。
5. **备份**：上线前完成定时导出与一次恢复演练。
6. **数据迁移与切换**：确定唯一数据来源，导入 PG 并对账（表行数、金额汇总、库存状态、文件数量）；冻结旧端写入后切换体验版/正式版。
7. **收尾**：旧测试服务器下线前保留最终备份；更新 `AGENTS.md` 与 `server/README.md`。

## 五、平台限制与对策

| 限制 | 对策 |
| --- | --- |
| 个人版云函数超时固定 3 秒、内存固定 256MB | 一次请求一次 RPC；导出、统计分页或异步生成到云存储；第一阶段实测，不够就升标准版（是否可调需在控制台确认） |
| 个人版不支持数据回档 | 定时云函数每日导出关键表到 internal 云存储，保留 30 天，定期做恢复演练 |
| 冷启动 | 函数按业务域合并；依赖精简；必要时对高频函数做预热 |
| 共享 PG 无 TCP、无连接池控制 | 只走网关；不引入 `pg` 驱动 |
| 体验版资源点耗尽返回 410 | 开发期留意 `queryEnv(action="usage")`；上线前转个人版 |
| QPS 配额 | 体验版环境 QPS 500；正常门店量级足够 |

## 六、旧方案产物的处理

2026-11-09 已删除为“云托管 + MySQL/COS”准备、从未提交的文件（Dockerfile、`.dockerignore`、`scripts/cloudbase-package.mjs`、`server/.env.cloudbase.example`、`server/scripts/cloudbase-check.js`、`server/src/cloudbase-*.js` 及其测试），并还原了 `server/src/app.js`、`server/src/index.js` 的配套改动。

迁移完成前现有 `server/`（Fastify + MySQL）继续服务旧测试服务器，不删除。

## 七、待确认事项

- TODO(confirm)：PG 独享实例的套餐门槛是“标准版及以上”还是“企业版及以上”（文档两处说法不一致）。
- TODO(confirm)：标准版云函数超时与内存是否可调。
- TODO(confirm)：迁移数据来源——旧测试服务器数据库，还是从空库重新录入。
- TODO(confirm)：短信服务继续用腾讯云短信，还是改用云开发自带短信（50 点/条）。

## 八、依据

- 资源点价格与套餐配额（含 PG 独享门槛、个人版云函数限制、云托管与云函数单价）：https://cloud.tencent.com/document/product/876/127357
- PG 数据库管理（共享实例计量、升级独享、不可降级）：https://docs.cloudbase.net/database/postgresql/database-management
- PG 模式概述（角色模型、RLS）：https://docs.cloudbase.net/quick-start/pg-overview
- 资源点计费 FAQ：https://docs.cloudbase.net/quick-start/resource-point
- 云托管收费：https://docs.cloudbase.net/run/faq/fee
- 共享实例不能 TCP 直连、云函数经网关与 API Key 访问 PG：CloudBase 插件 skill `postgresql-development-cloudbase`（`references/troubleshooting.md`、`references/auth-and-rls.md`）
