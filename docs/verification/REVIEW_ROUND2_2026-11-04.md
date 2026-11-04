# 本轮新增功能审查 · 2026-11-04

范围：`codex/customer-search` 未提交工作区中的库存借还入口、销售代理来源、代理收益对账、收款凭证，以及搜索两处修复。未重新将上一轮的新机空结果、mock 的 boss 名称或相似推荐作为问题。本轮由主审与三个专项审查代理完成，业务代码未修改，修复留给项目负责人。

## 结论

确认 **5 项问题：2 个 P1、3 个 P2**。完整基线后端 **73/73**、小程序 **31/31** 均通过，以下为基线未覆盖或原断言与新权限要求不一致的路径。

| 编号 | 级别 | 问题 | 主要位置 |
| --- | --- | --- | --- |
| R2-1 | P1 | 双挂销售与维修费用的图片，被销售权限提前放行 | `server/src/repair-files.js:15–22` |
| R2-2 | P1 | 销售仍可经其他接口取得代理加价、代理底价 | `server/src/agents.js:294`、`:307`、`:628–629`、`:910–914` |
| R2-3 | P2 | 不同业务可并发认领同一凭证 | `server/src/sales.js:47–60` 及维修/借还/入库的对应关联校验 |
| R2-4 | P2 | 退款成功回包丢失代理来源、凭证字段，详情显示错误 | `server/src/sales.js:548`、`:637`；`miniprogram/packages/staff/sales/detail.js:48` |
| R2-5 | P2 | 库存详情本页复检后，未完结借还单入口消失 | `server/src/inventory.js:198–214`；`miniprogram/packages/staff/inventory/detail.js:127–129` |

## R2-1 · 销售文件授权提前返回，绕过维修费用授权

新 `canReadInternal` 在发现销售关联后，直接返回是否有开单/退款/统计权限，跳过后面的维修费用成本授权。利用 R2-3 的真实可达状态，同一内部图片同时属于销售单与维修费用时，普通销售账号可以读取费用图片。

- 真实 HTTP/MySQL：销售账号原先读取文件为 403；双挂后文件元信息为 200，签名内容为 200。
- 对照：同一维修单另一张仅费用图片，对销售仍为 403；排除上传者本人例外。
- 库管读取双挂文件仍为 403。问题是销售分支降低了既有维修附件授权。
- 应按文件全部关联业务取权限交集，不能在销售分支提前成功返回。此修正与 R2-3 的认领互斥是两个独立要求。

证据：[review-round2-receipts-race.json](./review-round2-receipts-race.json)。首例用事务调度 barrier 帮助定位，但之后还以完全未插桩的普通并发独立复现了 3 次，结论不依赖调度插桩。

## R2-2 · 新详情裁剪正确，但旧接口仍泄露代理加价与底价

没有 `agent:review` / `agent:settle` 的销售读取新销售详情，确实不返回 `markup/earnings`。但同一身份仍可：

- 调用 `GET /customer-requests/:id`，取得 `agentOrder.markup=200`。
- 调用 `GET /admin/agent-orders?agentId=...`，取得 `markup=200`、`agentBase=1100`。

`orderView` 无条件输出 markup，internal 分支输出 agentBase；`requestView(..., internal=true)` 也直接输出 markup。mock 同样存在。这是原有通路遗留，属于本轮明确要求检查的“其他途径”权限边界，不是指新 `saleSources` 本身直接泄露。现有代理测试甚至期望销售拿到加价，需同步修正授权口径和断言；销售仍可保留必要的开单信息。

证据：[review-round2-agent-checks.json](./review-round2-agent-checks.json)，`permissionBypass`。

## R2-3 · 跨业务认领只有共享锁和普通查询，不能互斥

销售使用 `files FOR SHARE` 后，普通查询 unit_files / repair_files / loan_files 判断是否已使用；维修也持共享锁后检查销售关联。并发下两方都能在对方提交前看到“未关联”，随后分别写入自己的业务表。sales_files 的 UNIQUE(file_id) 只能防同文件跨销售单，不能防跨业务。

真实普通 `Promise.all` 并发销售补传与维修费用登记，**3/3 均为 200 + 200**，数据库同时存在销售和维修 expense 关联。建议各认领入口使用统一文件占用机制或统一顺序取得文件排他锁，并在锁内重新核验所有业务关联。不要只更改销售一处锁而保留其他入口的共享/普通读取。

证据同 R2-1 的 `uninstrumentedTrials`。数据库中的独立业务夹具保留作复查，未删除原数据。

## R2-4 · 退款返回旧 view，页面将完整详情覆盖成缺字段对象

GET 详情与补传凭证返回新增 `detail`，但退款首次成功和幂等重放仍返回旧 `view`。前端 send() 直接替换 detail，因此代理来源消失；真实后端的 receipts 也变为 undefined，凭证区会误显示“未上传收款凭证”。数据仍在库里，重新 GET 可以恢复。

