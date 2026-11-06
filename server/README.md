# 夏目数码 API

真实 Fastify HTTP API + MySQL 持久化。服务端位于 `server/`，与微信上传目录 `miniprogram/` 分开；任何服务端密钥都不进入小程序包。

## 当前已接通

- 微信 `code2Session` 服务端交换、员工短信验证与首次微信绑定、随机令牌会话、退出撤销、实时读取员工权限。
- 微信浏览会话与短信验证后的员工会话分开。绑定过员工的微信在静默登录时也不自动获得员工权限。
- 分类、型号、TAC 核验映射、模板与版本持久化；乐观版本校验、并发发布、事务内审计。
- 文件真实落盘及数据库元信息，识别文件魔数、限制大小和类型。公开照片/视频与内部收货凭证分开；内部文件短时签名且依赖有效员工会话，退出后签名失效。
- MySQL 应用、迁移、只读报表和备份账号隔离；应用账号不能更新/删除审计日志和旧模板版本。
- 供应商、采购明细、运单及人工签收、逐台验收与异常处理持久化；未签收拒绝验收、数量比对、重复提交幂等、失败设备不入可售库存，复验保留原串码和采购成本。
- 单台/批量库存写入、跨 IMEI1/2 唯一约束、整批事务回滚、整备复检、库存查询/改价/分享开关/流水/盘点，以及标签数据接口。改价要求原因与版本，敏感字段按角色裁剪。

采购/验收、库存/复检/盘点、收银/退款/统计及顾客分享已有真实HTTP/MySQL验证；咨询/预约、本人记录、员工跟进与销售归因也已接通。页面控制器与API模块有真实接口集成测试，小程序默认仍为mock，模拟器交互证据与真实数据库证据分开记录。CSV导出支持固定快照和鉴权下载，本机保存已验证，文件分享仍须实机验证。

借还操作页面与代理真实单据、Excel入库、实际蓝牙打印及外部快递接口仍需继续；小程序码/Canvas成图与正式微信身份走查仍待外部配置。未实现接口不回退mock或假成功，未配置外部服务明确503。

## 本机运行

本机（Ubuntu Kylin 22.04）实际环境：Node.js 22.23.4（`~/.local/opt/nodejs/`），MySQL 8.4.13 跑在官方 Docker 镜像里，容器名 `xiamu-wechat-mysql`，监听 `127.0.0.1:3307`。服务代码要求 Node.js 22+。

**本机请用项目根的 `scripts/local-dev.sh`，不要用下面这套手工命令：**

```sh
./scripts/local-dev.sh start    # 启动 Docker MySQL + systemd API，并等健康检查
./scripts/local-dev.sh restart  # 改服务端代码后重启 API
./scripts/local-dev.sh status / logs / stop
```

`server/src` 没有热重载，改完必须 restart。健康检查：`curl http://127.0.0.1:3000/api/v1/health`，正常返回 `{"code":0,"data":{"status":"ready"},"message":"ok"}`。

下面这套是**其它环境（macOS、未配置 systemd 的新机器）**的启动方式，本机执行会与 systemd 实例抢 3000 端口：

```sh
# 仅当项目专属 MySQL 尚未运行时启动；持续以前台进程运行
npm --prefix server run db:start

# 另一终端：应用迁移，然后运行 API
npm --prefix server run migrate
npm --prefix server run db:grants
npm --prefix server start
```

本机原脚本 `db:start` 依赖 macOS Homebrew，在 Ubuntu 上不可用；数据库启动入口是 `local-dev.sh` 管理的容器。

首次在新机器建立本机环境：先 `npm --prefix server ci`，运行 `db:start`，再在另一终端运行 `node server/scripts/local-database.js`。初始化器只处理本项目专属 socket，拒绝覆盖已存在的 `server/.env`；不会重置其他数据库密码。

`db:grants` 仅在项目专属本机实例读取本地管理凭据，按当前表结构为运行/报表/备份账号补充权限；它不是 API 的一部分。正式部署应由数据库管理员通过独立迁移流程应用等价的最小权限，不把本机引导凭据交给 API。

