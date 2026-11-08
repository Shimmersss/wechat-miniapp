# Ubuntu 本机开发部署

2026-11-04 部署于 Ubuntu Kylin 22.04.5，项目目录为 `/home/smxvjv/Desktop/weixinapp`。

完整的日常使用、排障、配置与接手说明见 [开发环境交接文档](开发环境交接文档.md)。

## 已配置的环境

- Node.js 22.23.4，用户安装于 `~/.local/opt/nodejs/`，`node`、`npm` 位于 `~/.local/bin/`。
- 服务端通过 `npm --prefix server ci` 安装锁定依赖。
- MySQL 8.4.13，使用官方 Docker 镜像，容器 `xiamu-wechat-mysql`；实际镜像 digest 记录在 `.local/mysql-image.txt`。
- MySQL 仅监听 `127.0.0.1:3307`，API 仅监听 `127.0.0.1:3000`。
- 数据库名 `xiamu`；应用、迁移、报表、备份账号分离，已执行仓库迁移与表级授权。
- 使用 systemd 用户服务 `xiamu-mysql.service` 和 `xiamu-api.service` 管理进程。API 启动时等待数据库就绪；服务未设置登录自启。
- 为适配 12GB 内存，数据库 buffer pool 为 64MiB，容器内存上限 1GiB，API 内存上限 384MiB。保留 performance_schema，供并发锁验证使用。

本机数据库通过 Docker 运行，**不要运行原来依赖 Homebrew 的 `npm --prefix server run db:start`**。新机器初始化应另行按对应环境配置；本说明中的命令用于管理已经部署好的这台机器。

## 日常使用

在项目根目录执行：

```sh
./scripts/local-dev.sh start    # 启动数据库与 API，并检查健康状态
./scripts/local-dev.sh open     # 在微信开发者工具打开项目
./scripts/local-dev.sh status   # 服务状态
./scripts/local-dev.sh restart  # 修改服务端代码后重启 API
./scripts/local-dev.sh logs     # 查看服务日志，Ctrl+C 退出日志查看
./scripts/local-dev.sh stop     # 停止服务，保留所有持久数据
```

健康检查：`curl http://127.0.0.1:3000/api/v1/health`。正常返回 `{"code":0,"data":{"status":"ready"},"message":"ok"}`。

## 小程序与真实 API 的区别

微信工具导入仓库根目录，使用已有 AppID，源码目录由 `miniprogramRoot` 指向 `miniprogram/`。

小程序开发版默认连测试服务器（`useMock: false`），本机 API 只有把 `baseUrl` 临时改到本机时才会被页面使用。要做页面与角色操作演示，临时把 `useMock` 改为 `true`，不要提交；此时可在“我的 → 开发调试 / 切换模拟身份”或员工登录页切换身份，重新编译会重置内存中的模拟业务数据。API 健康检查成功不代表小程序页面已使用 MySQL。

正式联调仍需管理员配置微信 AppSecret、腾讯云短信凭据、对应 AppID 的开发者权限。上线还需 HTTPS 域名与微信合法域名配置。目前没有上传、提审或发布小程序，也没有设置生产域名。测试服务器用开发固定验证码 `OTP_DEV_CODE` 登录，只在非 `production` 环境生效，上线前必须删除。

`project.config.json` 的 `watchOptions.ignore` 排除了 `.local/`、后端依赖和 `.git/`，避免微信工具监听 MySQL 临时文件与大量后端依赖。后端及密钥均在小程序上传目录之外。

本机其他桌面程序已占满每用户 inotify 实例额度，导致微信工具初始化文件监听时卡住。`~/.local/bin/wechat-devtools` 启动包装器已设置 `CHOKIDAR_USEPOLLING=1`、`CHOKIDAR_INTERVAL=1000`，改用轮询；桌面和应用菜单仍指向此入口，无需修改系统内核参数。请通过快捷方式或该入口启动工具。

## 开发者工具命令行 / MCP（wechatide）

开发者工具自带 `wechatide` 命令行（`~/.local/opt/wechat-devtools/current/bin/wechatide`），可编译、打开页面、截图、读控制台、在运行时执行代码，说明见安装目录下 `resources/app.asar.unpacked/wechatide-skill/SKILL.md`。

社区 Linux 移植版有一个路径不一致：工具界面把服务端口写在 `~/.config/wechat-devtools/app/Default/.ide`，命令行却去 `~/.config/wechat-devtools/10e785db0c2d6956ab211bd1cb2591cd/Default/.ide` 读取，结果是工具开着也报 `CONNECT_ERROR`。2026-11-05 已加软链修复：

```sh
ln -s ../app/Default ~/.config/wechat-devtools/10e785db0c2d6956ab211bd1cb2591cd/Default
```

若升级工具后安装路径变化，哈希目录名会变，用 `strace -e openat wechatide -c ClaudeCode check_wechatide_status` 看它实际读取的路径再重建软链。命令行必须在沙箱外执行；首次连接需在工具里点允许授权。常用：

```sh
W=~/.local/opt/wechat-devtools/current/bin/wechatide; P=$PWD
$W -c ClaudeCode check_wechatide_status --skill-version 0.3.11
$W -c ClaudeCode simulator_open_page --project $P --page packages/demo/home/index
$W -c ClaudeCode simulator_screenshot --project $P --path /tmp/shot.png --wait 3
$W -c ClaudeCode get_simulator_console --project $P --command 'grep -i error'
```

## 持久数据与凭据

- `.local/mysql/`：MySQL 实际数据文件。
- `.local/files/`：真实 API 上传文件。
- `server/.env`：仅 API 使用的运行账号和签名密钥。
- `server/.env.migration`：仅迁移步骤使用的账号。
- `.local/mysql-accounts.json`：本机引导账号，禁止公开或提交。

敏感配置文件权限为 0600，`.local/` 权限为 0700；这些文件均被 Git 忽略。停止服务或重启机器不会清空数据库。不要删除 `.local/`，不要对该实例执行重新初始化。

本机未创建正式老板账号；正式账号引导和首次登录仍需真实微信/SMS。数据库和上传文件的生产备份、恢复演练未在本次本机部署中配置。

## 验证命令

```sh
node --test tests/*.test.js
npm --prefix server run test:db
cd server
node --env-file=.env --test --test-concurrency=2 test/*.test.js
```

后端测试使用独立的 `xiamu_verification`，不会清空业务库。外部微信和短信在测试中使用替身，因此测试通过不等于正式外部登录已联调。

2026-11-04 部署验证：小程序/mock 测试 25/25 通过，真实 HTTP/MySQL 后端测试 67/67 通过，API 与数据库停止后重新启动健康检查正常；微信模拟器已实际显示 3 台商品，首页、分类、成为代理、我的四个 tab 切换正常，本轮运行未捕获到 JS 异常。验证记录为 `.local/deployment-verification.json`，首页截图为 `.local/home-simulator.png`。
