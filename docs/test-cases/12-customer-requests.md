# 12 咨询、预约、同行意向

涉及接口：`GET /shop/contact-options`、`POST /shop/consults`、`POST /shop/appointments`、`POST /shop/orders`、`GET /shop/requests`、`GET /shop/requests/:id`、`PATCH /shop/requests/:id/cancel`、`GET /customer-requests`、`GET /customer-requests/:id`、`PATCH /customer-requests/:id/status`
涉及页面：`shop/consult`、`shop/requests/index|detail`、`staff/consults/index|detail`

流转：consult/order：new→contacted→closed，new/contacted→cancelled；appointment：new→confirmed→completed，new/confirmed→cancelled。预约不锁库存、不锁价格。

## 12.1 提交

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| REQ-001 | P1 | API | 顾客 | contact-options | 时段列表、minDate=今天、maxDate=今天+30、提示语 |
| REQ-002 | P1 | API | 配置 | 预约时段配置非法（天数 0、91、时段重复、空） | 503「预约时段配置无效」 |
| REQ-003 | P0 | API | 顾客 | 提交咨询（设备、内容、电话、称呼） | status=new；保存设备快照；审计「提交商品咨询」 |
| REQ-004 | P1 | API | 未登录 | 提交 | 401「请先登录」 |
| REQ-005 | P1 | API | 顾客 | 未知字段 | 400「提交参数无效」 |
| REQ-006 | P1 | API | 顾客 | 电话不合法 | 400「请填写11位手机号」 |
| REQ-007 | P1 | API | 顾客 | 咨询内容为空 | 400「咨询内容格式无效」 |
| REQ-008 | P1 | API | 顾客 | 咨询带 date/timeSlot | 400「咨询或下单无需预约日期」 |
| REQ-009 | P0 | API | 顾客 | 预约：有效日期 + 时段 | 成功；设备状态、价格都不变；审计「提交到店预约」 |
| REQ-010 | P1 | API | 顾客 | 日期 2026-02-30 | 400「预约日期无效」 |
| REQ-011 | P1 | API | 顾客 | 昨天、超过 30 天、时段不在列表 | 400「请选择有效的预约日期和时段」 |
| REQ-012 | P1 | API | 顾客 | 设备不存在或已下架 | 404「商品不存在或已下架」 |
| REQ-013 | P0 | API | 顾客 | 同 requestKey 同内容双提交 | 只一条 |
| REQ-014 | P0 | API | 顾客 | 同 requestKey 不同内容 | 409「提交标识内容冲突」 |
| REQ-015 | P0 | 并发 | 顾客 | 同 requestKey 并发 | 只一条 |
| REQ-016 | P1 | API | 顾客 | 带有效分享提交 | 记录 source、share_id、share_owner_id（服务端核验） |
| REQ-017 | P0 | API | 顾客 | X-Channel 伪造、已撤销 | 按分享校验结果 404/410，不写归因 |
| REQ-018 | P1 | API | 顾客 | X-Channel 超 100 字符 | 400「分享标识无效」 |
| REQ-019 | P2 | API | 同一 IP | 1 分钟第 11 次 | 429 信封，不被错误处理改成 500 |
| REQ-020 | P0 | API | 同行 | 发起购买意向（咨询） | 快照 priceType=wholesale；不扣库存 |
| REQ-021 | P0 | API | 同行 | 调 `/shop/orders`（同行链接） | 400「仅代理分享链接支持下单」（同行不能直接下单） |
| REQ-022 | P0 | API | 同行 | 客户端自报报价或归因 | 被拒或被忽略 |
| REQ-023 | P1 | 页面 | 顾客 | 日期时段选择、未知响应时冻结表单、原来源原请求重试 | 不重复提交 |
| REQ-024 | P1 | 页面 | 顾客 | 咨询页未填必填项 | 前端提示，不发请求 |