本机 MySQL 数据目录 `.local/mysql/`、上传目录 `.local/files/` 属于持久数据，重启 API 不会清空。不要将这些目录当构建缓存删除。

## 配置与员工引导

- `server/.env`：API 使用的运行账号、文件路径、签名密钥、微信和短信配置。权限 0600，不提交版本库。
- `server/.env.migration`：只有迁移 CLI 加载的高权限账号；API 启动不会加载。
- `.local/mysql-accounts.json`：本机引导产生的管理/备份/只读凭据，目录权限 0700、文件 0600；不部署到应用服务账户可读取的位置。
- `.env.example` 和 `.env.migration.example` 是无密钥模板。

真实微信登录须配置 `WX_APP_ID`、`WX_APP_SECRET`。短信当前实现腾讯云 SMS；须配置腾讯云凭据、应用 ID、签名和模板 ID，验证码模板参数依次为验证码与有效分钟数（5），具体应匹配已审核模板。缺少配置时返回 503，不伪造 openid 或发送结果。

一次性引导老板手机号：在安全终端通过环境变量设置 `BOOTSTRAP_BOSS_PHONE`（可选 `BOOTSTRAP_BOSS_NAME`），执行 `npm --prefix server run bootstrap`。不产生默认密码；首次登录仍需真实短信和微信验证。已有有效老板时拒绝重复引导。

本地小程序仍默认 mock，因为完整业务 API 尚未完成。后续整条业务联通且配置就绪后，再修改 `miniprogram/config/index.js` 的开发环境 `useMock` 和 `baseUrl` 进行真实联调。当前不要整体切换后宣称所有页面已完成。

## 验证

```sh
# 一次性准备专用验证数据库；不清空正式数据库
npm --prefix server run test:db

# 后端集成测试（本机显式命令；macOS 上 `npm --prefix server test` 等价）
cd server && node --env-file=.env --test --test-concurrency=2 test/*.test.js

# 小程序和 mock 回归
cd .. && node --test tests/*.test.js
npm --prefix server audit
```

2026-11-04 本机复跑：后端 **67/67**、小程序/mock **25/25**，均无失败。

服务端集成测试使用专属 `xiamu_verification`，通过真实本机 HTTP、真实 MySQL、真实磁盘文件验证。只有微信/SMS 外部调用使用测试替身，因此不代表外部账号已经联调成功。测试不接受生产库名称，也不自动 DROP；验证数据保留供复查。

测试包括 OTP 错误次数持久化/一次性消费、角色伪造无效、静默登录不提权、并发发布只允许一次、重启保留数据和会话、审计及版本表 UPDATE 被数据库拒绝、伪造图片被拒绝、内部文件签名及退出撤销。

采购库存测试另覆盖跨串码唯一、并发写入与改价、批量失败回滚、整备不可售、盘点、未签收拒绝验收、数量比对、异常串码占用与复验计数，以及库管可验收但不能读取供应商/成本。本机测试中微信/SMS 外部调用使用替身，身份夹具仅写入专用验证库；没有添加生产环境免验证登录接口。

页面集成测试加载实际供应商、采购、型号选择器和验收控制器及 API 模块，连接专用验证库的真实 HTTP 服务；平台弹窗/页栈用夹具提供。验证了供应商编辑、多行采购、搜索汇总、签收、型号回传、数量提示、上传中禁止保存、提交成功但响应丢失后的幂等重试，以及异常复验。它不替代真实微信登录、真机摄像头和整个小程序切换真实环境后的走查。

## 部署注意

部署时使用独立应用系统用户，只给应用运行配置及上传目录访问权。MySQL 置于私网或 loopback，不开放公网；迁移凭据只在迁移步骤临时提供。公网 API 通过 HTTPS 反向代理并配置微信合法域名。正式服务器、域名、微信及短信凭据尚未配置，也未执行上线发布。

