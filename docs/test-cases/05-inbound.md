# 05 单台与批量入库

涉及接口：`POST /inbound/check-imei`、`POST /pricing/suggest`、`GET /pricing/cost-presets`、`POST /inbound/units`、`POST /inbound/batch`
涉及页面：`staff/inbound/index`、`staff/inbound/batch`（共用 `inbound/form.js`）

需同时持有 inbound:do 和 acceptance:do。测试串码必须通过 Luhn 校验。

## 5.1 串码与定价辅助

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| INB-001 | P1 | API | 库管 | 未使用的 IMEI 调 check-imei | `{unique:true}` |
| INB-002 | P1 | API | 库管 | 已入库 IMEI | `{unique:false,conflictUnitId}` |
| INB-003 | P1 | API | 库管 | 被异常验收预占的 IMEI | unique=false，无 conflictUnitId |
| INB-004 | P1 | API | 库管 | 14 位、16 位、校验位错 | 400「IMEI 格式或校验位无效」 |
| INB-005 | P1 | API | 采购 | suggest：cost=3000，targetProfit=500 | retail=3500；wholesale、agentBase 按折扣配置，不低于成本 |
| INB-006 | P2 | API | 采购 | 配置 WHOLESALE_DISCOUNT 大于利润 | wholesale=cost（不倒挂成本） |
| INB-007 | P2 | API | 采购 | targetProfit 缺省 | 按 0 计算 |
| INB-008 | P1 | API | 库管 | `GET /pricing/cost-presets?modelId=` | 无 cost 字段权限时返回空数组 |
| INB-009 | P2 | API | 采购 | 同上 | 返回该型号历史成本去重，升序，最多 20 个 |
| INB-010 | P1 | API | 销售 | 调用 suggest、presets | 403 |

