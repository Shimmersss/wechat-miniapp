# 方案 G「雾白层叠」视觉演示 · 交接文档

2026-11-05 编写。说明这次做了什么、为什么这样设计、具体怎么做出来，以及后续要把它推广到正式页面时怎么接手。

相关文件：

- 静态设计稿：`design-demos/07-frost/index.html`（浏览器直接打开），总说明见 `design-demos/README.md` 第 2.4、2.5 节
- 小程序可运行版：`miniprogram/packages/demo/`
- 颜色令牌：`miniprogram/styles/theme.wxss` 的 `--frost-*` 一节

---

## 1. 现状一览

| 项 | 状态 |
|---|---|
| 设计稿 A / D / F 补层次 | 已完成，截图已重出（`design-demos/*/preview.png`、`compare.png`） |
| 设计稿 G（白色系，新增） | 已完成，`design-demos/07-frost/` |
| G 的小程序可运行版 | 已完成，独立演示分包 `packages/demo`，首页 / 经营 / 库存 / 我的四页 |
| 现有正式页面 | **一个都没改样式**，只在「我的 → 开发调试」加了一个入口 |
| 模拟器验证 | 老板、销售两个身份走过四页，控制台无报错；`node --test tests/*.test.js` 31/31 通过 |
| 真机验证 | 已推送预览到开发者微信，**毛玻璃效果的真机表现尚待确认** |
| 设计稿 B / C / E | 未补层次 |
| 版本库 | 本次改动尚未提交 |

## 2. 怎么打开

**模拟器**

- 「我的 → 开发调试 → 方案 G 视觉演示（雾白层叠）」。员工身份进「经营」，其它身份进「首页」。该入口只在 `useMock: true` 时显示。
- 或在开发者工具里新建编译条件，启动页面填 `packages/demo/home/index`。
- 经营 / 库存 / 我的三页是员工页（`requireStaff`），先在同一个「开发调试」区块里切到老板或销售等员工模拟身份。

**真机**

- 开发者工具「预览」扫码，编译条件选 `packages/demo/home/index`；或用命令行直接推送到开发者微信（见第 8 节）。
- 预览包是开发版，同样走 mock 数据，不需要后端。

**页面关系**：四页之间靠悬浮底栏切换（`redirectTo`），中间「＋」进现有收银页（`ROUTES.POS`，没有 `SALES_CREATE` 权限时提示）。所有功能入口点进去都是现有的真实页面，回到演示页用返回键。

---

## 3. 设计理念

### 3.1 要解决的问题

上一轮六个方案（A–F）的通病是**所有东西都在一个平面上**：页面底接近白色，卡片也是白色，分组标题直接压在底上，只能靠 1px 描边区分。信息一多就糊成一片，看不出哪里重要。

参考的那款门店小程序颜色很普通，但层次清楚：顶部有一块有颜色的氛围底，白卡浮在上面，卡内元素再低一级。用户第一眼就知道先看哪里。

### 3.2 G 的核心思路：白色系不靠颜色分层

全白方案最容易糊。G 刻意不用彩色块来分层，而是用三种物理感更强的手段：

1. **虚化**：最上层是毛玻璃，透出下面被模糊的内容，一眼就能看出它浮在上面。
2. **高度**：用投影深浅表示离屏幕多远。玻璃投影最深，白卡投影最浅。
3. **凹凸**：卡内的图标底、数据格、标签用比白更灰一点的「凹槽」色，像是压进卡面里。

### 3.3 几条原则

- **每页只有一个最重的块。** 首页是搜索框，库存页是数据大卡，经营页是顶部三个数字，我的页是个人卡。其余内容一律降成白卡。重的块多了等于没有重点。
- **颜色极度克制。** 只有两种颜色有含义：墨色 `#111215` 表示主操作或选中，红色 `#E5484D` 表示价格、金额或需要注意。偶尔用绿色表示毛利为正。其它都是灰阶。
- **光晕只为玻璃服务。** 顶部那团淡蓝、桃色、紫色光晕本身不传达信息。它的作用是给毛玻璃一些可以被虚化的东西，否则玻璃盖在纯白上看不出效果。
- **虚化效果最明显的地方放在一直可见的位置。** 顶栏和悬浮底栏是常驻的，内容从下面滑过时虚化最直观。
- **视觉不能越过业务规则。** 演示页照样遵守权限、价格、字段裁剪等全部约定，不能为了好看伪造数据（见第 6 节）。