备份需同时覆盖数据库和上传目录。`erp_backup` 只有表级 SELECT，可用于逻辑导出；实际备份作业、保留周期与恢复演练将在部署阶段落实，尚未标为完成。

## 销售与退款接口（页面适配进行中）

- POST /sales/quote：items中提交unitId、priceVersion、channel和可选price；服务端返回金额合计。
- POST /sales-orders：同样的items，加requestKey、payMethod、paymentConfirmed=true；改成交价须有改价权限并填写priceReason。实际收款仅为员工记账确认，目前没有对接支付平台扣款。
- GET /sales-orders、GET /sales-orders/:id：不可改的成交快照，敏感成本/毛利按角色裁剪；列表支持状态、销售员、日期及关键词。
- POST /sales-orders/:id/refund：requestKey、kind(return或adjustment)、items[{itemId,amount?}]和reason。退货默认退剩余金额，也可明确填写；已退金额累计不能超过成交价。退货冲回成本并进入复检，金额调整保留已售状态。没有执行外部支付退款，只记录已办理的退款业务。
- GET /stats/overview、/stats/breakdown、/stats/trend：北京时间范围内的销售/退款事件；净收入和净成本分别汇总，利润字段仅授权返回。动销率按起日0点可售库存计算，无分母时返回null。UV/PV、维修、代理提成未纳入这些销售接口，仍须继续。

迁移006创建不可改销售/退款快照表，007创建独立协调锁表，避免给快照表更新权限。运行账号不能改历史销售/退款；退款串行锁与设备锁保证累计金额与库存状态一致。

## 访问统计与工作台

迁移008增加只追加visit_events，运行账号不能修改历史事件。POST /visits/batch接收visitorId与带eventId的事件；匿名标识采用服务端HMAC摘要，不保存额外传入信息，服务器接收时间为统计时间。重复visitor/eventId忽略；员工经营路径、未知页面和未知事件不计入。前端失败重试保留原eventId。

GET /stats/visits和/stats/visit-trend返回UV/PV与咨询点击。consults为真实提交咨询/预约的账号去重人数（取消仍保留原提交统计），consultRequests为条数、appointments为预约条数；consultBySource为对应提交来源；客户端声称的来源不作为已核验渠道，有效且获授权的分享归入对应渠道，伪造/失效/无权分享计unverified；具体见下方分享说明。GET /stats/ageing返回授权可见的当前可售库龄列表。GET /staff/dashboard查询真实销售/退款、库存状态、采购剩余、验收/复检和库龄待办；维修待办已按当前权限接真实单据；借还/代理待办仍待页面整合，不伪造数量。

统计页支持每日销售净额/毛利/UV条形趋势、型号/员工/门店维度与分页库龄预警；数据为空展示真实0。小程序仍默认mock，mock从本次内存成交/访问事件累计，不使用固定经营数字；重编译会清空内存，不能视为真实持久化验证。

## 授权CSV报表导出

迁移009增加只追加report_exports。POST /stats/export接收requestKey、range或from/to、reason；需导出和统计/工作台权限，生成销售/退款逐台快照并在同一事务写审计。重复内容标识返回同一记录，冲突返回409。超过10000行明确要求缩小日期范围。

GET /stats/exports/:id只允许创建人在有效期15分钟内读取。每次读取重新核验当前权限；成本/毛利列同时满足创建时和当前授权才返回。返回文件名及带BOM的CSV内容，前端写入小程序私有reports目录，再由用户选择文件接收人；没有将令牌放到链接，也没有公开导出文件。单元格文本有CSV引号和公式起始符处理。

模拟器已实际生成并写入CSV，经文件API读回确认BOM和中文表头；模拟器文件分享调用失败，尚未证明真机文件分享成功。服务端快照/权限/幂等用真实MySQL与HTTP验证，不能把mock文件当成这些服务已联调。已保存到设备的文件不能通过后续权限变更撤回；每次重新下载仍要鉴权。

## 顾客商品与分享