## 5.2 单台入库

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| INB-020 | P0 | API | 采购 | 填齐模板字段、串码、成本、三价、确认已验收 | 200，返回 id；status=in_stock；ledger null→in_stock，doc_type=inbound；审计「单台验收入库」 |
| INB-021 | P0 | API | 采购 | inspectionConfirmed≠true | 400「独立入库必须确认已完成到货验收」 |
| INB-022 | P0 | API | 销售 | 调入库 | 403 |
| INB-023 | P1 | API | 持 inbound 但无 acceptance 的自定义角色 | 调入库 | 403 |
| INB-024 | P1 | API | 采购 | 型号不存在 | 400「第 1 台：型号不存在」 |
| INB-025 | P0 | API | 采购 | 模板版本过期 | 409「第 1 台：模板已更新，请重新加载型号」 |
| INB-026 | P1 | API | 采购 | attributes 缺失或为数组 | 400「请填写模板参数」 |
| INB-027 | P1 | API | 采购 | 必填字段空 | 400「请填写<字段名>」 |
| INB-028 | P1 | API | 采购 | 下拉值不在选项（含型号规格之外的颜色） | 400「请选择有效的<字段名>」 |
| INB-029 | P1 | API | 采购 | 数字字段超范围、日期非法、开关非布尔 | 各字段对应提示 |
| INB-030 | P0 | API | 采购 | 串码校验位错误 | 400「IMEI 格式或校验位无效」 |
| INB-031 | P0 | API | 采购 | IMEI1 = IMEI2 | 400「本次提交存在重复串码」 |
| INB-032 | P0 | API | 采购 | 串码已存在（作为 IMEI1 或 IMEI2） | 409「串码已入库或正在异常验收中」 |
| INB-033 | P0 | API | 采购 | 串码正在外部维修 | 409「串码正在外部维修中，不能作为本店库存入库」 |
| INB-034 | P0 | API | 采购 | TAC 映射到其他型号 | 400「串码识别型号与所选型号不一致」 |
| INB-035 | P1 | API | 采购 | 未知 TAC | 允许入库（只认已核验映射） |
| INB-036 | P1 | API | 采购 | condition 非 used/new | 400「设备类型无效」 |
| INB-037 | P1 | API | 采购 | 成本、零售、批发、代理底价为负或三位小数 | 400「<价格>需为非负金额，最多两位小数」 |
| INB-038 | P2 | API | 采购 | 金额 12 位整数上限 | 通过；13 位 400 |
| INB-039 | P1 | API | 库管 | 模板要求供应商但未选 | 400「请关联有效供应商；库管可从采购验收单入库」 |
| INB-040 | P1 | API | 采购 | 供应商不存在、已停用 | 400「供应商不存在」/「供应商已停用」 |
| INB-041 | P1 | API | 采购 | attributes.refurbishment=正在整备 | status=recheck；分享开关强制全关 |
| INB-042 | P1 | API | 采购 | flags 含未知键或非布尔 | 400「分享开关格式无效」 |
| INB-043 | P0 | API | 采购 | 公开相册传内部文件、凭证传公开文件 | 400「文件不存在或上传范围不符」 |
| INB-044 | P1 | API | 采购 | 相册 10 个文件、重复文件 | 400「每个相册最多九个文件」/「相册中存在重复文件」 |
| INB-045 | P1 | API | 采购 | 图片字段上传视频 | 400「该模板字段只接受图片」 |
| INB-046 | P0 | API | 库管 | 引用别人上传的内部凭证 | 403「无权引用该内部凭证」 |
| INB-047 | P1 | API | 采购 | 引用维修附件、借还附件、收款凭证 | 分别 400「维修附件不能用作入库凭证」「借还附件不能作为入库凭证」「收款凭证不能作为入库凭证」 |
| INB-048 | P1 | API | 采购 | 客户端传 ownership、status | 不采信 |
| INB-049 | P0 | 数据 | 采购 | 重启 API 后读取设备 | 数据、模板快照、文件都在 |
| INB-050 | P1 | 页面 | 采购 | 选型号→扫 IMEI→填写→上传→提交 | 按模板动态渲染；颜色只出现该型号选项；有二次确认 |
| INB-051 | P1 | 页面 | 采购 | 成本快捷档位 + 目标利润 | 建议价由接口返回，可手工改 |
| INB-052 | P1 | 页面 | 销售 | 界面中不出现成本输入 | 不进入页面（无 inbound 权限） |
| INB-053 | P2 | 页面 | 采购 | 不出现“闲鱼同售”“侠客汇同售”等字段 | 无 |
| INB-054 | P1 | 页面 | 采购 | 双描述、内部备注 | 同行/顾客描述分别保存；内部备注不外发 |

## 5.3 批量入库

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| INB-060 | P0 | API | 采购 | common 公共字段 + 3 台 units | `{created:3,ids}`；审计「批量验收入库」；每台 attributes 合并公共与单台 |
| INB-061 | P1 | API | 采购 | 单台字段覆盖 common | 单台优先 |
| INB-062 | P0 | API | 采购 | 第 2 台串码重复 | 400「第 2 台：…」，3 台全部不入库 |
| INB-063 | P0 | API | 采购 | 第 3 台串码已存在 | 409，前两台回滚 |
| INB-064 | P1 | API | 采购 | units 为空、101 台 | 400「每次入库需为 1～100 台」 |
| INB-065 | P1 | API | 采购 | units 含 null | 400「第 2 台数据无效」 |
| INB-066 | P1 | API | 采购 | common 未确认验收 | 400「独立入库必须确认已完成到货验收」 |
| INB-067 | P0 | 并发 | 两人 | 同一串码同时入库 | 只有一方成功，另一方 409「记录重复或映射冲突，请核对后重试」 |
| INB-068 | P1 | 页面 | 采购 | 连续扫码逐台添加、编辑、删除行 | 行级校验；提交失败定位到具体台 |
| INB-069 | P1 | 页面 | 采购 | 批量页扫到重复串码 | 前端先提示 |
