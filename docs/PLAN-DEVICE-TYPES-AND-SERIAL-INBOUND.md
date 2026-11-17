# 改动规划：首页滑动栏目、设备分类扩充、非手机入库

定稿日期：2026-11-15。本文是给执行代理的任务说明，按工作包拆分，每个工作包可独立提交。动手前先读 `AGENTS.md` 和本文“总则”。

本文不含环境 ID、AppID、密钥。需要这些信息时读本机忽略的 `docs/HANDOFF-*.md` 和 `.local/cloudbase/*.env`，不要把它们写进任何被跟踪文件。

## 执行进展（2026-11-16）

代码部分已在分支 `feat/device-types-serial-inbound` 完成，未提交、未部署。小程序回归 `node --test tests/*.test.js` 112/112 通过；23 个改动的 WXML 在开发者工具里编译通过；首页两页入口、非手机入库界面在模拟器里核对过。

| 工作包 | 状态 | 说明 |
| --- | --- | --- |
| WP1 首页 | 完成 | 16 个入口和图标、`brandKey` 服务端展开、电池筛选随分类隐藏；无实拍图的商品卡用入口配图占位（本规划外的小改进） |
| WP2 分类与清理 | 代码完成 | 迁移 `20261116010000_device_categories.sql`；清理脚本 `scripts/cleanup-verification-data.js` + `scripts/sql/cleanup-verification.sql`；验证脚本加 `scripts/lib/verification-guard.js` |
| WP3 非手机入库 | 完成 | 迁移 `20261116020000_serial_identifiers.sql`；入库、验收、借入、mock 均已支持 |
| WP4 下游 | 完成 | 串码显示统一用 `f.code()`；库存按批次筛选，收银可在同批列表全选出库；导出报表的串码列未改（`api_report_export` 仍只导 IMEI） |
| 云端执行 | 待执行 | 需在目标环境登录后逐项确认 |

本机演练：用 PGlite 依次执行全部 43 个迁移；另导入 11-13 业务快照（3,148 行）后执行两条新迁移，并演练清理：删除 26 个验证分类、26 个型号、104 台设备及关联单据，保留 23 台，没有混合单据，清理后无孤立引用（快照里原有 1 条大小写不一致的访问记录除外）。

已知未做：
- 维修单从库存发起时，非手机设备的“设备标识”仍取 IMEI，为空时留空（`api_repairs` 未重建）。
- 代理端分享页、代理订单只给 `imeiMasked`，非手机设备不显示序列号。
- 收银没有单独的“按型号选件”，改为在库存同批列表里全选或逐件勾选后出库。

## 一、目标

1. 首页品牌区从固定 8 格改成可左右滑动的栏目，共 16 个入口，新增 8 个入口并绘制图标。
2. 清掉云环境里验证脚本留下的测试分类、型号、设备；预置 4 个新分类；顾客端分类页和员工端分类列表随之变干净。
3. 入库分“手机模式”和“非手机模式”。非手机模式推荐填 SN 码，没有 SN 要说明原因；配件可按数量入库；蜂窝版平板可额外填 IMEI。
4. 受影响的下游页面、mock、测试、文档一并修改。

## 二、已定案的取舍（用户 2026-11-15 确认，不要再改）

| 事项 | 定案 |
| --- | --- |
| 测试数据 | 保留“手机”分类及 iPhone 15、Mate 60 两个型号和它们的设备、单据；其余测试数据清掉 |
| 配件 | 可以选择按数量入库 |
| 蜂窝版平板 | 非手机模式下允许额外填 IMEI（选填） |
| SN 唯一性 | 只做“同一型号下 SN 不重复”；跨型号重复不拦截、不提示 |
| 分类口径 | 手机、平板、耳机耳麦、配件、其他设备。框架文档写的笔记本、穿戴设备归入“其他设备” |

## 三、总则

- **分支与工作区**：当前分支 `codex/imei-tac-lookup` 的工作区有 27 个未提交文件（员工微信登录、HTTPS 网关、入库草稿）。这些不是本规划的内容，**不要还原、不要顺手提交**。开工前先请用户把它们提交或确认基线，再从该基线开新分支，建议每个工作包一个分支：`feat/home-swiper-tiles`、`feat/catalog-cleanup-seed`、`feat/serial-inbound`、`feat/serial-downstream`。
- **迁移**：只新增文件 `cloudbase/migrations/<14位版本>_<名称>.sql`，版本号从 `20261116…` 起递增。**不要修改已有迁移文件**。动手前在目标环境执行 `tcb db pg migration list -e <环境ID>` 核对已应用版本。
  - 已知风险：`20261114100000_imei_model_lookup.sql` 在提交 `309b3f7` 里被原地修改过（删掉付费查询）。如果旧版已应用，库里会残留 `imei_paid_lookup_budget` 表和 `api_imei_paid_lookup_reserve` 函数。核对后如有残留，在 WP2 里加一条 `DROP ... IF EXISTS` 迁移。