迁移010保存share_links及只追加share_items（单机价格/版本快照），011为只追加访问事件补充核验后的share_id、share_owner_id。GET /shop/home、/shop/units、/shop/units/:id只返回在售且对应展示开关开启的商品。公开视图单独构造字段白名单，模板顾客/同行可见性生效，内部凭证/成本/货源/完整IMEI不返回；质保未填写时为null，不自动承诺天数。

POST /share/links接收unitId或1～50个unitIds、channel(customer/peer)。登录顾客可分享公开现货，员工还需分享权限；同行分享的创建及读取要求同行或有同行价格与分享权限的员工。代理定价规则尚未配置时明确503，不做固定加价。返回路径只含s，价格由服务端快照决定。SHARE_HOURS可配置1～720小时，当前开发默认72小时，后续业务规则仍需确认。

GET /shop/shares/:id、/share/links/:id/copywriting、/share/links/:id/poster每次核验有效期、授权、设备状态、共享开关和价格版本。改价/售出/下架等使原分享失效；分享创建者可PATCH /share/links/:id/revoke，必须填写reason并写审计。合集中的任一设备失效时整条合集失效，需重新分享。

POST /visits/batch仅把核验有效且查看者获授权的分享计入customer/peer来源，并记录分享人；伪造、过期或无权的标识记unverified。前端队列按事件发生时的来源分组上报，重试保留原eventId，不把后来打开的分享来源套到旧事件。

小程序码提供方通过stable_token与getwxacodeunlimit调用微信，scene仅s=<shareId>，AppSecret/access_token仅留服务端。配置WX_APP_ID、WX_APP_SECRET、WX_CODE_ENV(develop/trial/release)、WX_CODE_CHECK_PATH；生产应明确使用release/true并确认页面已发布。凭据缓存、并发合并、失效重取与图片响应检查已有本机HTTP边界夹具验证，尚未使用正式微信服务联调。缺配置时poster接口返回qrcode:null和unconfigured，页面禁用可扫码海报保存，可用卡片分享。Canvas绘制及相册拒绝处理代码已补；实际成图/保存、真机扫码和转发仍待外部配置后验证，不能算完成证据。


## 咨询、到店预约与成交归因

迁移012新增只追加customer_requests原提交快照、customer_request_events跟进事件和sales_attributions成交归因；customer_request_states保存可更新状态/版本。新增consult:manage默认给老板/店长/销售，不覆盖其他既有权限。顾客的电话为手动填写，不代表短信验证过；仅本人和获授权员工可读取，不进入匿名访问事件、公开商品或聚合报表。

POST /shop/consults与/shop/appointments需登录、requestKey，内容/电话/称呼及可选unitId；预约还需date、timeSlot。GET /shop/contact-options给北京时间可选范围和时段；APPOINTMENT_DAYS默认30（1～90）、APPOINTMENT_SLOTS为JSON字符串数组。默认宽泛时段均标“门店确认”，不是可保证营业/库存的预约容量；具体门店规则仍待确认。提交检查商品可售范围和真实分享来源，价格/描述快照由服务端取，不接受客户端报价。不锁价、不锁库存。

GET /shop/requests、/shop/requests/:id仅本人；PATCH /shop/requests/:id/cancel需requestKey、version、reason。员工GET /customer-requests、/:id及PATCH /customer-requests/:id/status另需consult:manage员工权限。咨询new→contacted/closed/cancelled，contacted→closed/cancelled；预约new→confirmed/cancelled，confirmed→completed/cancelled。终态不恢复，版本冲突409；跟进原因仅供内部，顾客时间线裁掉员工备注。

创建和状态处理都支持未知响应后原样重试。原提交/事件不可改，状态串行锁与版本防止重复处理。旧请求即使原链接后续过期/撤销，完全相同标识和内容仍返回已受理记录；新提交仍必须核验有效分享。前端固定表单打开时来源，冻结提交内容和标识；一般门店咨询不沿用陈旧分享来源。

