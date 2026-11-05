# 方案 G「雾白层叠」全站 UI 重写 · 交接文档

2026-11-05。本文档记录把方案 G 从「演示分包」推广到全站 57 个页面的完整改造：设计理念、具体做法、改了哪些文件、怎么验证、还有什么没做。

相关文档：演示分包时代的原始说明见 `docs/方案G视觉演示交接文档.md`（那份讲的是 demo 怎么做的，这份讲全站怎么落地的）。

---

## 1. 一句话结论

**全站 57 个页面已在不改一行 WXML 的前提下换成方案 G 的视觉体系**：令牌层 + 通用类 + 共享组件三层全部重写，页面级样式只做零星清理。`node --test` 31/31 通过，模拟器逐页扫描无新增报错。

之所以能做到「不动页面」，是因为这个项目的视觉本来就高度集中在三层里——66 个页面 wxss 合计只有 438 行，组件 wxss 75 行，真正决定长相的是 `theme.wxss` 的 20 个令牌和 `app.wxss` 的通用类。

---

## 2. 设计理念回顾

### 2.1 要解决什么

上一版（苹果式简约：浅灰底 + 白卡片 + 近黑主色）的通病是**所有东西都在一个平面上**：页面底接近白色，卡片也是白色，分组标题直接压在底上，只能靠 1px 描边区分。信息一多就糊成一片。

### 2.2 G 的解法：用物理感分层，不用颜色

| 层 | 令牌 | 做法 | 用在哪 |
|---|---|---|---|
| L0 页面底 | `--c-bg` `#F2F3F5` | 冷浅灰，不是白 | 整页 |
| L0.5 光晕 | `--c-aura-1/2/3` | 三个径向渐变 + `blur(34px)` + 遮罩渐隐 | `.container::before` |
| L1 白卡 | `--c-surface` + `--e1` | 纯白，浅投影，圆角 44rpx | 普通分组、列表、提示条 |
| L2 毛玻璃 | `--c-glass` + `--e3` | 半透明白 + `backdrop-filter` + 1rpx 内高光 | 每页唯一的主块、顶栏、底栏 |
| 卡内凹槽 | `--c-well` | 比白卡低一级的灰 + 内阴影 | 图标底、数据格、标签 |

三条铁律：

1. **每页只有一个 `.glass` 主块**，其余一律 `.card`。重的块多了等于没有重点。
2. **颜色极度克制**。只有墨色 `#111215`（主操作/选中）和红色 `#E5484D`（金额/预警）有含义，绿色只用于毛利为正。其余全是灰阶。
3. **光晕只为玻璃服务**。那团淡蓝/桃色/紫色本身不传达信息，作用是给毛玻璃提供可虚化的素材——纯白底上做玻璃等于没做。

---

## 3. 这次到底改了什么

### 3.1 令牌层 `styles/theme.wxss`

全部重写。要点：

- `--c-*` 保持原名（页面里 49 处引用，不能改），只换值。
- 新增 `--e1/--e2/--e3` 三级投影、`--c-glass*` 毛玻璃组、`--c-well` 凹槽、`--radius-xl`。
- **`--frost-*` 全部改成指向 `--c-*` 的别名**，不再另设真值。演示分包照样能跑，但只有一套真实配置，避免两套值漂移。
- 加了 `@supports not (backdrop-filter)` 降级：老安卓自动退化成 95% 不透明的白卡，层次靠投影和内高光边仍然成立。

### 3.2 通用类 `app.wxss`

全部重写。新增/改动的关键类：

| 类 | 作用 |
|---|---|
| `.container` | 页面根容器，**同时挂载顶部光晕**（`::before`），一次覆盖全站 47 个页面 |
| `.glass` | L2 毛玻璃，每页主块专用 |
| `.card` | L1 白卡，投影换成 `--e1` |
| `.well` | 卡内凹槽 |
| `.notice` | 白卡 + 左侧 6rpx 红线（不整块变红） |
| `.aura-host` / `.group` / `.tiles` / `.tile` | 供需要更细控制时使用 |
| `.chip` / `.btn-*` / `.input` | 全部换成凹槽底 / 墨色实心 / 无边框 |