- **存储过程**：现有函数用 `CREATE OR REPLACE FUNCTION` 整体重建时，先从最新定义所在的迁移里复制全文再改，不要凭记忆重写。各函数最新定义所在文件见第九节。新函数一律 `SECURITY INVOKER`、`REVOKE ALL ... FROM PUBLIC, anon, authenticated`、`GRANT EXECUTE ... TO service_role`。
- **云端操作要先问用户**：执行迁移、部署云函数、清理数据、运行 `scripts/verify-cloud-*.js` 和 `scripts/run-cloud-maintenance.js`，都会改动或消耗正式环境资源，每次执行前向用户确认。代码和本地测试可以直接做。
- **旧后端不改**：`server/`（Fastify + MySQL）只服务旧测试服务器，本规划不动它。
- **安全底线不变**：价格和字段裁剪在服务端；公开页面只出现脱敏串码；小程序里不放密钥；敏感操作走 `confirmSensitive({ needReason: true })`。
- **页面约定**：`createPage`、`<theme-shell>`、`ROUTES` 常量、主题 CSS 变量、`rpx`，详见 `AGENTS.md`。
- **每个工作包的完成条件**：`node --test tests/*.test.js` 全部通过；新增接口有 mock 且 mock 同样裁剪字段；微信开发者工具编译无报错（本机命令行要加占位参数：`wechat-devtools-cli _ open --project <仓库路径>`）。

## 四、工作包与依赖

| 工作包 | 内容 | 依赖 | 是否改库 |
| --- | --- | --- | --- |
| WP1 | 首页滑动栏目 + 8 个新图标 + 品牌/分类筛选参数 | 无（“其他手机”和类型入口的真实数据依赖 WP2 的分类） | 是（1 条迁移） |
| WP2 | 测试数据清理 + 预置分类 + 分类排序 + 分类页 | 无 | 是 |
| WP3 | 非手机入库（串码模式、SN、原因、选填 IMEI、按数量入库） | WP2 | 是 |
| WP4 | 下游页面、公开展示、导出、文档 | WP3 | 少量 |

WP1 和 WP2 可以并行，二者不改同一批文件（都会碰 `miniprogram/mock/catalog.js` 和 `mock/data.js` 时由后合并的一方处理冲突）。

---

## 五、WP1：首页滑动栏目

### 5.1 入口定义

改 `miniprogram/constants/shop-brands.js`，每项加 `type`。顺序即显示顺序，每页 8 个：

| 页 | key | 文案 | type | 匹配 |
| --- | --- | --- | --- | --- |
| 1 | apple | 苹果手机 | brand | apple、苹果、iphone |
| 1 | huawei | 华为手机 | brand | huawei、华为 |
| 1 | xiaomi | 小米手机 | brand | xiaomi、小米 |
| 1 | honor | 荣耀手机 | brand | honor、荣耀 |
| 1 | oppo | OPPO手机 | brand | oppo |
| 1 | vivo | vivo手机 | brand | vivo |
| 1 | samsung | 三星手机 | brand | samsung、三星 |
| 1 | oneplus | 一加手机 | brand | oneplus、一加 |
| 2 | redmi | 红米手机 | brand | redmi、红米（从小米里拆出） |
| 2 | iqoo | iQOO手机 | brand | iqoo（从 vivo 里拆出） |
| 2 | realme | realme手机 | brand | realme、真我 |
| 2 | other-phone | 其他手机 | otherBrand | 手机分类里不属于以上 11 个品牌的 |
| 2 | tablet | 平板 | category | 分类 `tablet` |
| 2 | accessory | 配件 | category | 分类 `accessory` |
| 2 | audio | 耳机耳麦 | category | 分类 `audio` |
| 2 | other-device | 其他设备 | category | 分类 `other` |

分类 ID 与 WP2 的预置分类一致：`phone`（已存在）、`tablet`、`audio`、`accessory`、`other`。

### 5.2 筛选参数（服务端）

现状：`api_shop_units` 只支持 `brand` 精确等于 `models.brand`，而库里的品牌值可能是 `apple` 也可能是“苹果”；首页靠 `/shop/home` 返回的品牌列表反查真实值，一个入口只能命中一个值。

改法：

- 新迁移重建 `api_shop_units`（最新定义在 `20261109080100_shop_media.sql`），新增两个可选参数：
  - `brandNames`：字符串数组。条件为 `lower(m.brand) = ANY(...) OR lower(m.brand_label) = ANY(...)`。
  - `excludeBrandNames`：字符串数组。条件为两列都不在数组里。
  - 原 `brand` 参数保留，搜索页和筛选抽屉还在用。
- `miniprogram/constants/shop-brands.js` 加进 `scripts/sync-cloudfunctions.js` 的 `sources`，让云函数能读同一份品牌别名。
- `cloudfunctions/shop/index.js` 的列表接口新增查询参数 `brandKey`：
  - 值为某个 brand 入口的 key：展开成该入口的 `names` 传 `brandNames`，并强制 `category=phone`。
  - 值为 `other-phone`：把 11 个品牌的全部 `names` 传 `excludeBrandNames`，并强制 `category=phone`。
  - 其他值返回 400“品牌入口无效”。别名列表由服务端展开，不接受客户端传数组。