---

## 4. 设计方法

### 4.1 层次模型

从下往上：

| 层 | 用在哪里 | 做法 | 令牌 |
|---|---|---|---|
| L0 页面底 | 整页 | 冷浅灰，不是白 | `--frost-bg` `#F2F3F5` |
| L0.5 光晕 | 页面顶部约 1040rpx | 三个径向渐变 + `filter: blur(34px)`，往下用 mask 渐隐 | `--frost-aura-1/2/3` |
| L1 白卡 | 普通分组、列表、提示条 | 纯白，无描边，浅投影，圆角 44rpx | `--frost-card`、`--frost-e1` |
| L2 毛玻璃 | 顶栏、底栏、每页唯一的主块 | 半透明白渐变 + `backdrop-filter: blur(22px) saturate(180%)` + 1rpx 内描边高光 + 最深投影，圆角 52rpx | `--frost-glass`、`--frost-glass-flat`、`--frost-glass-edge`、`--frost-e3` |
| 卡内凹槽 | 图标底、数据格、标签、商品图底 | 比白卡低一级的灰 + 内阴影 | `--frost-well`、`--frost-hair` |

投影分三级：`--frost-e1` 用于白卡，`--frost-e2` 是中间档，`--frost-e3` 用于玻璃。墨色主按钮用单独的 `--frost-ink-shadow`。

文字分四级灰：`--frost-ink` 标题和数字，`--frost-ink-2` 正文，`--frost-ink-3` 辅助说明，`--frost-ink-4` 页脚提示。

### 4.2 每页怎么分配层次

| 页面 | 最重的块（玻璃） | 白卡 | 凹槽 |
|---|---|---|---|
| 首页（顾客） | 搜索框 | 商品卡 | 商品图底 |
| 库存 | 数据大卡：在库数、今日入库、在库成本 + 快捷入口 | 预警条、今日销售卡 | 6 个销售数据格、快捷入口图标底 |
| 经营 | 顶部三个数字：净额、毛利、在库 | 维修 / 采购 / 顾客与代理分组、待办 | 图标底、分组右上角的小标签 |
| 我的（员工） | 个人卡 + 四格概览 | 店铺管理 / 财务 / 库存 / 其他分组 | 图标底 |

预警条统一加左侧 6rpx 红线（`.alert`），不整块变红。

### 4.3 做设计稿的过程

1. 先在 `design-demos/` 用 HTML 画静态稿，四个页面并排，用 `./shoot.sh` 出截图。
2. 用 Chrome headless 截图对比，逐项修问题。例如胶囊按钮被拉成大圆，"无权限查看"字号太大挤爆数据格。
3. 定稿后翻成小程序。HTML 稿里的 px 按 2 倍换成 rpx。模糊半径（`blur()`）保留 px，因为小程序里 `filter` 和 `backdrop-filter` 写 rpx 不生效。
4. 翻译时不改业务逻辑，只换皮。数据、权限、跳转全部复用现有接口和页面。
5. 用微信开发者工具命令行编译、打开页面、截图、读控制台，分别切老板和销售身份核对。

### 4.4 自查清单（新增或修改页面时对照）

- [ ] 这一页的唯一重点块是哪个？是否只有它用了 `.glass`？
- [ ] 颜色是否只来自 `--frost-*` 令牌？除墨色和红色外，有没有别的彩色？
- [ ] `.aura` 是否放在页面级容器里，而不是放进 `scroll-view`？放进去会跟着滚走。
- [ ] 内容最后一屏能否滚出底栏？`frost-tabbar` 自带占位，不要再额外加 `padding-bottom`。
- [ ] 字段为 `undefined` 时是否显示「无权限查看」？是否用了 `.cv-none` / `.mv-none` / `.tv-none` 这类小一号的样式？
- [ ] 金额是否走 `f.maskMoney(..., privacy)`，让隐藏开关生效？

