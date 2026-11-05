# 夏目数码 · 微信小程序 + ERP

二手机零售的「一套真实库存、多套展示价格、全程身份留痕」小程序：顾客端浏览/咨询/预约，同行与代理分享，员工经营端（采购验收 → 入库 → 库存 → 收银退款 → 维修/借还 → 统计）与老板管理后台。

口号：让价格透明 · 让产品放心。

## 快速开始

```sh
./scripts/local-dev.sh start   # 启动 Docker MySQL(127.0.0.1:3307) + API(127.0.0.1:3000)
./scripts/local-dev.sh open    # 在微信开发者工具中打开本项目
```

微信开发者工具**导入仓库根目录**，不要只选 `miniprogram/`——根目录 `project.config.json` 用 `miniprogramRoot` 指定源码位置。开发版默认 `useMock: true`，页面走内存 mock，不依赖后端。

身份切换：「我的 → 开发调试 / 切换模拟身份」，或员工登录页选择模拟员工角色。

## 目录

| 路径 | 内容 |
|---|---|
| `miniprogram/` | 小程序源码（53 页，主包 + shop/agent/staff 三个分包） |
| `server/` | Fastify + MySQL 后端，与上传目录分离，19 个迁移 |
| `docs/` | 验收说明、实施记录、进度、Ubuntu 本机部署、开发环境交接 |
| `scripts/local-dev.sh` | 本机启动/停止/重启/状态/日志/打开工具 |
| `tests/` | 小程序与 mock 回归测试 |
| `.local/` | 持久数据（MySQL 文件、上传文件），**不是缓存，不要删** |

## 文档指引

- **开发约定与待实现清单**：[`AGENTS.md`](AGENTS.md)（先读这个）
- **本机环境、排障、备份**：[`docs/开发环境交接文档.md`](docs/开发环境交接文档.md)、[`docs/LOCAL-UBUNTU.md`](docs/LOCAL-UBUNTU.md)
- **方案 G 视觉演示（雾白层叠）**：[`docs/方案G视觉演示交接文档.md`](docs/方案G视觉演示交接文档.md)
- **验收走查表与已知缺口**：[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)
- **实施记录 / 进度**：[`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md)、[`docs/PROGRESS.md`](docs/PROGRESS.md)
- **后端接口、账号、配置**：[`server/README.md`](server/README.md)
- **需求权威依据**：[`夏目数码_小程序与ERP整体框架_V0.3.md`](夏目数码_小程序与ERP整体框架_V0.3.md)

## 测试

```sh
node --test tests/*.test.js                                  # 小程序/mock：25 项
npm --prefix server run test:db                              # 准备专用验证库
cd server && node --env-file=.env --test --test-concurrency=2 test/*.test.js   # 后端：67 项
```

2026-11-04 复跑：小程序/mock 25/25、后端 67/67，均无失败。测试使用 `xiamu_verification`，不清空业务库；微信/SMS 外部调用使用替身，不代表外部账号已联调。

## 当前状态

本机开发环境已部署并在模拟器验证；**尚未发布到微信线上**。正式微信 AppSecret、腾讯云短信、合法域名、小程序码、生产部署与备份恢复演练均未配置，缺配置时接口明确报错而不伪造成功。

功能缺口（详见 `docs/PROGRESS.md` 第六节）：顾客搜索页与分类筛选、蓝牙标签打印、收银小票/收款凭证、销售列表按销售员筛选、商品详情相似推荐、邀请海报成图。