- `category` 参数已存在，类型入口直接用。
- mock：`miniprogram/mock/shop-share.js` 的 `/shop/units` 同步支持 `brandKey`；确认 `miniprogram/mock/data.js` 的测试设备有分类字段。
- `miniprogram/api/modules/shop.js` 的接口注释补上 `brandKey`。

### 5.3 前端

- `miniprogram/utils/shop-filter.js`
  - `EMPTY_FILTERS` 增加 `brandKey: ''`、`category: ''`。
  - `brandTiles()` 不再依赖 `/shop/home` 的品牌列表，直接由常量生成 `{ key, label, type, image }`，并按 8 个一页分组。
  - `toQuery()` 输出 `brandKey` 或 `category`。
  - `filterCount()` 不把这两项计入抽屉角标。
- `miniprogram/pages/shop/index.{js,wxml,wxss}`
  - 品牌区改为 `<swiper>`，每个 `swiper-item` 是 2 行 × 4 列网格（列宽用 `minmax(0, 1fr)`）；`indicator-dots` 用自绘圆点，颜色取主题变量（原生圆点颜色在三套主题下不好控制）。
  - swiper 高度固定为两行的高度，不要依赖内容撑开。
  - 点击逻辑：同一入口再点一次取消；切换入口时清空 `brand`、`brandKey`、`category`、`modelId`、`modelName`。
  - 选中的入口在第 2 页时，返回首页要停在第 2 页（记录 `current`）。
  - `loadHome()` 里对 `brandTiles(r.brands)` 的调用去掉参数；`/shop/home` 接口本身不动。
- `miniprogram/components/shop-filter/`
  - 型号弹层现在按分类、品牌列型号。当首页已选类型入口或品牌入口时，弹层默认定位到对应分类或品牌。
  - 当前 `category` 不是 `phone` 时隐藏“电池”下拉和抽屉里的电池项，并在切到这类入口时清掉 `batteryMin`。
- 搜索页 `packages/shop/search` 如果复用 `EMPTY_FILTERS`，确认新增字段不影响它（从分类页跳过来仍用 `modelId` 或 `keyword`）。

### 5.4 图标

- 在 `design-demos/brand-icons/build.py` 里新增 8 个函数并登记到 `BRANDS`，输出到 `miniprogram/assets/brands/<key>.png`，key 与 5.1 一致。
- 规格沿用现有 8 张：240×240 透明底 PNG，单张不超过 30KB，原创插画，不含任何品牌商标或文字标识。
- 生成方式沿用脚本现状：SVG 由无头 Chrome 按 4 倍渲染，再用 Pillow 缩小；传给 Chrome 的环境变量里要去掉 `TMPDIR`（路径过长会崩溃），脚本里已有处理。
- 内容：
  - `redmi`、`iqoo`、`realme`：画各家当前旗舰的背面，用脚本里的 `phone()` 机身。**动手前先联网查证 2026 年秋季的实际机型和镜头模组布局**，不要凭印象画；查不到可靠资料时按最近一代已发布机型画，并在提交说明里写明依据。
  - `other-phone`：中性的通用手机背面（简单双摄，灰色），不要像任何具体品牌。
  - `tablet`：平板背面，横向或竖向一枚小摄像头，比例明显宽于手机。
  - `accessory`：充电器加数据线。
  - `audio`：头戴耳机，或耳机盒加耳塞。
  - `other-device`：智能手表加笔记本电脑的组合。
- 配色与现有 8 张拉开，深色、浅色、零售绿三套主题下都要看得清。用脚本的 `--sheet` 生成三主题预览图自查。
- 更新 `miniprogram/constants/shop-brands.js` 顶部注释。
- 体积：16 张合计不超过约 480KB。提交前确认主包仍在 2MB 以内。

### 5.5 测试与验收

- `tests/shop-home.test.js`：16 个入口各有 PNG；红米不再命中小米、iQOO 不再命中 vivo；`toQuery` 对三种入口类型的输出；分页为 2 页 × 8。
- 新增云函数单测（放 `tests/`，参照 `tests/cloud-stock.test.js` 的注入方式）：`brandKey` 展开、`other-phone` 的排除列表、非法 `brandKey` 返回 400。
- 开发者工具里核对：左右滑动顺畅；三套主题下圆点和选中态正常；选中第 2 页入口后下拉刷新不跳回第 1 页；分享进入（`scoped`）时仍隐藏品牌区。

---

## 六、WP2：测试数据清理与分类预置

### 6.1 现状（依据 2026-11-13 导入新环境的本机快照 `.local/cloudbase/migration-source/2026-11-13-*`）