---

## 5. 代码结构

```
miniprogram/
  styles/theme.wxss              --frost-* 令牌（追加在 page {} 末尾，不影响现有令牌）
  constants/routes.js            DEMO_HOME / DEMO_STOCK / DEMO_BIZ / DEMO_MINE
  app.json                       subpackages 增加 { root: "packages/demo", name: "demo" }
  pages/mine/index.{wxml,js}     开发调试区块增加入口 goDemo()
  packages/demo/
    styles/frost.wxss            公共类：.frost .aura .body .glass .card .well
                                 .group* .tiles .tile .ico .alert* .chev .notice .endnote
    entries.js                   功能入口表 STOCK_QUICK / BIZ_GROUPS / MINE_GROUPS + 按权限过滤
    components/
      frost-nav/                 毛玻璃顶栏（自定义导航栏）
      frost-tabbar/              悬浮毛玻璃底栏
    home/  stock/  biz/  mine/   四个演示页
    icons/                       41 个多彩 SVG（从 design-demos/icons-v2.js 拆出）
```

### 5.1 页面骨架

每个演示页的结构相同：

```xml
<frost-nav title="库存数据" />
<view class="frost">
  <view class="aura"></view>          <!-- 光晕，绝对定位在最底 -->
  <view class="body">
    <view class="hero glass">…</view>  <!-- 唯一主块 -->
    <view class="card mt">…</view>     <!-- 白卡 -->
  </view>
  <frost-tabbar active="stock" />
</view>
```

页面 JSON 必须设置：

```json
{
  "navigationStyle": "custom",
  "backgroundColor": "#F2F3F5",
  "usingComponents": {
    "frost-nav": "../components/frost-nav/index",
    "frost-tabbar": "../components/frost-tabbar/index"
  }
}
```

`backgroundColor` 是下拉回弹时露出的窗口底色，JSON 里不能用 CSS 变量，所以这里是 `--frost-bg` 的字面值，两处要同步改。

### 5.2 frost-nav（顶栏）

- 读 `wx.getMenuButtonBoundingClientRect()` 拿胶囊按钮位置，让标题与胶囊垂直居中，右侧避开胶囊。
- 栏高 = 胶囊顶部 + 胶囊高度 + （胶囊顶部 − 状态栏高度）+ 4px，也就是胶囊上下留白对称。
- 拿不到胶囊位置时（极少数环境）回退到状态栏高度 + 6px、高 32px。
- 组件自带一个等高占位，页面内容从栏下开始；栏本身 `position: fixed`，内容滚动时从下面滑过并被虚化。

### 5.3 frost-tabbar（底栏）

- `TABS` 定义五个位置：首页、经营、＋、库存、我的。新增或调整 tab 改这里。
- 切换用 `wx.redirectTo`，不用 `switchTab`，因为演示页不是 `app.json` 里注册的 tabBar 页。
- 图标按选中状态取 `tab-*-ink.svg`（选中）或 `tab-*-gray.svg`。
- 自带底部占位，高度为 `184rpx + env(safe-area-inset-bottom)`。

### 5.4 entries.js（入口表）

- 每项是 `{ text, icon, url, perm }`。`perm` 可以是单个权限点，也可以是数组（满足任一即可），省略表示所有人可见。
- `allowed(user, items)` 过滤单个列表，`allowedGroups(user, groups)` 过滤分组并去掉空组。
- 过滤只决定**显示哪些入口**。目标页面自己仍由 `createPage` 的 `permission` 守卫，这里漏过滤也不会越权。

### 5.5 数据来源

| 页面 | 接口 | 说明 |
|---|---|---|
| 首页 | `api.shop.home()`、`api.shop.units({ brand, page: 1, pageSize: 6 })` | 价格是服务端按渠道算好的 `price`，前端只展示 |
| 库存 | `api.dashboard.overview()` | `stockCost`、`profit`、`margin` 可能被服务端裁掉 |
| 经营 | `api.dashboard.overview()` | 同上，另用 `repair`、`visits`、`todos` 填分组右上角的小标签 |
| 我的 | `api.dashboard.overview()` | 仅在有 `DASHBOARD_VIEW` 时请求，否则不显示四格概览 |

