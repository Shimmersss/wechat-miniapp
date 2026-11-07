# 04 供应商、采购、运单、到货验收

涉及接口：`GET/POST /suppliers`、`PUT /suppliers/:id`、`GET/POST /purchase-orders`、`GET/PUT /purchase-orders/:id`、`POST /purchase-orders/:id/shipments`、`POST /shipments/:id/receive`、`GET /shipments/:id/tracks`、`GET/POST /purchase-orders/:id/acceptance`、`POST /acceptances/:id/resolve`
涉及页面：`staff/suppliers`、`staff/purchase/list|edit|detail`、`staff/acceptance`

采购单状态：`pending_ship → in_transit → arrived → accepting → completed`，异常未处理时为 `exception`。

## 4.1 供应商

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| SUP-001 | P1 | API | 采购 | 新增供应商（名称、联系人、电话、结算方式、备注） | 成功；审计「新增供应商」 |
| SUP-002 | P1 | API | 采购 | 名称为空或超过 100 字 | 400「供应商名称格式无效」 |
| SUP-003 | P1 | API | 采购 | active 非布尔 | 400「供应商状态无效」 |
| SUP-004 | P1 | API | 采购 | 编辑并停用 | 成功；新建采购单选不到 |
| SUP-005 | P1 | API | 采购 | 编辑不存在的供应商 | 404「供应商不存在」 |
| SUP-006 | P0 | API | 库管/销售 | 查询或新增供应商 | 403 |
| SUP-007 | P0 | API | 店长（supplier 字段被收回） | 查询、新增、修改 | 403「无权限查看供应商」 |
| SUP-008 | P2 | API | 采购 | 按 keyword、active 筛选；active=abc | 结果正确；abc 返回 400「供应商状态无效」 |
| SUP-009 | P2 | 页面 | 采购 | 新增、编辑、停用流程 | 列表即时刷新 |

## 4.2 采购单

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| PUR-001 | P0 | API | 采购 | 建 2 行明细采购单，运费 50 | status=pending_ship；amount=Σ数量×单价+运费；qty 为明细合计；单号 PO+日期 |
| PUR-002 | P1 | API | 采购 | 明细 0 行、101 行 | 400「采购单需包含 1～100 行明细」 |
| PUR-003 | P1 | API | 采购 | 单行数量 0、1001、小数 | 400「采购数量需为 1～1000 的整数」 |
| PUR-004 | P1 | API | 采购 | 合计超过 10000 台 | 400「单张采购单最多 10000 台」 |
| PUR-005 | P1 | API | 采购 | 单价三位小数、负数 | 400「采购单价需为非负金额，最多两位小数」 |
| PUR-006 | P1 | API | 采购 | 供应商不存在或已停用 | 400「供应商不存在或已停用」 |
| PUR-007 | P1 | API | 采购 | 明细型号不存在 | 400「明细型号不存在」 |
| PUR-008 | P1 | API | 采购 | attributes 为数组或 null | 400「采购规格无效」 |
| PUR-009 | P2 | API | 采购 | attributes 含 storage/color/version 以外的键 | 其他键被丢弃 |
| PUR-010 | P1 | API | 采购 | 预计到货日期 2026-02-30、缺失 | 400「预计到货日期格式无效」 |
| PUR-011 | P1 | API | 采购 | pending_ship 状态修改明细 | 成功；单号不变；明细整体替换；审计「修改采购单」 |
| PUR-012 | P0 | API | 采购 | 绑定运单后修改明细 | 409「已发货或开始验收的采购单不能修改明细」 |
| PUR-013 | P1 | API | 采购 | 查看不存在的采购单 | 404「采购单不存在」 |
| PUR-014 | P0 | API | 库管 | `GET /purchase-orders/:id` | 无 supplier、amount、freight、unitCost |
| PUR-015 | P0 | API | 财务 | 采购接口 | 403 |
| PUR-016 | P1 | API | 采购 | 按 status、supplierId、keyword（单号、运单号）筛选 | 结果和 summary（orders、totalQty、remainingQty、inTransitQty）正确 |
| PUR-017 | P1 | API | 采购 | status=xxx | 400「采购状态无效」 |
| PUR-018 | P0 | API | 无 supplier 字段权限者 | 按 supplierId 筛选 | 403「无权限筛选供应商」 |
| PUR-019 | P1 | 页面 | 采购 | 新建单：增删明细行、选型号、选供应商 | 型号选择回传到对应行；合计前端只作展示，以服务端为准 |
| PUR-020 | P2 | 页面 | 采购 | 列表顶部汇总与筛选 | 与接口 summary 一致 |