- 27 个分类中 26 个是 `scripts/verify-cloud-*.js` 留下的，标签形如“借还验证36a504f8”“统计86cd7bca”“文件验证…”“退款验证…”“代理…”“维修…”“意向…”“验证…”，每个带 1 个型号。
- 28 个型号中 26 个属于上述分类，型号名形如“验证机型-<uuid>”“=SUM(1,2)_<uuid>”。
- 127 台设备中约 104 台属于这些型号，状态分布在在库、已售、复检、借入、已归还、借出，连着销售、退款、借还、维修、代理订单、意向等单据。
- 要保留的：分类 `phone`（手机），型号 iPhone 15、Mate 60，及其 23 台设备和相关单据。

快照之后环境可能又有变化。**以清理脚本的预览输出为准，不以本节数字为准。**

### 6.2 清理脚本

新增 `scripts/cleanup-verification-data.js`：

- 参数：`--env-id <环境ID>` 必填，且必须与私有配置里的 `CLOUDBASE_ENV_ID`（或 `CLOUDBASE_DATA_ENV_ID`）一致，校验方式照抄 `scripts/deploy-cloudfunctions.js`；`--env-file` 可选；默认只预览，加 `--apply` 才执行。
- 连接方式沿用现有脚本经 PG 网关执行 SQL 的做法（参考 `scripts/lib/cloud-verification.js` 和本机 `.local/cloudbase/import-business.cjs`）。凭据只从本机私有配置读，不打印。
- 保留规则（白名单）：分类 `id = 'phone'`；该分类下名称为 `iPhone 15`、`Mate 60` 的型号；这些型号的全部设备；引用这些设备的全部单据。
- 删除范围：白名单之外的分类、型号、模板及模板版本、TAC 映射、设备，以及**只**引用被删设备的单据链（采购单与明细、运单、验收批次与明细、库存流水、设备文件关联、销售单与明细、退款、收款凭证关联、借还单与明细、维修单及其子表、盘点单、分享链接、代理订单与收益、顾客意向、访问记录等）。
  - 表清单不要照抄上面的列举。脚本应从 `information_schema` 读出所有指向 `units`、`models`、`categories` 的外键，再人工补上用 uuid 或文本关联、没有外键的表（查各迁移里对 `unit_id`、`model_id` 的引用），在预览里逐表列出待删行数。
  - 一张单据同时含保留设备和待删设备时，不删这张单据，在预览里单独列出，交用户决定。
- 不删：`audit_logs`（只追加，表上已撤销 DELETE，保留即可）；员工、角色、会话、顾客账号、代理账号、供应商。其中名字带“验证”的供应商、模拟员工、验证用顾客账号只在预览里列出，标 `TODO(confirm)`，由用户另行决定。
- 云存储里被删设备的图片文件：只在预览里列出文件数和总大小；是否删除对象由用户决定，默认不删（每日维护任务的过期清理逻辑见 `cloudfunctions/cloud-maintenance`，先确认它是否会自动回收无引用文件）。
- 执行：整个删除放在一次事务里（写成一个临时 PG 函数或 `DO` 块，执行后删除该函数）。执行前先触发一次备份（`cloud-maintenance` 的备份动作），并把预览结果存到 `.local/cloudbase/cleanup-preview-<日期>.json`。
- 执行后校验：分类只剩白名单加 6.3 的预置分类；`units` 行数等于保留数；抽查首页、库存列表、统计页能正常打开。

执行顺序：先跑预览 → 把预览发给用户确认 → 用户同意后再 `--apply`。删除不可恢复。

### 6.3 预置分类

新迁移：

- `categories` 加两列：`sort_order int NOT NULL DEFAULT 100`、`identifier_mode text NOT NULL DEFAULT 'imei' CHECK (identifier_mode IN ('imei','serial','serial_imei'))`。
  - `imei`：手机模式。
  - `serial`：非手机模式。
  - `serial_imei`：非手机模式，并允许选填 IMEI（平板）。
- 预置 4 个分类，幂等写入（`ON CONFLICT DO NOTHING`）。标签列有唯一约束，若已有同名分类则复用其 ID 并在迁移说明里写明：

| id | 标签 | sort_order | identifier_mode |
| --- | --- | --- | --- |
| phone | 手机 | 10 | imei |
| tablet | 平板 | 20 | serial_imei |
| audio | 耳机耳麦 | 30 | serial |
| accessory | 配件 | 40 | serial |
| other | 其他设备 | 50 | serial |

- 每个新分类建一套模板（`templates` + `template_versions` 第 1 版，并回填 `categories.template_id`），做法照 `api_stock` 里 `categories.create` 分支。字段从手机模板复制后删减：
  - 平板：保留容量、颜色、成色、电池、版本、保修等；去掉手机专属项。
  - 耳机耳麦：成色、颜色、配件是否齐全、保修。
  - 配件：成色（全新 / 二手）、规格、颜色。
  - 其他设备：成色、规格、颜色、保修。
  - 手机模板的实际字段 key 以库里 `template_versions` 为准，执行前先查出来再定。公开展示用到的 key（`storage`、`color`、`grade`、`battery`、`version`、`shopWarranty`，见 `cloudfunctions/shop/index.js` 的 `publicView`）保持同名。