库存、经营两页在 `onShow` 里重新加载，从真实页面返回时数字会刷新。

### 5.6 图标

- 来源是 `design-demos/icons-v2.js` 的 `<symbol>`。小程序 `<image>` 不支持 `<use href>` 引用，所以拆成独立 `.svg` 文件，并把渐变定义内联进每个文件。
- 这是多彩图标，不通过 CSS 换色。需要不同颜色就单独导出一份，例如 `chev-gray` / `chev-soft`、`tab-*-ink` / `tab-*-gray`。
- 只保留用到的 41 个，合计约 168K，放在分包里，不占主包。
- 这与 `AGENTS.md` 中「图标用 `assets/icons/` 深色 / gray / white 三套」的约定不同。如果正式采用 G，需要决定新图标放哪里，并更新约定。

---

## 6. 遵守的项目约定

演示页虽然是视觉实验，但和正式页面一样遵守 `AGENTS.md`：

- 页面全部用 `createPage()`，员工页加 `requireStaff: true` + `permission`。
- 跳转用 `ROUTES` 常量（`$go` / `onNavigate`）。
- 价格只展示服务端返回值，前端不计算。
- 字段裁剪在服务端，前端只判断 `=== undefined` 后显示「无权限查看」，不按角色隐藏已拿到的数据。已核对：销售身份下成本、毛利、毛利率都显示「无权限查看」。
- 金额隐藏开关（`privacy` / `togglePrivacy`）照常生效。
- 颜色、阴影只用 `theme.wxss` 变量。唯一例外是页面 JSON 的 `backgroundColor`，见 5.1。
- 组件样式隔离，`frost-nav` 和 `frost-tabbar` 不依赖 `app.wxss`。
- 公开页（首页）不出现 IMEI，商品卡只显示型号、容量、颜色、电池、质保。

---

## 7. 后续开发

### 7.1 在演示分包里加一页

1. 在 `packages/demo/<名称>/` 建四件套，`index.wxss` 首行 `@import "../styles/frost.wxss";`。
2. 页面 JSON 按 5.1 填写。
3. `app.json` 的 demo 分包 `pages` 加上路径，`constants/routes.js` 加 `DEMO_XXX`。
4. 需要出现在底栏，就改 `frost-tabbar/index.js` 的 `TABS`，并准备 `-ink` / `-gray` 两个图标。

### 7.2 加或调整功能入口

只改 `entries.js`。在对应分组里加 `{ text, icon, url: ROUTES.XXX, perm: PERM.XXX }`，图标放进 `packages/demo/icons/`。

### 7.3 推广到正式页面（建议路线）

演示分包刻意和正式页面隔离，验证通过后可以分步迁移：

1. **真机确认毛玻璃效果。** 重点看安卓机，尤其是老机型和低版本微信。
2. **先提升令牌。** 把 `--frost-*` 的值合并进现有 `--c-*` 令牌，例如 `--c-bg → #F2F3F5`、`--c-ink → #111215`，再补投影、玻璃两组新令牌。只改这一层，全站会整体变色但不破坏逻辑，先看效果。
3. **公共样式上移。** 把 `frost.wxss` 中的 `.glass` `.card` `.well` `.group` `.tiles` 合并进 `app.wxss`。注意现有 `.card` 已经存在，要逐页检查。
4. **组件上移。** `frost-nav`、`frost-tabbar` 移到 `miniprogram/components/`。员工端一级页的 `staff-tabbar` 可以换成悬浮玻璃样式。顾客端 `custom-tab-bar/` 是原生 tabBar 机制，只换样式，不改切换方式。
5. **逐页套层次。** 每页按 4.2 的方法先定唯一主块，再把其余内容降成白卡。从员工工作台、库存、我的开始，这三页结构和演示页最接近。
6. **收尾。** 迁移完成后删除 `packages/demo`、`DEMO_*` 路由、「我的」页入口和 `--frost-*` 令牌，并更新 `AGENTS.md` 的样式约定和图标约定。

### 7.4 删除演示

删除以下内容即可，不影响任何正式功能：