`.gold` 这个历史类名保留但语义改成「墨色强调」，不再输出金色。

### 3.3 共享组件（10 个 + 底栏）

| 组件 | 改动 |
|---|---|
| `brand-header` | logo 墨色实心 + 投影，字距收紧 |
| `section-card` | **`dark` 属性语义从「深色卡」改为「本页主块 → 毛玻璃」** |
| `price-tag` | 字重 800、红色，`lg` 字距 -1.6rpx；`.none` 降级成小灰字 |
| `status-pill` | 默认变凹槽（次要信息），只有需要你注意的状态才给颜色 |
| `metric-item` | 数字 44rpx/800；`dark` 改为「在主块里」，用墨色 |
| `product-card` | 白卡 + 投影，商品图放凹槽里 |
| `empty-state` | 凹槽圆盘托图形，不再用 Unicode 符号 |
| `template-fields` | 选项改胶囊凹槽，选中变墨色实心 |
| `todo-block` | 虚线凹槽，不抢真实内容 |
| `staff-tabbar` | **改成悬浮毛玻璃胶囊**，自带 `.ph` 占位 |
| `custom-tab-bar` | 顾客端原生机制，只能全宽毛玻璃，不能悬浮 |

这里有个省事的关键：`dark` 属性在 5 个页面里被大量使用（`<section-card dark="{{true}}">`），我没有改这些 WXML，而是**重新定义了 `dark` 的语义**——从「深色」变成「主块/毛玻璃」。一行 WXML 都不用动，深色块就全消失了。

### 3.4 图标全站替换

- 旧：84 个**线性** SVG（深色 / `-gray` / `-white` 三套），单线描边，48px 下几乎看不出内容——这是「看起来太素」的根本原因。
- 新：**116 个多彩 SVG**，每个 3～5 种颜色、4～6 个结构层次（主体 + 高光 + 配件 + 阴影面）。
- 直接覆盖 `assets/icons/` 同名文件，**17 处硬编码引用 + 动态拼接引用全部自动生效**，不用改任何 WXML。
- 保留 `-gray` / `-white` 变体以兼容现有动态引用（`{{active ? '' : '-gray'}}`），由脚本从彩色版自动派生：`-gray` 是灰阶化，`-white` 按明度映射不透明度。
- 主包仍 1.2MB，远低于 2MB 上限。

### 3.5 顺手修的两个既有 bug

扫描 57 页时发现 `repair/detail` 和 `loans/detail` 在缺少 `id` 参数时崩溃（`Cannot read properties of null (reading 'status'/'photos')`）。根因是 mock 对空 id 返回 `{code:0, data:null}` 而不是 404，页面直接解引用。加了 null 守卫，现在显示「维修单不存在或已被删除」。

顺带修了演示分包 `.frost` 的 `overflow: hidden`——它把超屏内容裁掉且让页面无法滚动（详见 `docs/方案G视觉演示交接文档.md` 未提及，是这次发现的）。

---

## 4. 怎么验证的

| 项 | 结果 |
|---|---|
| `node --test tests/*.test.js` | **31/31 通过** |
| 57 页文件完整性 | 0 缺失 |
| 图标引用完整性 | 需要 44 个，0 缺失 |
| 模拟器逐页扫描（老板身份） | 57 页无新增报错 |
| 13 个「问题」页 | 11 个是详情页缺 `id` 的正常守卫，2 个是已修的既有 bug |
| 主包体积 | 1.2MB（上限 2MB） |

截图证据：员工端 6 页（工作台/库存/收银/报表/员工管理/我的）、顾客端 5 页（首页/分类/搜索/详情/我的）均已确认层次正确、无深色残留、无布局塌陷。

---

## 5. 已知限制