- 重建相关函数，把 `ORDER BY created_at, id` 改成 `ORDER BY sort_order, created_at, id`，并在返回里带上 `identifierMode`：
  - `api_shop_catalog`（`20261109160000_public_catalog.sql`）。
  - `api_stock` 的 `categories.list` 分支（`20261109040000_stock_routines.sql`）。`api_stock` 很长，只改这一个分支也要整体重建，注意从最新定义复制。
  - `categories.create` 新建的分类默认 `identifier_mode='serial'`、`sort_order=100`；`categories.update` 允许改 `identifierMode`，但**该分类下已有设备时禁止修改**，返回 409。
  - 型号相关返回（`stock_model`、`stock_form`）带上所属分类的 `identifierMode`，入库页靠它切模式。

### 6.4 前端

- 顾客端分类页 `miniprogram/pages/category/`：
  - 左侧按新顺序显示 5 个分类。
  - 当前分类不是手机时，“二手机 / 新机”改为“二手 / 全新”（值不变，仍是 `used` / `new`）。
  - 手机分类下的品牌分组按首页入口顺序排，未列入的品牌排最后。排序在 `cloudfunctions/shop/index.js` 组装目录的地方做，用 5.2 引入的共享常量。
- 员工端 `packages/staff/templates/index`：分类编辑弹层加“串码方式”选择（手机 IMEI / 序列号 / 序列号 + 选填 IMEI），已有设备时置灰并说明原因。
- mock：`miniprogram/mock/data.js` 加 4 个分类和各自模板，`mock/catalog.js` 返回 `identifierMode` 和排序；`mock/test-seed.js` 每个新分类加 1–2 个型号。
- 接口注释：`miniprogram/api/modules/template.js`、`shop.js`。

### 6.5 防止再次污染

- `scripts/lib/cloud-verification.js`（及没走它的 `verify-cloud-*.js`）加保护：目标环境的私有配置里 `NODE_ENV=production` 或存在标记 `XIAMU_ENV_ROLE=production` 时拒绝运行，并提示改用隔离的验证环境。具体用哪个标记，先看 `.local/cloudbase/functions-new-personal.env` 里已有的变量再定，写进 `docs/TESTING-HANDOFF.md`。
- 这些脚本的文件头注释写着“保留数据作为验证证据，不自动删除”，在注释里补一句“只能对验证环境运行”。

### 6.6 测试与验收

- 新增 `tests/catalog-seed.test.js` 或并入 `tests/catalog-inbound.test.js`：mock 目录的顺序、`identifierMode`、非手机分类页文案。
- 清理脚本的表发现逻辑和白名单判断写成纯函数并加单测，不连库。
- 云端验收（需用户同意后执行）：迁移应用成功；分类页显示 5 个分类；模板管理里看不到验证分类；库存列表只剩 iPhone 15、Mate 60 的设备。

---

## 七、WP3：非手机入库

### 7.1 规则

模式由型号所属分类的 `identifier_mode` 决定，选定型号后页面自动切换，员工不手动选模式。

| | 手机模式（imei） | 非手机模式（serial） | 非手机 + 选填 IMEI（serial_imei） |
| --- | --- | --- | --- |
| IMEI1 | 必填，15 位 + Luhn | 不显示 | 选填，校验同手机 |
| IMEI2 | 选填 | 不显示 | 不显示 |
| SN 码 | 不显示 | 推荐填 | 推荐填 |
| 无 SN 原因 | 不显示 | SN 为空时必填 | SN 和 IMEI 都为空时必填 |
| TAC 识别型号 | 有 | 无 | 无 |
| 按数量入库 | 无 | 仅无 SN 时可用 | 无 |

- **SN 规范化**：去首尾空格、转大写；长度 4–40；只允许字母、数字和 `-`；不能是 15 位纯数字且通过 IMEI 校验的串（防止把 IMEI 填进 SN 栏，提示“这是 IMEI，请填到 IMEI 栏”——仅 `serial_imei` 模式有 IMEI 栏，`serial` 模式下直接提示格式不符）。规范化写成 `miniprogram/utils/validate.js` 的 `normalizeSerial` / `isSerial`，云函数通过 `shared/validate` 共用。
- **SN 唯一性**：同一型号下不重复（含验收中占用的）。跨型号重复不拦截、不提示。
- **无 SN 原因**：2–100 字。快捷项：“配件无序列号”“标签磨损无法辨认”“散件无包装”“其他”（选“其他”要手写）。快捷项放 `miniprogram/constants/status.js`。
- **没有任何串码的设备**靠内部设备编号识别。现有设备标签二维码只编码设备 ID（见 `miniprogram/utils/scan.js` 的 `unitCode`），不需要改。

### 7.2 按数量入库

设计选择：**仍然一件一条 `units` 记录**，不引入按数量扣减的 SKU 库存。理由是销售快照、退款冲回、代理锁库、盘点、状态机全部建立在“一条记录一台设备”上，改成数量库存等于重写这些流程。