从员工意向详情进入收银，显式提交customerRequestId；服务端要求跟进与收银权限、活动意向、包含原意向设备，使用当前库存/价格报价。销售扣库、归因快照和意向结束在同一事务中，不能从客户端渠道头伪造归因。取消与销售并发时采用锁定的当前状态，不能用旧事务快照覆盖已提交取消。归因保留原客户和分享人；退款沿原销售单冲回业务，归因快照不删除，不代表代理提成规则已实现。

接口/页面测试覆盖真实落库、重试、本人隔离、内部备注、日期范围、来源/版本、同事务归因、取消与收银竞争及限流429。真实微信客服、getPhoneNumber与订阅通知尚未接入，前端支持手动联系方式和站内记录跟进。


## 维修与配件（本机业务及操作页面）

迁移013/014建立维修单、只追加事件/附件/收支/配件流水/成本归档和外部串码活动占用。本店送修在同一事务把自有可售设备转repairing、关共享；外部送修不建可售库存。外部活动串码不可重复建单或入库，取消/完工后释放活动占用；原单和事件保留。开机密码字段一律拒绝，未保存明文或假装已加密。

新增权限repair:assign（老板/店长默认）、repair:cash（老板/店长/财务默认）、parts:manage（老板/店长/采购默认）；配件入库还需成本可见权，因此店长不能读取/登记成本。工程师只能读取/处理本人获分派工单；改报价另需repair:quote。照片、支付/交接凭证必须internal，不能复用入库凭证，每类最多9张；附件读取按当前工单授权，改分派后原工程师的旧签名也不能继续读取。仅有维修权限的工程师不能上传公开文件。

- POST /repair-orders：requestKey、kind(external/inventory)、fault、engineerId?、expectedAt?、photos?。外部机加model/customer/phone/identifier?；本店机只关联unitId，型号/串码取真实库存。创建支持同内容重试。
- GET /repair-orders/options、/board、/stats、列表和/:id；列表/看板支持工程师、搜索和待配件筛选，工单字段与附件按角色裁剪。看板200条/页可继续加载，不把截断当全量。
- PUT /repair-orders/:id：requestKey/version/reason及诊断/待配件/预计日期/追加照片等；指派/联系方式另需权限。POST /:id/quote、/:id/confirm分别报价和记录已获确认，改报价清除旧确认；零元报价有效。
- POST /:id/transition：只能沿节点图，待确认前须诊断和报价，开工前须当前报价确认；待取机须结果且不再待配件；完工须实际结清外部报价、取机/交接人、内部凭证和明确质保天数（0表示无）。本店维修完工/取消只到recheck，独立复检后才可售，分享不自动打开。
- /repair-parts：配件建档；POST /:id/receive按quantity/unitCost/version/requestKey/reason入库；GET /:id/ledger查流水。POST /repair-orders/:id/parts/issue或/return领退，按真实库存价值分摊到分，部分退料沿原领用剩余成本，最后退料带回余分，不能透支或超退。
- POST /repair-orders/:id/payment：receipt/refund/expense/expense_refund，amount/method/confirmed:true/proof?。需要实际已办理确认；退款另需sales:refund，费用另需成本权限。本店机不登记对客收款，费用与顾客收入分开；退款不超过已收净额。接口只记业务账，不调用支付平台。

所有变更需requestKey/version/reason，维修单串行锁、版本与只追加事件处理未知响应重试。成本累计与领退分摊按整数分核算并限制金额范围。工程师拿不到配件成本/费用/毛利，其他工单的配件流水备注/关联编号也不返回。

REPAIR_INTERNAL_COST_POLICY支持capitalize/separate，开发默认capitalize并保留TODO(confirm)待确认口径：完工/取消时实际净配件及净费用归档一次，capitalize加入本店设备成本，separate保持原库存成本并独立记账；未知策略回滚，不留半条状态或成本。归档后本店费用不可重复调整，后续差异须另行设计调整流程。外部维修统计按收退款、领退料和费用发生期计净收入/配件成本/期间毛利；自有机成本另列，避免重复计入对客维修毛利，不能把它当完整权责发生制总账。