- `miniprogram/packages/demo/`
- `app.json` 里的 demo 分包
- `routes.js` 里的四个 `DEMO_*`
- `pages/mine` 的 `goDemo` 及其列表项
- `theme.wxss` 的 `--frost-*` 一节

---

## 8. 开发者工具命令行（wechatide）

这次的编译、截图、真机推送都是通过开发者工具自带的命令行 / MCP 做的，详细说明见 `docs/LOCAL-UBUNTU.md`「开发者工具命令行 / MCP」一节。要点：

- 本机 Linux 移植版的端口文件路径不一致，已用软链修复：`~/.config/wechat-devtools/10e785db0c2d6956ab211bd1cb2591cd/Default → ../app/Default`。删掉软链即可撤销；升级工具后若又报连接失败，按文档重建。
- 命令行要在沙箱外执行。首次连接需在工具里点允许。

常用命令：

```sh
W=~/.local/opt/wechat-devtools/current/bin/wechatide; P=/home/smxvjv/Desktop/weixinapp
$W -c ClaudeCode simulator_open_page --project $P --page packages/demo/home/index
$W -c ClaudeCode simulator_screenshot --project $P --path /tmp/shot.png --wait 3
$W -c ClaudeCode get_simulator_console --project $P --command 'grep -i error'
$W -c ClaudeCode auto_preview --project $P --page-path packages/demo/home/index   # 推送真机预览
$W -c ClaudeCode create_preview_qrcode --project $P --page-path packages/demo/home/index  # 弹窗显示预览二维码
```

切换模拟身份可在运行时设置 storage `xm_mock_role`（如 `boss`、`sales`）后重新打开页面。测完记得删除该 key，恢复默认的顾客身份。

更换 AppID 后，开发者工具会按默认编译条件打开首页，演示分包仍在，重新选编译条件或从「我的」进入即可。

---

## 9. 已知限制与风险

1. **`backdrop-filter` 兼容性。** 老版本安卓微信不支持，毛玻璃会退化成半透明白色。层次靠投影和内描边仍能成立，但会弱一档。正式采用前必须真机确认，必要时给安卓提高 `--frost-glass-flat` 的不透明度作为降级。
2. **性能。** 每页同时有一个大面积 `filter: blur` 光晕和 2–4 个 `backdrop-filter` 层。低端机滚动可能掉帧，真机测试时留意。若掉帧，优先把光晕换成一张预先模糊好的小图。
3. **自定义导航栏。** 毛玻璃顶栏要求 `navigationStyle: custom`，系统返回按钮也随之消失。演示页靠底栏切换，所以不需要返回按钮。正式页面如果是二级页，需要在 `frost-nav` 里补返回按钮。
4. **数据量。** mock 只有几台设备，商品列表、分组都较短。真实数据量下的长列表、空状态、加载态还没设计。
5. **字体。** 依赖系统字体。数字用了 `font-variant-numeric: tabular-nums`，部分安卓字体可能不支持，会退回比例数字。
6. **图标约定冲突**，见 5.6。

---

## 10. 本次改动文件清单

| 文件 | 改动 |
|---|---|
| `design-demos/01-retail-tool`、`02-candy`、`03-enamel` | 补三层层次，重出 `preview.png` |
| `design-demos/07-frost/` | 新增方案 G 静态稿 |
| `design-demos/index.html`、`README.md`、`compare.png` | 加入 G，补 2.4 / 2.5 节 |
| `miniprogram/styles/theme.wxss` | 追加 `--frost-*` 令牌 |
| `miniprogram/constants/routes.js` | 追加 `DEMO_*` 四个路由 |
| `miniprogram/app.json` | 新增 demo 分包 |
| `miniprogram/pages/mine/index.wxml`、`index.js` | 开发调试区加入口 |
| `miniprogram/packages/demo/` | 新增演示分包 |
| `docs/LOCAL-UBUNTU.md` | 补 wechatide 命令行说明 |
| `docs/方案G视觉演示交接文档.md` | 本文档 |

注意 `design-demos/` 目前整体未提交，A / D / F 补层次之前的旧版只在当时会话的临时目录里有备份，不在版本库中，可视为已不可恢复。