- 仅在非手机模式、且不填 SN 时可用。页面出现“数量”输入，范围 1–100（与现有批量入库上限一致，也受个人版云函数 3 秒超时约束）。
- 提交后服务端在一个事务里生成 N 条设备记录，共用同一个 `lot_id`、同一套参数、价格、原因和照片。
- 成本填“单件成本”，页面显示合计，合计只作展示。
- `TODO(confirm)`：如果以后要“同款库存 500 根、只记数量”，那是独立的数量库存功能，不在本规划内。

### 7.3 数据库

新迁移（一条或拆成结构、函数两条）：

- `units`
  - `imei1` 改为可空（现为 `char(15) NOT NULL UNIQUE`，唯一约束保留，多个 NULL 不冲突）。
  - 新增 `serial_no varchar(40)`、`no_serial_reason varchar(100)`、`lot_id uuid`。
  - 约束：`imei1`、`serial_no`、`no_serial_reason` 三者至少一个非空；`no_serial_reason` 非空时 `serial_no` 必须为空。
  - 唯一索引：`(model_id, serial_no) WHERE serial_no IS NOT NULL`。
  - 索引：`(lot_id) WHERE lot_id IS NOT NULL`。
- `acceptance_items`（`20261109030100_stock_schema.sql`，现有 `imei1 CHAR(15) NOT NULL`）：`imei1` 可空，加 `serial_no`、`no_serial_reason`，同样的三选一约束；唯一索引 `(model_id, serial_no) WHERE serial_no IS NOT NULL AND <未完结条件>`，未完结条件按该表现有状态列定。
- `unit_identifiers` 不改，仍只登记 IMEI。
- 新增辅助函数：
  - `stock_serial(v text) RETURNS text`：规范化并校验 SN，不合规抛 `P0400`。
  - `stock_identity(d jsonb, mode text) RETURNS jsonb`：按模式校验并返回 `{ imei1, imei2, serialNo, noSerialReason }`，供入库、验收、借入共用。模式与填入内容不符（例如手机分类不填 IMEI、`serial` 分类传了 IMEI）一律 `P0400`。
- 重建以下函数（最新定义位置见第九节），把“IMEI1 必填”改为调用 `stock_identity`，并写入新列：
  - `stock_insert`：单台和批量入库。增加按数量入库：`d.quantity`（1–100）存在时循环插入并共用 `lot_id`；`quantity > 1` 时拒绝带 SN 或 IMEI。
  - `stock_accept`：采购验收。验收项按型号所属分类的模式校验。
  - `api_loans`：借入设备登记（现在 `stock_imei(dev->>'imei1')` 必填）。
  - `api_stock` 里按串码找设备的分支（出库扫码、`units.list` 搜索、盘点扫码）：`id::text = code OR imei1 = code OR imei2 = code` 之外加 `OR serial_no = upper(code)`。SN 不是全局唯一，命中多台时返回 `P0409`“该序列号对应多台设备，请扫设备标签或从库存选择”。
  - `stock_sale`（最新在 `20261109120100_customer_sales_attribution.sql`）和 `agent_shop_unit`（`20261109110100_agent_sales.sql`）里同样的按码查找。
  - `api_repairs` 里取 `unit_v.imei1` 作为维修单设备码的地方（`20261109100000_repairs.sql`）：改为 `coalesce(imei1, serial_no, id::text)`。
  - 返回设备原始数据的函数（`stock_raw`、`stock_inventory`、`loan_raw`、`sales_detail` 等）：加上 `serialNo`、`noSerialReason`、`lotId`、`identifierMode`。
  - `models.identify`（TAC 识别）不变，只在手机模式调用。
- 入库前的唯一性预检接口 `POST /inbound/check-imei` 保留；新增 `POST /inbound/check-serial`（参数 `modelId`、`serialNo`，返回 `{ unique, conflictUnitId? }`），路由加在 `cloudfunctions/staff-stock/index.js`，输入校验加在 `cloudfunctions/common/stock-input.js`。

字段裁剪：完整 SN 和完整 IMEI 同级处理。`miniprogram/constants/roles.js` 的 `SENSITIVE_FIELDS` 里如果 IMEI 有可见角色限制，SN 用同一规则；`cloudfunctions/staff-stock/view.js` 等视图层同步。

### 7.4 入库页面

文件：`miniprogram/packages/staff/inbound/form.js`、`index.wxml`、`index.wxss`、`draft.js`。单台和批量共用 `form.js`，两处都要改。