已通过实际销售详情控制器 → 真实 HTTP/MySQL 执行差价退款，记录 agentSources 从 1 条变为缺失、刷新恢复。另用独立销售单真实上传并关联 1 张内部 PNG：登记合法 1 元差价退款后 receipts 缺失，GET 刷新恢复同一 fileId 的 1 张凭证；元信息、签名内容和登录态直接内容均为 200，确认文件及关联数据未丢失。补传/退款操作应返回同一完整详情契约，或页面在成功后重新读取详情；首次与重试两个返回分支都需覆盖。

证据：[review-round2-agent-checks.json](./review-round2-agent-checks.json)，`checks.refundResponseLoss` 与 `checks.receiptLossWithPhoto`。

## R2-5 · 本页复检成功后，借还单仍待完结但入口被清掉

新增 loan 关联仅在 GET /units/:id 中补充。POST recheck 返回普通 stock.view；onSaveRecheck 用回包覆盖 detail，导致依赖 detail.loan 的卡片消失。

真实链路：出借 → 归还 → 设备详情存在借还卡片 → 本页复检通过 → 设备 in_stock，但 detail.loan 缺失、onOpenLoan 无法导航。同期独立 GET 仍返回该 loan，借还单状态仍为 returned_recheck。手动刷新后入口恢复，随后可正常完结。应统一操作回包，或复检成功后重载完整详情，并复核其他同样整体替换 detail 的操作。

证据：[review-round2-loan-recheck-card.json](./review-round2-loan-recheck-card.json)。完整生命周期夹具按正常业务完结并保留。

## 已通过的定向检查

- 库存关联：有借还权限时，出借中 / 归还待复检 / 已复检但未完结均能 GET 关联；销售无 loan 字段且读取借还接口 403；借入设备无新出借入口，unitId 预填正确。只读状态矩阵夹具已回滚，见 [review-round2-loan-entry.json](./review-round2-loan-entry.json)。
- 跨期对账：10 月成交并转账 200，11 月退货；10 月 earned=200、settled=200、net=200，11 月 reversed=200、net=-200；两期 pending 都是当前累计 -200，符合约定。按 agentId 筛选正确，销售读取收益对账接口为 403。日期夹具修改在未提交事务中回滚。
- 搜索：未确认最高价时，翻页和切换其他筛选不携带草稿；确认后唯一匹配设备正确返回。2,001 / 10,000 / 20,000 台候选均未被截断，较早的唯一百元设备可查。批量库存夹具未提交并回滚，确认该型号库存为 0。可重复运行脚本 [review-round2-search.cjs](./review-round2-search.cjs)，输出 [review-round2-search.json](./review-round2-search.json)。
- 补充模拟器黑盒：实际点击在库自有设备“出借给同行”，进入表单并预填正确的 1 台设备；未提交借还单。实际通过原生文件选择器将仓库演示图片用于 mock 收款凭证；空说明提示“请填写操作原因”，填写说明后原模拟销售单显示“1 张”。截图 / AX 文本见 `review-round2-ui-inventory.png`、`review-round2-ui-loan-prefill.{png,txt}`、`review-round2-ui-receipt-added.{png,txt}`。该图片为演示图，不是实际收款证明；仅当前 mock 内存变更。

## 取消搜索上限后的性能观察（不另列阻断问题）

单进程、本机、串行真实 HTTP/MySQL，每个条件 3 次，pageSize=20。样本单行 JSON 约 3.5 KB；不是生产并发容量或峰值内存保证。

| 候选库存 | 无筛选耗时 | 宽价格筛选 priceMin=0 | 电池筛选 batteryMin=0 | 唯一价格匹配 priceMax=100 |
| --- | --- | --- | --- | --- |
| 2,001 | 16～22 ms | 47～54 ms | 56～70 ms | 8～10 ms |
| 10,000 | 69～306 ms | 199～232 ms | 175～214 ms | 27～28 ms |
| 20,000 | 183～378 ms | 394～480 ms | 389～397 ms | 80～82 ms |

2 万台时，宽价格/电池筛选一次请求前后的 heapUsed 增量约 **138～141 MiB**，无筛选约 **1 MiB**，唯一价格匹配约 **0.3 MiB**。这对应当前实现仍将全部候选行取回应用再筛选、分页；每次翻页都会重复做。选择性强的价格 SQL 预筛有效。建议下一步让纯价格查询使用数据库计数与分页，成色/电池也在保证渠道公开字段规则的前提下减少全量数据回传；不应恢复静默截断上限。

## 验证边界与环境

- 已执行 test:db → npm --prefix server test（73/73）及 node --test tests/*.test.js（31/31），没有跳过用例。git diff --check 通过。
- 在确认 PID、工作目录属于本项目后，正常停止原 3000 端口 API 并启动当前代码；健康检查返回 ready。未动 3306，未重置 3307 数据库。
- 真正安全与并发结论来自真实 HTTP / MySQL / 文件读取；页面控制器测试的平台确认框、页栈仍是夹具，不冒充真机。模拟器只覆盖上列实际操作，没有把全部新业务流程、真机照片选择或生产负载算作通过。
- 没有安装新环境、创建临时容器/镜像或可重建构建输出。验证代码、JSON、截图与持久验证夹具保留；没有删除用户数据。AGENTS 未修改，WORKLOG 仅追加审查记录。
