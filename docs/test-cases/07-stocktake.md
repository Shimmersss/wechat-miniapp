# 07 盘点

涉及接口：`GET/POST /stocktake-sessions`、`GET /stocktake-sessions/:id`、`GET /stocktake-sessions/:id/units`、`POST /stocktake-sessions/:id/scans`、`POST /stocktake-sessions/:id/close`、`POST /stocktake-sessions/:id/cancel`、`GET /stocktakes`、`GET /stocktakes/:id`、`POST /stocktakes/:id/resolutions`
涉及页面：`staff/inventory/stocktake|stocktake-run|stocktake-result`

需要 stocktake:do + inventory:view。默认范围：in_stock、locked、recheck、repairing、borrowed_in。可选范围另含 pending_acceptance、accepting、abnormal。差异处理只记录，不改库存。

## 7.1 开单

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STK-001 | P0 | API | 库管 | 默认范围开单 | status=open；expectedCount=默认状态设备总数；审计「开始盘点」 |
| STK-002 | P1 | API | 库管 | 只选 in_stock | 清单仅在库设备 |
| STK-003 | P1 | API | 库管 | 按 modelId 开单 | 清单仅该型号 |
| STK-004 | P1 | API | 库管 | 按 category 开单 | 清单仅该分类 |
| STK-005 | P1 | API | 库管 | 同时传 modelId 和 category | 400「型号和分类只能选一种范围」 |
| STK-006 | P1 | API | 库管 | 型号、分类不存在 | 400「盘点型号不存在」/「盘点分类不存在」 |
| STK-007 | P0 | API | 库管 | statuses 含 sold、loaned_out、in_transit、returned | 400「盘点范围只能选择在店内的库存状态」 |
| STK-008 | P1 | API | 库管 | statuses 为空数组 | 400（同上） |
| STK-009 | P1 | API | 库管 | 说明超过 200 字 | 400「盘点说明格式无效」 |
| STK-010 | P0 | API | 库管 | 同 requestKey 同内容重试 | 返回同一张单 |
| STK-011 | P0 | API | 库管 | 同 requestKey 不同内容 | 409「提交标识已用于其他内容，请保留原内容重试」 |
| STK-012 | P0 | 并发 | 库管 | 同 requestKey 并发开单 | 只生成一张，输家读到赢家结果 |
| STK-013 | P1 | API | 销售 | 开单 | 403 |
| STK-014 | P1 | API | 库管 | 列表 status=xxx | 400「盘点单状态无效」 |
| STK-015 | P0 | 数据 | 库管 | 开单后新入库设备 | 不进入本单清单（快照） |

## 7.2 扫码

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STK-020 | P0 | API | 库管 | 扫清单内设备 IMEI1 | result=matched「已盘到」；scannedCount+1 |
| STK-021 | P0 | API | 库管 | 用 IMEI2、设备 id 扫同一台 | duplicate「这台已经盘过」，不重复计数 |
| STK-022 | P1 | API | 库管 | 同一台再次扫 IMEI1 | duplicate |
| STK-023 | P0 | API | 库管 | 扫系统不存在的编码 | unknown「系统里没有这台设备」，写入 extras |
| STK-024 | P1 | API | 库管 | 重复扫同一未知编码 | duplicate「已记为异常，不重复登记」 |
| STK-025 | P0 | API | 库管 | 扫已售设备 | out_of_scope「已售，不在本次盘点范围」 |
| STK-026 | P1 | API | 库管 | 扫开单后才入库的设备 | out_of_scope「开盘后才进入盘点范围，不在开盘清单」 |
| STK-027 | P1 | API | 库管 | 扫其他型号设备（型号范围单） | out_of_scope |
| STK-028 | P0 | 并发 | 两名库管 | 同时扫同一台 | 只计一次；另一方 duplicate |
| STK-029 | P1 | API | 库管 | 已结束或作废的单继续扫 | 409「盘点单已结束，不能继续扫码」 |
| STK-030 | P1 | API | 库管 | 编码为空、超过 80 字 | 400「设备编号或串码格式无效」 |
| STK-031 | P1 | API | 库管 | 单不存在 | 404「盘点单不存在」 |
| STK-032 | P0 | API | 无 fullImei 权限者（被授予盘点） | 扫码、查 extras | 串码以脱敏形式返回 |
| STK-033 | P1 | API | 库管 | units state=pending/scanned/extra 分页 | 三个清单互斥且总和正确 |
| STK-034 | P1 | API | 库管 | state=xxx | 400「清单类型无效」 |
| STK-035 | P1 | 页面 | 库管 | 连续扫码；退出再进入 | 进度实时更新；进度保存在服务端，可中途退出继续 |
| STK-036 | P1 | 页面 | 两台手机 | 多人同盘 | 对方扫的设备刷新后显示已盘 |