- `data` 增加 `identifierMode`，在 `selectModel()` 拿到型号表单后设置。未选型号时按手机模式显示（保持现状）。
- 手机模式：界面和逻辑与现在完全一致，包括“扫码识别型号”。
- 非手机模式：
  - 隐藏“扫码识别型号”按钮和 IMEI 输入；标题从“IMEI1 扫码识别”改为“序列号”。
  - 每行显示：SN 输入框（`type="text"`，占位“SN 码（推荐填写）”）+ 扫码按钮；下方开关“没有 SN 码”，打开后出现原因快捷项和手写框，并清空 SN。
  - `serial_imei` 模式多一个“IMEI（选填，蜂窝版填写）”输入框。
  - 扫码用 `utils/scan.js` 的通用 `scan()`，结果过 `normalizeSerial`；在 `scan.js` 里加 `scanSerial()`。
  - 失焦或扫码后调 `check-serial` 做同型号查重；本批其他行有相同 SN 也要提示（现有 `checkRow` 里对 IMEI 的批内查重逻辑照此扩展）。
- 按数量入库：非手机模式、单台页面、打开“没有 SN 码”后出现“数量”输入（默认 1，最大 100）。数量大于 1 时提交按钮文案为“按数量入库（N 件）”，价格区显示“单件成本 × N = 合计”。批量页面不提供数量输入（批量页本身就是逐台录入）。
- 批量页面非手机模式：每行一个 SN；提供“本批都没有 SN”开关，打开后填一次原因套用到所有行。
- 设备类型文案：非手机分类下“二手机 / 新机”显示为“二手 / 全新”。
- 提交前校验（`submitWithChecks`）：按模式检查必填，错误定位到具体行。
- 草稿 `draft.js`：`snapshot()` 的 `rows` 增加 `serialNo`、`noSerial`、`noSerialReason`，顶层增加 `quantity`、`identifierMode`；`restoredValues()` 兼容没有这些字段的旧草稿（按手机模式恢复）；恢复时若型号的分类模式已变，丢弃串码相关字段并提示。存储 key 里的版本 `xm_inbound_draft_v1` 不必升级，前提是兼容逻辑有测试覆盖。
- mock：`miniprogram/mock/inbound.js`、`mock/catalog.js` 实现同样的校验规则、同型号查重和按数量生成。
- 接口注释：`miniprogram/api/modules/inbound.js`。

### 7.5 采购验收与借入

- `packages/staff/acceptance/index`：验收项按型号所属分类切换录入项，规则同 7.1（不提供按数量）。
- `packages/staff/purchase/*`：采购明细按型号下单，不涉及串码，核对即可。
- `packages/staff/loans/edit`：借入设备登记按模式切换。

### 7.6 测试与验收

- `tests/inbound-page.test.js`：三种模式的显示与校验；SN 规范化；批内 SN 重复；“没有 SN”必须填原因；按数量入库的提交参数；旧草稿恢复；模式变化后的草稿恢复。
- `tests/catalog-inbound.test.js` 或新文件：mock 的同型号 SN 重复返回 409，跨型号相同 SN 通过；数量 0、101、带 SN 的数量 2 被拒。
- `tests/format.test.js` / validate 相关：`normalizeSerial`、`isSerial` 的边界。
- 云函数输入校验单测：`stock-input.js` 新增分支。
- 云端验收（需用户同意）：在验证环境对每种模式各入库一次，再各做一次销售和退款，确认状态流转和库存流水正常。

---

## 八、WP4：下游页面、公开展示、导出、文档

### 8.1 统一的串码显示

- `miniprogram/utils/format.js` 加 `unitCodeText(unit)`：有 IMEI 返回 `IMEI <值>`，否则有 SN 返回 `SN <值>`，否则返回 `无序列号`；`filters.wxs` 加对应的 WXML 版本。脱敏版 `maskSerial`：前 2 位 + `****` + 后 3 位。
- 下列页面现在直接显示 `imei1` / `imei2`，逐个改为用上面的函数。无权限时字段为 `undefined`，仍显示“无权限查看”：
  - `packages/staff/inventory/list`、`detail`、`label`、`stocktake-run`、`stocktake-result`
  - `packages/staff/pos/index`
  - `packages/staff/share/index`
  - `packages/staff/loans/detail`、`edit`
  - `packages/staff/repair/detail`、`edit`
  - `packages/staff/purchase/detail`、`packages/staff/acceptance/index`
  - `packages/staff/consults/detail`、`packages/staff/stats/index`
  - `packages/shop/product/index`、`packages/shop/consult/index`、`packages/shop/requests/detail`
- 以 `grep -rl -i imei miniprogram/packages --include=*.wxml` 的结果为准，上面是 2026-11-15 的清单。

### 8.2 公开页面

- 公开接口现在返回 `imeiMasked`（`left(imei1,2)||'****'||right(imei1,4)`，出现在 `api_shop_units`、`agent_shop_unit`、`api_agents` 等）。`imei1` 为空时该值为空。新增 `serialMasked`，规则同 8.1；两者都没有时页面不显示串码行。
- 完整 SN 不进入任何顾客、同行、代理页面，与完整 IMEI 同等对待。把 `serialNo`、`noSerialReason` 加进 `cloudfunctions/shop/index.js` 的 `FORBIDDEN` 集合。

### 8.3 按数量入库的设备在各处的呈现