1. **毛玻璃真机表现未验证。** 模拟器上 `backdrop-filter` 正常，老安卓 WebView 会降级成高不透明白卡。降级方案已写进 `@supports`，但必须在真机确认。
2. **性能未测。** 每页一个大面积 `filter: blur` 光晕 + 2～4 个 `backdrop-filter` 层，低端机滚动可能掉帧。若掉帧，优先把光晕换成预模糊小图。
3. **逐页「层次分配」只做了通用部分。** 现在每页继承的是统一的 `container` 光晕 + 组件级层次，但方案 G 理想的「每页明确指定唯一主块」只落实到了用了 `dark` 属性的页面。其余页面还是「白卡堆叠」，只是底色和圆角变了。
4. **`--c-gold` / `.gold` 是历史包袱。** 名字还叫 gold，实际输出墨色。彻底清理需要改 4 处 WXML，风险大于收益，暂时保留。
5. **自定义导航栏没做。** 演示分包用了 `navigationStyle: custom` 的毛玻璃顶栏，全站推广需要给每个二级页补返回按钮，这次没动系统导航栏。

---

## 6. 如果要继续深化

按性价比排序：

1. **真机验证毛玻璃**（最重要，决定这条路能不能走）。重点看安卓老机型和低版本微信。
2. **逐页指定主块**。拿几个高频页（库存、收银、工作台）把「一个 `.glass` + 其余 `.card`」显式写进 WXML，而不是只靠 `dark` 属性。
3. **页面级深色残留复查**。这次用 `grep` 清了 `var(--c-navy)` 和硬编码色，但可能有通过其他写法实现的深色块，需要逐页肉眼过。
4. **系统导航栏换成毛玻璃**。需要 `navigationStyle: custom` + 自绘返回按钮，工作量大，建议最后做。

---

## 7. 改动文件清单

```
miniprogram/styles/theme.wxss          全部重写（令牌 + 降级）
miniprogram/app.wxss                   全部重写（通用类 + 光晕）
miniprogram/components/brand-header/   改样式
miniprogram/components/section-card/   dark 语义改为毛玻璃
miniprogram/components/price-tag/      改样式
miniprogram/components/status-pill/    默认降级为凹槽
miniprogram/components/metric-item/    dark 语义改为墨色
miniprogram/components/product-card/   改样式
miniprogram/components/empty-state/    改样式
miniprogram/components/template-fields/ 改样式
miniprogram/components/todo-block/     改样式
miniprogram/components/staff-tabbar/   wxml + wxss，改悬浮胶囊 + 占位
miniprogram/custom-tab-bar/index.wxss  改毛玻璃
miniprogram/assets/icons/*.svg         84 个线性 → 116 个多彩（同名覆盖）
miniprogram/packages/demo/styles/frost.wxss  修 overflow 滚动 bug
miniprogram/packages/staff/repair/detail.js  加 null 守卫
miniprogram/packages/staff/loans/detail.js   加 null 守卫
miniprogram/packages/staff/dashboard/index.wxss  修 eye 图标
miniprogram/packages/staff/inventory/list.wxss   深色汇总卡 → 毛玻璃
miniprogram/packages/staff/pos/index.wxss        深色扫码头 → 凹槽虚线框
miniprogram/packages/agent/center/index.wxss     深色卡 → 毛玻璃
miniprogram/packages/agent/invite/index.wxss     文字色
miniprogram/pages/agent-landing/index.wxss       深色 hero → 毛玻璃
miniprogram/packages/staff/templates/*.wxss      遮罩色
miniprogram/packages/staff/inventory/detail.wxss 遮罩色
5 处选中框硬编码 #C7C7CC → 令牌
```

---

## 8. 怎么撤销

改动集中在少数文件，回退很容易：

```bash
# 只看改了什么
git status
git diff miniprogram/styles/theme.wxss miniprogram/app.wxss

# 只回退样式（保留图标和新功能）
git checkout miniprogram/styles/theme.wxss miniprogram/app.wxss miniprogram/components/

# 回了样式后图标仍是多彩的，若也要回退（旧图标备份在 /tmp/old-icons-backup）
cp -r /tmp/old-icons-backup/* miniprogram/assets/icons/
```

注意：`repair/detail.js` 和 `loans/detail.js` 的 null 守卫是**独立的 bug 修复**，与视觉无关，建议保留。
