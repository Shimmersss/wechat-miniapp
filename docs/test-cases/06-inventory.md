# 06 库存、改价、共享开关、复检、标签

涉及接口：`GET /units`、`GET /units/:id`、`PATCH /units/:id/price`、`PATCH /units/share-flags`、`PATCH /units/:id/share-flags`、`GET /units/:id/ledger`、`GET /units/:id/recheck-form`、`POST /units/:id/recheck`、`GET /units/:id/label`
涉及页面：`staff/inventory/list|detail|label`

## 6.1 列表与搜索

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| INV-001 | P1 | API | 老板 | 无条件查询 | list、total、page、pageSize、counts（all + 各状态）、summary（inStock、retailTotal、costTotal） |
| INV-002 | P1 | API | 老板 | 按每个 status 查询（12 种） | 仅返回该状态 |
| INV-003 | P1 | API | 老板 | status=xxx | 400「库存状态无效」 |
| INV-004 | P1 | API | 老板 | keyword=型号名、设备 id、完整 IMEI1、完整 IMEI2 | 均可命中 |
| INV-005 | P1 | API | 老板 | imei= 完整串码 | 精确命中 |
| INV-006 | P1 | API | 老板 | ageingOver=30 | 只返回入库满 30 天；-1 或超过 36500 返回 400「库龄需为 0～36500 的整数」 |
| INV-007 | P1 | API | 老板 | minPrice、maxPrice 过滤零售价 | 边界值包含；最低高于最高 400「最低价不能高于最高价」 |
| INV-008 | P2 | API | 老板 | page=0、pageSize=1001、pageSize=abc | 400「分页参数无效」 |
| INV-009 | P1 | API | 老板 | 组合 modelId+status+价格 | 交集正确；counts 与 summary 不随筛选变化 |
| INV-010 | P1 | 页面 | 销售 | 扫码搜索 | 15 位串码可查，部分数字被拒；结果只显示 imeiMasked |
| INV-011 | P1 | 页面 | 老板 | 上拉分页、下拉刷新、筛选重置 | 不重复、不丢项 |
| INV-012 | P1 | 页面 | 老板 | 顶部汇总 | 台数、零售总额、在库成本；销售的在库成本显示“无权限查看” |
| INV-013 | P2 | API | 老板 | `GET /units/:id` 不存在 | 404「设备不存在」 |
| INV-014 | P1 | API | 库管 | 查看出借中设备详情 | 含 loan{id,no,type} |
| INV-015 | P0 | API | 销售 | 查看出借中设备详情 | 不含 loan（无 loan:manage） |
| INV-016 | P2 | API | 老板 | 查看待复检设备 | availableActions=["recheck"]；销售为 [] |

## 6.2 改价

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| PRC-001 | P0 | API | 店长 | 改零售价，带原因和当前 priceVersion | 成功；price_version+1；审计「修改库存价格」含改前改后和原因 |
| PRC-002 | P0 | API | 店长 | 不填原因 | 400「改价原因格式无效」 |
| PRC-003 | P0 | API | 店长 | 旧 priceVersion | 409「价格已更新，请刷新」 |
| PRC-004 | P0 | 并发 | 两名店长 | 同版本同时改价 | 一个成功，一个 409 |
| PRC-005 | P0 | API | 店长 | 对 locked、sold、repairing、loaned_out、recheck、borrowed_in 改价 | 409「当前状态不可改价」 |
| PRC-006 | P1 | API | 店长 | 只传 reason，或带 cost 等未知字段 | 400「改价参数无效」 |
| PRC-007 | P0 | API | 店长 | 试图改 cost | 400，成本不可经此接口修改 |
| PRC-008 | P1 | API | 店长 | 同时改 retail、wholesale、agentBase | 三者更新；版本只+1 |
| PRC-009 | P1 | API | 店长 | 价格三位小数、负数 | 400 |
| PRC-010 | P0 | API | 销售 | 调改价 | 403 |
| PRC-011 | P0 | 数据 | 店长 | 改价后 | 历史销售快照不变；已生成分享链接 410「商品价格已变化，请重新分享」 |
| PRC-012 | P1 | 页面 | 店长 | 改价弹层 | 必填原因；冲突提示刷新；走二次确认 |