## 7.3 结束与作废

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STK-040 | P0 | API | 库管 | 结束：10 台清单盘到 8 台，1 台丢失未扫，1 台期间已售 | matched=8，missing=1，changed=1（from→to），期间离店不算缺失 |
| STK-041 | P0 | 数据 | 库管 | 结束后 | 写入只追加的 stocktakes；库存状态完全不变；审计「结束盘点」 |
| STK-042 | P1 | API | 库管 | 重复调用 close | 返回同一结果，不重复生成 |
| STK-043 | P1 | API | 库管 | close 已作废的单 | 409「盘点单已作废」 |
| STK-044 | P0 | API | 库管 | 期间状态变化但仍在范围内（in_stock→locked） | 未扫则算缺失 |
| STK-045 | P1 | API | 库管 | 作废：填原因 | status=cancelled；不生成结果；审计「作废盘点」 |
| STK-046 | P1 | API | 库管 | 作废不填原因 | 400「作废原因格式无效」 |
| STK-047 | P1 | API | 库管 | 作废已结束的单 | 409「只能作废进行中的盘点单」 |
| STK-048 | P0 | 并发 | 两名库管 | 结束与扫码同时发生 | 串行；结束后的扫码 409 |
| STK-049 | P2 | API | 库管 | 空清单开单后结束 | 结果全 0，不报错 |

## 7.4 差异处理

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STK-060 | P0 | API | 库管 | 缺失设备标记 lost，填说明 | 追加一条处理记录；设备状态不变；审计「处理盘点差异」 |
| STK-061 | P1 | API | 库管 | 缺失设备标记 found | openCount-1 |
| STK-062 | P1 | API | 库管 | 缺失设备标记 pending | 视为未处理 |
| STK-063 | P1 | API | 库管 | 异常项标记 handled | openCount-1 |
| STK-064 | P1 | API | 库管 | 异常项标记 lost，缺失设备标记 handled | 400「处理结果无效」 |
| STK-065 | P1 | API | 库管 | type 非 unit/extra | 400「差异类型无效」 |
| STK-066 | P1 | API | 库管 | 设备不在缺失列表 | 400「该设备不是本次盘点的缺失设备」 |
| STK-067 | P1 | API | 库管 | 异常序号越界 | 400「盘点异常项不存在」 |
| STK-068 | P1 | API | 库管 | 不填说明、超过 200 字 | 400「处理说明格式无效」 |
| STK-069 | P1 | API | 库管 | 同一项多次处理 | 全部保留，详情取最新一条 |
| STK-070 | P0 | 数据 | runtime 账号 | 修改或删除 stocktakes、stocktake_resolutions | 权限拒绝 |
| STK-071 | P1 | API | 库管 | 盘点记录不存在 | 404「盘点记录不存在」 |
| STK-072 | P1 | 页面 | 库管 | 结果页 | 缺失、异常、期间离店分列；处理需填说明 |
| STK-073 | P2 | API | 库管 | 历史一次性盘点记录（无 session） | 仍可读 |
