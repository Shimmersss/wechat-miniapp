# 08 收银、销售、退款

涉及接口：`GET /sales/lookup`、`POST /sales/quote`、`POST /sales-orders`、`GET /sales-orders`、`GET /sales-orders/sellers`、`GET /sales-orders/:id`、`POST /sales-orders/:id/receipts`、`POST /sales-orders/:id/refund`
涉及页面：`staff/pos`、`staff/sales/list|detail`

付款方式：微信、支付宝、现金、银行卡、分期。金额统一用服务端核价。

## 8.1 查找与核价

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| POS-001 | P1 | API | 销售 | lookup：设备 id、IMEI1、IMEI2 | 返回设备，字段按销售裁剪 |
| POS-002 | P1 | API | 销售 | lookup 不存在的编码 | 404「未找到设备」 |
| POS-003 | P0 | API | 销售 | lookup 已售、维修、出借、复检、借入设备 | 409「设备不可售」 |
| POS-004 | P0 | API | 销售 | lookup 锁定设备，不带 customerRequestId | 409「设备不可售」 |
| POS-005 | P0 | API | 销售 | lookup 锁定设备，带本单 customerRequestId | 通过 |
| POS-006 | P0 | API | 销售 | quote 零售 2 台 | total 为两台零售价之和；返回 basePrice、priceVersion |
| POS-007 | P0 | API | 有 sales:create、无批发价字段的自定义角色 | channel=wholesale | 403「无权限使用批发价格」 |
| POS-008 | P0 | API | 销售 | channel=wholesale | 按批发价 |
| POS-009 | P1 | API | 销售 | items 空、101 台 | 400「销售需1～100台设备」 |
| POS-010 | P1 | API | 销售 | 同一 unitId 两次 | 400「销售设备重复」 |
| POS-011 | P1 | API | 销售 | channel=xxx | 400「销售渠道无效」 |
| POS-012 | P0 | API | 销售 | priceVersion 过期 | 409「设备价格已变化，请重新核对」 |
| POS-013 | P0 | API | 销售 | 不可售设备 | 409「设备不可售，请刷新库存」 |
| POS-014 | P0 | API | 销售 | 借入设备（ownership=borrowed） | 409（首期不开放借入设备销售） |
| POS-015 | P0 | API | 销售 | 自报 price 不等于基准价且无 price:edit | 403 |
| POS-016 | P0 | API | 工程师 | 调 lookup、quote | 403 |

## 8.2 开单收款

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| SAL-001 | P0 | API | 销售 | 单台零售，paymentConfirmed=true，微信 | 成功；单号 SO+uuid；units→sold；分享全关；ledger in_stock→sold；审计「销售收款出库」 |
| SAL-002 | P0 | 数据 | 销售 | 开单后 | sales_items 快照 name、spec、store、price、cost、price_version、channel |
| SAL-003 | P0 | API | 销售 | 多台一单 | 金额合计正确；每台一条流水 |
| SAL-004 | P0 | API | 销售 | 多台中第 2 台不可售 | 409，整单回滚，第 1 台仍在库 |
| SAL-005 | P0 | 并发 | 两名销售 | 同一台同时开单 | 只成交一单，另一方 409 |
| SAL-006 | P0 | 并发 | 销售 + 库管 | 同一台同时开单和出借 | 只有一方成功 |
| SAL-007 | P0 | API | 销售 | paymentConfirmed≠true | 400「请确认实际收款并选择付款方式」 |
| SAL-008 | P1 | API | 销售 | 付款方式非枚举 | 400（同上） |
| SAL-009 | P0 | API | 销售 | 响应丢失后同 requestKey 同内容重试 | 返回原单，不重复扣库 |
| SAL-010 | P0 | API | 销售 | 同 requestKey 不同内容 | 409「提交标识内容冲突」 |
| SAL-011 | P1 | API | 销售 | requestKey 缺失 | 400「提交标识格式无效」 |
| SAL-012 | P0 | API | 店长 | 改价成交，带原因 | 按改后价成交；原因进流水和审计 |
| SAL-013 | P0 | API | 店长 | 改价不带原因 | 400「成交改价原因格式无效」 |
| SAL-014 | P0 | API | 销售 | 请求 amount 字段伪造 | 被忽略，金额以服务端为准 |
| SAL-015 | P2 | API | 销售 | 顾客名超 100 字、电话超 30 字、备注超 1000 字 | 400 |
| SAL-016 | P0 | 数据 | 老板 | 成交后改价、改成本 | 历史单金额、成本、毛利不变 |
| SAL-017 | P1 | 页面 | 销售 | 扫码/库存选机→核价→确认收款 | 确认前有收款确认；确认后才扣库 |
| SAL-018 | P1 | 页面 | 销售 | 库存多选带入收银 | 所选设备逐台带入并核价，含编码参数 |
| SAL-019 | P1 | 页面 | 销售 | 库存“扫码出库” | 直接打开扫码 |
| SAL-020 | P1 | 页面 | 销售 | 响应丢失后点重试 | 用原 requestKey，不重复成交 |
| SAL-021 | P1 | 页面 | 销售 | 核价后价格变化再提交 | 提示重新核对 |