## 12.2 顾客本人记录

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| REQ-030 | P0 | API | 顾客 A | 查看 B 的记录 | 404「记录不存在」 |
| REQ-031 | P0 | API | 顾客 A | 取消 B 的记录 | 404 |
| REQ-032 | P1 | API | 顾客 | 列表按 kind、status 筛选 | 只含本人；非法值 400「筛选条件无效」 |
| REQ-033 | P0 | API | 顾客 | 记录响应 | 不含员工内部备注 |
| REQ-034 | P1 | API | 顾客 | 取消：填说明、当前版本 | status=cancelled；审计「取消咨询预约」 |
| REQ-035 | P1 | API | 顾客 | 不填说明 | 400「处理说明格式无效」 |
| REQ-036 | P1 | API | 顾客 | version 非整数 | 400「记录版本无效」 |
| REQ-037 | P1 | API | 顾客 | 旧 version | 409「记录已更新，请刷新后处理」 |
| REQ-038 | P1 | API | 顾客 | 取消已结束的记录 | 409「当前状态不能执行此操作」 |
| REQ-039 | P0 | API | 顾客 | 取消重放；同标识不同内容 | 返回原结果 / 409「操作标识内容冲突」 |
| REQ-040 | P0 | API | 顾客 | 查看含批发价快照的历史记录（已非同行） | 快照裁剪为 id、name、imeiMasked |

## 12.3 员工跟进

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| REQ-050 | P1 | API | 销售 | 列表按 kind、status、keyword（姓名、电话、id） | 正确 |
| REQ-051 | P0 | API | 库管 | 调员工接口 | 403 |
| REQ-052 | P0 | API | 顾客 | 调 `/customer-requests` | 403 |
| REQ-053 | P1 | API | 销售 | 咨询 new→contacted→closed | 成功；时间线记录；审计「跟进咨询预约」 |
| REQ-054 | P1 | API | 销售 | 预约 new→confirmed→completed | 成功 |
| REQ-055 | P1 | API | 销售 | 咨询 →confirmed、预约 →contacted、closed→contacted | 409「当前状态不能执行此操作」 |
| REQ-056 | P0 | API | 销售 | 内部备注后切顾客查看 | 顾客看不到 |
| REQ-057 | P1 | API | 销售 | 旧版本、重放 | 409 / 不重复 |
| REQ-058 | P0 | API | 销售 | canStartSale | 意向进行中、未关联销售、设备在库时才为 true |
| REQ-059 | P1 | API | 销售 | 记录不存在 | 404「记录不存在」 |
| REQ-060 | P1 | 页面 | 销售 | 工作台“待跟进咨询预约”点入 | 带 status=new 筛选 |

## 12.4 意向成交

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| REQ-070 | P0 | API | 销售 | 咨询进入收银，带 customerRequestId 成交 | 咨询 closed；预约 completed；写 sales_attributions，继承核验过的分享归因 |
| REQ-071 | P0 | API | 销售 | 销售单不含意向设备 | 400「销售单需包含意向设备」 |
| REQ-072 | P0 | API | 销售 | 已取消、已结束的意向 | 409「咨询预约已结束或取消」 |
| REQ-073 | P0 | API | 销售 | 同意向再次成交 | 409「此意向已关联成交」 |
| REQ-074 | P1 | API | 销售 | 意向不存在 | 404「咨询预约不存在」 |
| REQ-075 | P0 | 并发 | 销售 + 顾客 | 收银与取消同时 | 旧快照不能覆盖已提交的取消；失败的销售不扣库、不写归因 |
| REQ-076 | P0 | API | 销售 | 意向成交按现价，不按咨询时快照 | 金额为现价 |
| REQ-077 | P0 | API | 无 consult:manage 的开单者 | 带 customerRequestId | 403「无权限执行该操作」 |
| REQ-078 | P1 | 页面 | 销售 | 意向详情→去开单 | 带入设备和顾客 |