- **顾客端列表**：同一 `lot_id` 的在售设备只显示一张卡片，带“余 N 件”。在 `api_shop_units` 里对 `lot_id IS NOT NULL` 的行按 `lot_id` 折叠（取最早入库的一件作代表，`total` 按折叠后计）。详情页、咨询、预约、代理下单都指向代表设备；代表设备售出后自动换成下一件。
- **库存列表**：仍逐件显示，同批的显示“同批 N 件”标记；加一个按批次筛选的入口（`units.list` 支持 `lotId`）。
- **收银**：`packages/staff/pos` 加“按型号选件”：选无串码型号 + 数量，前端从 `units.list`（该型号、在库、无串码、按入库时间升序）取前 N 件加入订单。服务端销售逻辑不变，仍逐件校验和锁定。
- **盘点**：无串码设备只能扫设备标签或在清单里手动勾选，`stocktake-run` 页给这类设备提供手动勾选。
- **标签**：`inventory/label` 对无串码设备只显示型号、规格和设备编号二维码。

### 8.4 其他

- **导出与统计**：`api_report_export` / `api_reports` 里的 IMEI 列改名为“串码”，值为 IMEI 或 SN，都没有则留空。CSV 的公式转义逻辑保持。
- **首页筛选**：已在 WP1 处理电池项的隐藏。
- **搜索**：员工端库存搜索支持按 SN 搜（7.3 已含）；顾客端关键词搜索不搜 SN。
- **角色测试数据**：`miniprogram/mock/test-seed.js` 加非手机设备，`docs/role-tests` 的说明同步。

### 8.5 文档

- `AGENTS.md`：目录结构里 `assets/brands` 的说明；“阶段 A”里入库、顾客端两条补上新能力；顺手修正已过时的“测试服务器”短信登录描述是另一件事，本规划不做。
- `docs/test-cases/`：`05-inbound.md`、`06-inventory.md`、`11-shop-share.md`、`03-catalog-template.md` 追加用例，编号往后排，不复用旧编号；`README.md` 的用例数合计同步。
- `docs/WECHAT-CLOUDBASE-MIGRATION.md`：在实施记录里追加本次迁移和清理的结果（不写环境 ID）。
- `miniprogram/constants/shop-brands.js` 注释。
- 框架文档 `夏目数码_小程序与ERP整体框架_V0.3.md` 是需求来源，不要改；与它不一致的分类口径以本文第二节的用户定案为准。

---

## 九、现有函数的最新定义位置

重建函数前从这里复制全文（2026-11-15 核对；动手前再用 `grep -n "FUNCTION <名称>(" cloudbase/migrations/*.sql` 确认没有更新的定义）：

| 函数 | 最新定义所在迁移 |
| --- | --- |
| `api_shop_units` | `20261109080100_shop_media.sql` |
| `api_shop_home` | `20261109010000_core_identity_shop.sql` |
| `api_shop_catalog` | `20261109160000_public_catalog.sql` |
| `api_stock`、`stock_accept`、`stock_raw`、`stock_inventory`、`stock_model`、`stock_form`、`stock_imei` | `20261109040000_stock_routines.sql` |
| `stock_insert` | `20261109050000_stock_identifier_fix.sql` |
| `stock_sale` | `20261109120100_customer_sales_attribution.sql` |
| `agent_shop_unit` | `20261109110100_agent_sales.sql` |
| `api_agents` | `20261109110300_agent_order_joins.sql`（公开标签另见 `20261109110400_agent_public_labels_and_totals.sql`） |
| `api_loans`、`loan_raw` | `20261109090100_loans.sql` |
| `api_repairs` | `20261109100000_repairs.sql` |
| `api_reports` / `api_report_export` | `20261109130000_reports.sql` / `20261109130100_report_exports.sql` |
| `api_imei_model_lookup` | `20261114100000_imei_model_lookup.sql` |

表结构：`categories`、`models`、`units` 在 `20261109010000_core_identity_shop.sql`；`templates`、`template_versions`、`tac_mappings`、`acceptance_items`、`unit_identifiers` 在 `20261109030100_stock_schema.sql`。

## 十、不在本规划内

- 按数量扣减的 SKU 库存（见 7.2）。
- 维修模块的维修配件库存（`parts:manage`）。它和这里拿来销售的“配件”分类是两套东西，不要合并。
- 旧 `server/` 后端的同步修改。
- 蓝牙标签打印对接。
- 首页商品的示例图片或 AI 生成图片。
- 工作区里尚未提交的员工微信登录、HTTPS 网关改动。

## 十一、留给用户确认的事项

执行到对应步骤时向用户提问，不要自行决定：

- `TODO(confirm)`：清理预览里列出的“验证”供应商、模拟员工、验证用顾客和代理账号是否一并删除。
- `TODO(confirm)`：被删设备在云存储里的图片是否删除。
- `TODO(confirm)`：一张单据同时含保留设备和待删设备时如何处理（预期不会出现，出现了再问）。
- `TODO(confirm)`：三个新品牌图标参照的具体机型（查证后把候选机型发给用户过目）。
- 每一次对云环境的迁移、部署、清理执行。