## 8.3 收款凭证

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RCP-001 | P1 | API | 销售 | 开单带 2 张内部图片 | 详情 receipts 2 张，含上传人和时间 |
| RCP-002 | P1 | API | 销售 | 开单不带凭证 | 允许 |
| RCP-003 | P1 | API | 销售 | 超过 9 张、重复 | 400「收款凭证须为1～9张内部图片」/「收款凭证重复」 |
| RCP-004 | P1 | API | 销售 | 公开文件、视频 | 400「收款凭证须单独上传为内部图片」 |
| RCP-005 | P1 | API | 销售 | 已用作入库/维修/借还的文件 | 400「其他业务凭证不能用作收款凭证」 |
| RCP-006 | P0 | API | 销售 B | 引用销售 A 上传的图片 | 403「无权引用他人的收款凭证」 |
| RCP-007 | P1 | API | 销售 | 补传：填说明 | 成功；审计「补传收款凭证」 |
| RCP-008 | P1 | API | 销售 | 补传不填说明 | 400「补传说明格式无效」 |
| RCP-009 | P1 | API | 销售 | 同一文件补传两次 | 视为重试，不重复记录，不重复审计 |
| RCP-010 | P0 | API | 销售 | 已属于其他销售单的文件 | 409「该凭证已关联其他销售单」 |
| RCP-011 | P1 | API | 销售 | 累计超过 20 张 | 400「每张销售单最多20张收款凭证」 |
| RCP-012 | P0 | API | 库管 | 打开收款凭证文件链接 | 403 |
| RCP-013 | P0 | 并发 | 销售 + 工程师 | 同一图片同时认领为收款凭证和维修费用凭证 | 只有一方成功 |
| RCP-014 | P1 | API | 财务 | 补传（持 refund） | 允许 |
| RCP-015 | P1 | 页面 | 销售 | 收银页加 2 张删 1 张后收款 | 详情显示 1 张，可预览 |

## 8.4 销售单查询

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| SLS-001 | P1 | API | 销售 | 列表按 keyword（单号、顾客）搜索 | 正确 |
| SLS-002 | P1 | API | 老板 | 按 sellerId 筛选 | 只含该销售 |
| SLS-003 | P1 | API | 老板 | `GET /sales-orders/sellers` | 只列有销售单的员工 |
| SLS-004 | P1 | API | 老板 | from、to 按北京时间切日 | 23:59 与次日 00:00 的单归属正确 |
| SLS-005 | P1 | API | 老板 | status=paid/partially_refunded/refunded | 由退款记录派生，三类互斥 |
| SLS-006 | P1 | API | 老板 | status=xxx | 400「销售状态无效」 |
| SLS-007 | P1 | API | 老板 | 查不存在的单 | 404「销售单不存在」 |
| SLS-008 | P0 | API | 工程师/库管 | 调列表、详情 | 403 |
| SLS-009 | P1 | 页面 | 老板 | 销售列表销售员选择器、清除筛选 | 恢复全部销售员 |
| SLS-010 | P1 | API | 销售 | 代理成交单详情 agentSources | 含代理名、分享价；无 markup、earnings |
| SLS-011 | P0 | API | 财务 | 同上 | 另含 markup 和 earnings（kind、status） |

## 8.5 退款

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| REF-001 | P0 | API | 财务 | 整机退货，默认金额 | 退剩余可退全额；units→recheck；分享全关；ledger sold→recheck；审计「销售退款」；status=refunded |
| REF-002 | P0 | API | 财务 | 差价退款 100 元 | 设备仍 sold；status=partially_refunded；不写流水 |
| REF-003 | P0 | API | 财务 | 差价分两次，累计等于成交价 | 成功；再退 0.01 400「退款金额超出剩余可退范围」 |
| REF-004 | P1 | API | 财务 | 差价金额 0 | 400「退款金额超出剩余可退范围」 |
| REF-005 | P0 | API | 财务 | 差价退满后再整机退货（金额缺省） | 退货成功，退款 0 元；设备进 recheck；成本冲回 |
| REF-006 | P0 | API | 财务 | 部分差价后整机退货 | 只退余额；毛利正确 |
| REF-007 | P0 | API | 财务 | 重复退货 | 409「该设备已退货」 |
| REF-008 | P1 | API | 财务 | 退货金额小于剩余 | 允许；金额按入参 |
| REF-009 | P1 | API | 财务 | 退款超过剩余 | 400「退款金额超出剩余可退范围」 |
| REF-010 | P0 | API | 财务 | 不填原因 | 400「退款原因格式无效」 |
| REF-011 | P1 | API | 财务 | kind 非法、items 空或超 100 | 400「退款项目无效」 |
| REF-012 | P1 | API | 财务 | itemId 不属于本单 | 400「退款明细不属于本单」 |
| REF-013 | P1 | API | 财务 | itemId 重复 | 400「退款明细重复」 |
| REF-014 | P0 | API | 财务 | 同 requestKey 同内容重放 | 返回详情，不重复退 |
| REF-015 | P0 | API | 财务 | 同 requestKey 不同内容 | 409「退款提交标识冲突」 |
| REF-016 | P0 | 并发 | 两名财务 | 同一单同时退款 | 累计不超限，不重复退货 |
| REF-017 | P0 | API | 销售 | 调退款 | 403 |
| REF-018 | P0 | API | 财务 | 退货复检通过后再售，旧单再退 | 旧单 409「该设备已退货」 |
| REF-019 | P0 | API | 财务 | 多台单只退 1 台 | 该台 recheck；另一台 sold；status=partially_refunded |
| REF-020 | P0 | API | 财务 | 多台单退多台，其中一台状态异常 | 409「原销售设备状态不符」，整笔回滚 |
| REF-021 | P0 | 数据 | 财务 | 退货后 | 原成交快照不变；profit=实收-退款-成本+冲回成本 |
| REF-022 | P1 | 页面 | 财务 | 逐台选择、差价金额、填原因、二次确认 | 走 `confirmSensitive`；响应丢失重试不重复退 |
| REF-023 | P1 | 页面 | 销售 | 打开销售详情 | 没有退款入口 |
| REF-024 | P1 | 数据 | 财务 | 退货后查经营统计 | 净额按退款发生时间计入 |