## 4.3 运单与签收

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| SHP-001 | P0 | API | 采购 | 绑定顺丰运单 | status→in_transit；审计「绑定采购运单」 |
| SHP-002 | P1 | API | 采购 | carrier 非 SF/JD/OTHER | 400「承运商或运单号无效」 |
| SHP-003 | P1 | API | 采购 | 运单号 7 位、41 位、含符号 | 400「承运商或运单号无效」 |
| SHP-004 | P2 | API+页面 | 采购 | 运单号 31～40 位 | 服务端允许到 40 位；核对前端提示是否一致（`isTrackingNo` 上限 30，当前无页面引用） |
| SHP-005 | P1 | API | 采购 | 一张采购单绑两个运单 | 允许；shipments 全部列出 |
| SHP-006 | P1 | API | 采购 | completed 后追加运单 | 409「采购单已完成，不能追加运单」 |
| SHP-007 | P0 | API | 库管 | 人工签收，带说明 | 运单 signed；采购单→arrived；审计「采购运单人工签收」 |
| SHP-008 | P1 | API | 库管 | 不填说明 | 400「人工签收说明格式无效」 |
| SHP-009 | P1 | API | 库管 | 重复签收 | 200 `{received:true}`，不改 signed_at |
| SHP-010 | P1 | API | 库管 | 带收货凭证 receiptFileId（内部图片） | 保存；用公开文件时 400「文件不存在或上传范围不符」 |
| SHP-011 | P1 | API | 库管 | 签收不存在的运单 | 404「运单不存在」 |
| SHP-012 | P1 | API | 采购 | `GET /shipments/:id/tracks` | 503「首期不提供快递轨迹查询，请在实际收货后登记签收」 |
| SHP-013 | P1 | 页面 | 采购 | 详情页 | 没有轨迹查询入口；可扫码录入运单号 |
| SHP-014 | P2 | API | 采购 | 两个运单只签收一个，验收完全部台数 | 状态停在 accepting，全部签收后才 completed |

## 4.4 逐台验收（主流程）

前置：采购单 2 台，已签收。每台均带内部收货凭证。

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| ACC-001 | P0 | API | 库管 | 2 台全部 pass，declaredCount=2 | 生成 2 台 in_stock；ledger accepting→in_stock；采购单 completed；received=accepted=2 |
| ACC-002 | P0 | 数据 | 库管 | 查验收后设备 | cost=采购单价（客户端传 cost 被忽略）；supplier 取自采购单 |
| ACC-003 | P0 | API | 库管 | 请求里伪造 cost、supplierId | 服务端不采信 |
| ACC-004 | P0 | API | 库管 | 未签收时验收 | 409「请先登记实际签收，再开始验收」 |
| ACC-005 | P1 | API | 库管 | status 已合法但无 signed 运单的异常数据 | 409「采购单尚未签收」 |
| ACC-006 | P0 | API | 库管 | declaredCount 与 items 数量不一致 | 400「实收数量与逐台扫码数量不一致」 |
| ACC-007 | P0 | API | 库管 | 验收台数超过剩余 | 400「实收数量超过采购剩余数量」 |
| ACC-008 | P0 | API | 库管 | 少验且未确认分批 | 400「数量不足，请明确确认分批验收」 |
| ACC-009 | P1 | API | 库管 | partialConfirmed=true 但无原因 | 400「分批验收原因格式无效」 |
| ACC-010 | P0 | API | 库管 | 分批验收 1 台 | 成功；status=accepting；剩余 1 |
| ACC-011 | P0 | API | 库管 | 单行明细超量（总数未超） | 400「本型号验收数量超过采购剩余数量」 |
| ACC-012 | P1 | API | 库管 | items 为空、超过 100 | 400「每次验收需为 1～100 台」 |
| ACC-013 | P1 | API | 库管 | lineId 不属于本单 | 400「第 1 台不属于本采购单明细」 |
| ACC-014 | P1 | API | 库管 | result 缺失 | 400「第 1 台请填写验收结论」 |
| ACC-015 | P0 | API | 库管 | pass 但型号与明细不同 | 400「第 1 台：验收型号与采购明细不符，应记录异常」 |
| ACC-016 | P0 | API | 库管 | 采购规格 storage=256G，验收填 512G | 400「验收storage与采购规格不符，应记录异常」 |
| ACC-017 | P0 | API | 库管 | 无内部凭证 | 400「验收需上传内部收货凭证」 |
| ACC-018 | P0 | API | 库管 | 串码校验位错误 | 400「第 1 台：IMEI 格式或校验位无效」，整批不落库 |
| ACC-019 | P0 | API | 库管 | 同批两台同串码 | 400「本次提交存在重复串码」 |
| ACC-020 | P0 | API | 库管 | 串码已入库 | 409「串码已入库或正在异常验收中」，整批回滚 |
| ACC-021 | P0 | API | 库管 | IMEI2 等于别台 IMEI1 | 跨 IMEI1/2 唯一，拒绝 |
| ACC-022 | P0 | 数据 | 库管 | 第 2 台失败 | 第 1 台也不入库，received_count 不变 |
| ACC-023 | P0 | API | 库管 | 同 requestKey 同内容重放（模拟响应丢失） | 返回首次结果，不重复计数 |
| ACC-024 | P0 | API | 库管 | 同 requestKey 不同内容 | 409「提交标识已用于其他内容，请重新核对」 |
| ACC-025 | P0 | 并发 | 两名库管 | 同一采购单同时验收最后 1 台 | 只有一方成功，另一方「实收数量超过采购剩余数量」 |
| ACC-026 | P0 | API | 库管 | 验收提交后查响应和详情 | 无成本、无供应商；服务端仍保留 |
| ACC-027 | P1 | API | 销售 | 调验收接口 | 403 |
| ACC-028 | P1 | API | 库管 | `GET /purchase-orders/:id/acceptance` | 返回 lines、exceptions、remaining、canAccept；pending_ship 时 canAccept=false |
| ACC-029 | P1 | API | 库管 | 正在整备的设备验收通过 | 设备 status=recheck，分享开关全关 |
| ACC-030 | P0 | 页面 | 库管 | 逐台扫码、填结论、传凭证、提交 | 实收数量比对提示；响应丢失后点重试不重复入库 |
| ACC-031 | P1 | 页面 | 库管 | 少验提交 | 弹确认并要求填原因 |