真实HTTP/MySQL已验证节点权限、当前报价确认、附件域隔离/重分派撤权、付款退款、成本分摊/并发/归档、串码占用/释放、同内容重试、重启持久化。开单/工程师选择/看板/库存送修入口、详情报价/确认/节点、配件建档/采购入库/领退、收退款和取机表单已适配；实际页面控制器经真实HTTP/MySQL完成完整外部维修，验证原样重试、版本冲突及成本裁剪。模拟器已实际验证检测、报价、配件采购及横向泳道；相机/相册、实际交接及整套真机走查仍待验证。维修超期/待确认/待配件待办已接工作台，经营统计页按同一日期范围展示维修指标和裁剪后的成本利润。

迁移015将维修费用凭证分为expense；旧工单只要曾有费用，原payment附件保守归为expense。费用附件只允许同时具备维修收支和成本可见权的员工读取；对客收支凭证需维修收支权限，外观/交接仍按当前工单授权。费用照片不能再转为普通附件；同一文件具有多种用途时按费用级别限制，旧签名每次读取复验。未删除历史凭证。

维修单操作先锁工单，再以事务内首次一致性读取查重；配件入库先锁配件，再查原请求。不存在的事件/流水键不加FOR SHARE间隙锁，避免独立工单或独立配件相互死锁；唯一索引和当前版本仍约束重复/冲突。


## 借还（真实后端与mock，页面待适配）

迁移016/017建立只追加借还原单/设备快照/事件/附件、可更新状态和活动设备占用。应用账号不得改原单/快照/流水。出借只允许自有可售库存；同事务转loaned_out、关闭全部共享、生成业务出库流水，不创建销售单或销售收入。多台任一失败整笔回滚。

- GET /loans/options：financialPolicy、supportsPayments:false、borrowedSalesEnabled:false和maxItems:50。financialPolicy固定为none：框架文档十三.3已定首期不收押金、逾期费与损坏赔偿，非零deposit/overdueFee/compensation返回400，不能以预留字段冒充真实收支。
- POST /loans：requestKey、type(loan_out/borrow_in)、counterparty、phone、dueAt、reason、remark?/photos?。出借用unitIds，借入用devices[{modelId,imei1,imei2?,condition?,description?}]，每单1～50台。借入保存borrowed货权和borrowed_in状态，不生成采购成本/销售收入；零成本列为无采购成本的存储占位，设备不可销售/分享。借入授权销售尚未实现，options明确false。
- GET /loans及/:id：按type/status/keyword分页；串码精确搜索，完整串码按当前字段权限裁剪。overdue按北京时间应归还日期动态计算，只有仍有活动设备的active单据会逾期；终态及今天到期不算逾期。
- POST /loans/:id/return：requestKey/version/reason及items[{unitId,condition,damage?,photos}]，逐台外观/功能检查和内部交接凭证必填。支持部分归还；出借归还到recheck且共享关闭，借入归还到returned并释放活动占用。后续相同借入机重新借入沿用设备，原单快照保留。
- POST /loans/:id/recheck：requestKey/version/reason及unitIds。仅核验原归还流水之后的真实库存复检通过流水，再完结对应出借条目；此接口不改库存，不接受pass:true绕过模板复检。库存复检仍独立使用/units/:id/recheck-form和/units/:id/recheck。

LOAN_MANAGE员工才可读写借还和交接照片；非借还员工即使照片原签名有效也须重新授权。借还照片禁止混入入库/维修；跨业务并发若出现共享文件，读取按所有已关联域权限的交集限制，不因照片有两个用途降低费用/借还权限。未开放支付平台操作。

状态先锁可更新的loan_states，再读取只追加原单，避免为锁原单扩大数据库UPDATE权限；稳定标识+摘要+当前版本处理重试。归还使用库存流水自增编号作为复检证据界限，避免同毫秒时间戳把旧复检误认为新复检。
