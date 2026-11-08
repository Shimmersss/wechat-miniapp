# 夏目数码 · 微信小程序 + ERP

二手机零售的「一套真实库存、多套展示价格、全程身份留痕」小程序：顾客端浏览/咨询/预约，同行与代理分享，员工经营端（采购验收 → 入库 → 库存 → 收银退款 → 维修/借还 → 统计）与老板管理后台。

口号：让价格透明 · 让产品放心。

## 快速开始

微信开发者工具**导入仓库根目录**，不要只选 `miniprogram/`——根目录 `project.config.json` 用 `miniprogramRoot` 指定源码位置。开发版默认连测试服务器（`miniprogram/config/index.js`，`useMock: false`），员工用手机号和验证码登录。

要用内存 mock 时，把 `develop` 的 `useMock` 改为 `true` 后重新编译，不要提交这项改动。mock 模式下可在「我的 → 开发调试」切换模拟身份、加载测试设备，员工登录页也能选模拟角色。

本机跑后端（`server/`）：Mac 用 `npm --prefix server run db:start` 和 `npm --prefix server start`；Ubuntu 用 `./scripts/local-dev.sh start`（依赖 systemd，Mac 上不能用）。详见 [`server/README.md`](server/README.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `miniprogram/` | 小程序源码（59 页，主包 + shop/agent/staff/demo 四个分包） |
| `server/` | Fastify + MySQL 后端（旧测试服务器在用，将迁到云开发） |
| `docs/` | 云开发迁移方案、角色测试用例、测试点库、历史证据；旧文档在 `docs/archive/` |
| `scripts/` | `appid.sh` 设置本机 AppID；`local-dev.sh` 管理 Ubuntu 本机服务 |
| `tests/` | 小程序与 mock 回归测试 |
| `.local/` | 持久数据（MySQL 文件、上传文件），**不是缓存，不要删** |

## 文档指引

- **需求权威依据**：[`夏目数码_小程序与ERP整体框架_V0.3.md`](夏目数码_小程序与ERP整体框架_V0.3.md)
- **开发约定与功能清单**：[`AGENTS.md`](AGENTS.md)（先读这个）
- **云开发迁移方案（云函数 + PostgreSQL）**：[`docs/WECHAT-CLOUDBASE-MIGRATION.md`](docs/WECHAT-CLOUDBASE-MIGRATION.md)（已定案，业务尚未切换）
- **角色业务测试用例与预置设备**：[`docs/role-tests/`](docs/role-tests/README.md)
- **按模块的测试点库**：[`docs/test-cases/`](docs/test-cases/README.md)
- **现行后端接口、账号、配置**：[`server/README.md`](server/README.md)
- **UI 设计稿与取舍**：[`design-demos/README.md`](design-demos/README.md)
- **历史记录（流水账、旧进度、旧交接）**：[`docs/archive/`](docs/archive/README.md)，只供查历史

## 测试

```sh
node --test tests/*.test.js                                  # 小程序/mock
npm --prefix server run test:db                              # 准备专用验证库
cd server && node --env-file=.env --test --test-concurrency=2 test/*.test.js   # 后端
```

后端测试使用 `xiamu_verification`，不清空业务库；微信/SMS 外部调用使用替身，不代表外部账号已联调。

## 当前状态

测试服务器已部署（文件走腾讯云 COS，数据库每日备份），开发版已接入；**尚未发布到微信线上**。后端已定案迁到微信云开发（云函数 + PostgreSQL），迁移完成前测试服务器继续使用。

测试服务器使用开发固定验证码，只能放测试数据。上线前必须切到 `NODE_ENV=production`、删除 `OTP_DEV_CODE`，并配齐正式微信 AppSecret、腾讯云短信、域名与 ICP 备案、HTTPS、微信合法域名和小程序码；备份异地存储与恢复演练也未做。缺配置时接口明确报错，不伪造成功。

功能缺口：蓝牙标签打印、收银小票与收款码打印、邀请海报成图、正式小程序码。

