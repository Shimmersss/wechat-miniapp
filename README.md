# 夏目数码 · 微信小程序 + ERP

二手机零售的「一套真实库存、多套展示价格、全程身份留痕」小程序：顾客端浏览/咨询/预约，同行与代理分享，员工经营端（采购验收 → 入库 → 库存 → 收银退款 → 维修/借还 → 统计）与老板管理后台。

口号：让价格透明 · 让产品放心。

## 快速开始

```sh
./scripts/local-dev.sh start   # 启动 Docker MySQL(127.0.0.1:3307) + API(127.0.0.1:3000)
./scripts/local-dev.sh open    # 在微信开发者工具中打开本项目
```

微信开发者工具**导入仓库根目录**，不要只选 `miniprogram/`——根目录 `project.config.json` 用 `miniprogramRoot` 指定源码位置。开发版默认连测试服务器（`miniprogram/config/index.js`，`useMock: false`），员工用手机号和验证码登录。

要用内存 mock 时，把 `develop` 的 `useMock` 改为 `true` 后重新编译，不要提交这项改动。mock 模式下可在「我的 → 开发调试」切换模拟身份、加载测试设备，员工登录页也能选模拟角色。

## 目录

| 路径 | 内容 |
|---|---|
| `miniprogram/` | 小程序源码（59 页，主包 + shop/agent/staff/demo 四个分包） |
| `server/` | Fastify + MySQL 后端，与上传目录分离，22 个迁移 |
| `docs/` | 验收说明、实施记录、进度、Ubuntu 本机部署、开发环境交接 |
| `scripts/local-dev.sh` | 本机启动/停止/重启/状态/日志/打开工具 |
| `tests/` | 小程序与 mock 回归测试 |
| `.local/` | 持久数据（MySQL 文件、上传文件），**不是缓存，不要删** |

## 文档指引

- **开发约定与待实现清单**：[`AGENTS.md`](AGENTS.md)（先读这个）
- **本机环境、排障、备份**：[`docs/开发环境交接文档.md`](docs/开发环境交接文档.md)、[`docs/LOCAL-UBUNTU.md`](docs/LOCAL-UBUNTU.md)
- **方案 G 视觉演示（雾白层叠）**：[`docs/方案G视觉演示交接文档.md`](docs/方案G视觉演示交接文档.md)
- **验收走查表与已知缺口**：[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)
- **角色业务测试用例与预置设备**：[`docs/role-tests/`](docs/role-tests/README.md)
- **实施记录 / 进度**：[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)、[`docs/PROGRESS.md`](docs/PROGRESS.md)
- **后端接口、账号、配置**：[`server/README.md`](server/README.md)
- **需求权威依据**：[`夏目数码_小程序与ERP整体框架_V0.3.md`](夏目数码_小程序与ERP整体框架_V0.3.md)

## 测试

```sh
node --test tests/*.test.js                                  # 小程序/mock：35 项
npm --prefix server run test:db                              # 准备专用验证库
cd server && node --env-file=.env --test --test-concurrency=2 test/*.test.js   # 后端：80 项
```

2026-11-07 小程序/mock 35/35 通过；后端最近一次完整复跑是 2026-11-04（当时 67/67），之后新增的用例和 COS、固定验证码改动未经后端全量复跑。测试使用 `xiamu_verification`，不清空业务库；微信/SMS 外部调用使用替身，不代表外部账号已联调。

## 当前状态

测试服务器已部署（文件走腾讯云 COS，数据库每日备份），开发版已接入；**尚未发布到微信线上**。

测试服务器使用开发固定验证码，只能放测试数据。上线前必须切到 `NODE_ENV=production`、删除 `OTP_DEV_CODE`，并配齐正式微信 AppSecret、腾讯云短信、域名与 ICP 备案、HTTPS、微信合法域名和小程序码；备份异地存储与恢复演练也未做。缺配置时接口明确报错，不伪造成功。

功能缺口：蓝牙标签打印、收银小票与收款码打印、邀请海报成图、正式小程序码。