## 4.5 验收异常与处理

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| ACX-001 | P0 | API | 库管 | 1 台 fail，填异常原因和实机型号 | 不生成库存；串码被预占；rejected=1；采购单 exception |
| ACX-002 | P1 | API | 库管 | fail 不填原因 | 400「异常原因格式无效」 |
| ACX-003 | P0 | API | 库管 | fail 但串码无效 | 400「异常设备也须提供有效串码」 |
| ACX-004 | P1 | API | 库管 | 异常与同批其他台串码重复 | 400「本次验收串码重复」 |
| ACX-005 | P0 | API | 库管 | 异常串码已登记 | 409「该串码已登记，不能重复验收」 |
| ACX-006 | P1 | API | 库管 | 异常设备 modelId 不存在 | 400「异常设备型号不存在」 |
| ACX-007 | P0 | API | 库管 | 异常串码另走单台入库 | 409「串码已入库或正在异常验收中」 |
| ACX-008 | P0 | API | 库管 | 处理：return（退供应商） | resolution=returned；串码释放；若其余完成则 completed |
| ACX-009 | P1 | API | 库管 | 处理：dispute（争议） | resolution=dispute；采购单保持 exception；之后仍可 return/reinspect |
| ACX-010 | P0 | API | 库管 | 处理：reinspect（复验通过） | 生成 in_stock 设备；沿用原串码和采购成本；accepted+1、rejected-1；received 不变 |
| ACX-011 | P0 | API | 库管 | 复验换串码 | 400「复验不能替换原异常设备串码」 |
| ACX-012 | P1 | API | 库管 | 复验规格仍不符 | 400，异常保持未处理 |
| ACX-013 | P1 | API | 库管 | 不填原因、action 非法 | 400「异常处理原因格式无效」/「异常处理方式无效」 |
| ACX-014 | P1 | API | 库管 | 重复处理已完结异常 | 409「该异常已处理，不能重复操作」 |
| ACX-015 | P1 | API | 库管 | 处理不存在的记录 | 404「验收记录不存在」 |
| ACX-016 | P0 | 并发 | 两名库管 | 同一异常同时复验 | 只生成一台设备；另一方 409「该异常已处理，不能重复操作」或「异常验收串码已变更，请刷新」 |
| ACX-017 | P1 | API | 无权限复用他人凭证的库管 | 复验沿用原异常凭证 | 通过（trustedReceiptIds）；换用他人其他凭证 403「无权引用该内部凭证」 |
| ACX-018 | P0 | 数据 | 全流程 | 2 台：1 通过，1 异常退回 | 采购单 completed；在库 1 台；不产生多余库存或成本 |
| ACX-019 | P1 | 页面 | 库管 | 详情页异常列表 | 串码按权限脱敏；可选退回/争议/复验 |
