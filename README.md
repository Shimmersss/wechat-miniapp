# 夏目数码 · 微信小程序 + ERP

二手机零售的「一套真实库存、多套展示价格、全程身份留痕」小程序：顾客端浏览/咨询/预约，同行与代理分享，员工经营端（采购验收 → 入库 → 库存 → 收银退款 → 维修/借还 → 统计）与老板管理后台。

口号：让价格透明 · 让产品放心。

## 快速开始

微信开发者工具**导入仓库根目录**，不要只选 `miniprogram/`——根目录 `project.config.json` 用 `miniprogramRoot` 指定源码位置。各版本统一读取 `scripts/configure-cloud-preview.js` 生成的 HTTPS 网关配置，员工通过已绑定的微信登录。

本机跑后端（`server/`）：Mac 用 `npm --prefix server run db:start` 和 `npm --prefix server start`；Ubuntu 用 `./scripts/local-dev.sh start`（依赖 systemd，Mac 上不能用）。详见 [`server/README.md`](server/README.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `miniprogram/` | 小程序源码（55 页，主包 + shop/agent/staff 三个分包） |
| `server/` | Fastify + MySQL 后端（旧版后端） |
| `docs/` | 云开发迁移方案、验收和历史证据；旧文档在 `docs/archive/` |
| `scripts/` | `appid.sh` 设置本机 AppID；`local-dev.sh` 管理 Ubuntu 本机服务 |
| `.local/` | 持久数据（MySQL 文件、上传文件），**不是缓存，不要删** |

## 文档指引

- **需求权威依据**：[`夏目数码_小程序与ERP整体框架_V0.3.md`](夏目数码_小程序与ERP整体框架_V0.3.md)
- **开发约定与功能清单**：[`AGENTS.md`](AGENTS.md)（先读这个）
- **云开发迁移方案（云函数 + PostgreSQL）**：[`docs/WECHAT-CLOUDBASE-MIGRATION.md`](docs/WECHAT-CLOUDBASE-MIGRATION.md)（现行后端）
- **旧版后端接口、账号、配置**：[`server/README.md`](server/README.md)
- **UI 设计稿与取舍**：[`design-demos/README.md`](design-demos/README.md)
- **历史记录（流水账、旧进度、旧交接）**：[`docs/archive/`](docs/archive/README.md)，只供查历史

## 发布与验收

`node scripts/audit-cloud-coverage.js` 可核对小程序 API 与云函数的路由映射。发布版从真实网关读取数据，验收结果在 [WORKLOG](docs/archive/WORKLOG.md)。

微信开发者工具上传后，由管理员在微信公众平台核对合法域名并在「版本管理」提交审核，通过后发布。正式版本以公众平台显示为准。