## 6.3 共享开关

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| FLG-001 | P0 | API | 销售 | in_stock 设备开启 showInShop | 顾客端可见；审计「调整库存共享范围」 |
| FLG-002 | P0 | API | 销售 | 开启 sharePeer | 仅同行可见 |
| FLG-003 | P0 | API | 销售 | 开启 shareAgent | 仅代理列表可见 |
| FLG-004 | P0 | API | 销售 | 非 in_stock 设备打开任一开关 | 409「只有在库可售设备能对外展示或分享」 |
| FLG-005 | P1 | API | 销售 | 非 in_stock 设备全部关闭 | 成功 |
| FLG-006 | P1 | API | 销售 | body 含未知键、非布尔、空 | 400「分享开关格式无效」 |
| FLG-007 | P1 | API | 库管 | 调开关 | 403（无 share:do） |
| FLG-008 | P0 | API | 销售 | 批量 5 台开启代理转发 | `{updated:5}`；逐台审计「批量调整代理转发」 |
| FLG-009 | P0 | API | 销售 | 批量中混 1 台非在库 | 409「只有在库可售设备能开启代理转发，请刷新后重选」，整批不变 |
| FLG-010 | P1 | API | 销售 | 批量关闭，含非在库设备 | 成功 |
| FLG-011 | P1 | API | 销售 | unitIds 空、101 个、含非字符串、带多余字段、shareAgent 非布尔 | 400「请选择 1～100 台设备并指定开关」 |
| FLG-012 | P2 | API | 销售 | unitIds 有重复 | 去重处理 |
| FLG-013 | P1 | API | 销售 | 批量含不存在 id | 404，整批回滚 |
| FLG-014 | P0 | 数据 | 全流程 | 售出、退货、送修、出借、归还后 | 分享开关全部关闭；复检通过后不自动恢复 |
| FLG-015 | P1 | 页面 | 销售 | 代理转发多选、全选本页 | 只能勾选在库可售；开启后显示“已开启代理转发” |

## 6.4 库存流水

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| LED-001 | P0 | 数据 | 全流程 | 一台设备走入库→销售→退货→复检→送修→复检→出借→归还→复检 | 每次状态变化一条流水，from/to 首尾相接，含单号、操作人、时间、原因 |
| LED-002 | P1 | API | 老板 | `GET /units/:id/ledger` 分页 | 倒序；total 正确 |
| LED-003 | P1 | API | 老板 | 设备不存在 | 404「设备不存在」 |
| LED-004 | P1 | 数据 | 全流程 | 改价 | 不写流水（只写审计），状态未变 |

## 6.5 复检

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| CHK-001 | P0 | API | 库管 | recheck 状态取 recheck-form | 返回模板快照字段、当前值、inspectionVersion；不含 supplier |
| CHK-002 | P1 | API | 库管 | 非 recheck 状态取表单或提交 | 409「设备不在待复检状态」 |
| CHK-003 | P0 | API | 库管 | 通过 | status→in_stock；分享开关保持全关；ledger recheck→in_stock；审计「库存复检」 |
| CHK-004 | P1 | API | 库管 | 不通过 | 保持 recheck；新增一条 inspection，ledger recheck→recheck |
| CHK-005 | P1 | API | 库管 | result 非法 | 400「复检结论无效」 |
| CHK-006 | P1 | API | 库管 | 不填说明 | 400「复检说明格式无效」 |
| CHK-007 | P0 | API | 库管 | 旧 inspectionVersion | 409「复检记录已更新，请重新加载后核对」 |
| CHK-008 | P0 | 并发 | 两名库管 | 同时提交复检 | 一个成功，另一个 409 |
| CHK-009 | P1 | API | 库管 | attributes 为数组 | 400「复检参数无效」 |
| CHK-010 | P0 | API | 库管 | 修改 supplier、未定义字段、modelId | 400「复检不能修改型号、货源或未定义字段」 |
| CHK-011 | P0 | API | 无 internalNote 权限者 | 修改内部字段 | 403「无权修改该复检字段」 |
| CHK-012 | P0 | API | 库管 | refurbishment=正在整备 且通过 | 400「整备未完成，不能复检通过」 |
| CHK-013 | P1 | API | 库管 | 改完机况后通过 | attributes 更新；模板快照不变 |
| CHK-014 | P1 | API | 库管 | 更新图片字段 | unit_files 替换；未提交的图片字段保持 |
| CHK-015 | P0 | API | 销售 | 调复检 | 403 |
| CHK-016 | P1 | API | 库管 | 表单中他人内部凭证 | 在 hiddenKeys 中；提交时保留，不被清空 |
| CHK-017 | P1 | 页面 | 库管 | 退货后设备→复检页 | 沿用入库快照，隐藏凭证不可覆盖 |

## 6.6 标签

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| LBL-001 | P1 | API | 库管 | `GET /units/:id/label` | 型号、存储、成色、零售价、qrcodeText=设备 id、imeiMasked；无成本 |
| LBL-002 | P1 | API | 销售 | 调用 | 403 |
| LBL-003 | P2 | 页面 | 库管 | 点“打印标签” | 当前提示“打印机对接待实现”，不假装成功 |
| LBL-004 | 待开发 | 真机 | 库管 | 蓝牙连接打印机、打印、批量打印、断连重连 | 功能实现后补预期 |
