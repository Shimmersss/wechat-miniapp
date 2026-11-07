# 09 维修与配件

涉及接口：`GET /repair-orders/options`、`POST /repair-orders`、`GET /repair-orders`、`GET /repair-orders/board`、`GET/PUT /repair-orders/:id`、`POST /repair-orders/:id/quote`、`POST /repair-orders/:id/confirm`、`POST /repair-orders/:id/parts/issue`、`POST /repair-orders/:id/parts/return`、`POST /repair-orders/:id/payment`、`POST /repair-orders/:id/transition`、`GET /repair-orders/stats`、`GET/POST /repair-parts`、`POST /repair-parts/:id/receive`、`GET /repair-parts/:id/ledger`
涉及页面：`staff/repair/board|detail|edit|parts`

节点：`pending_check → checking → pending_confirm → repairing → pending_pickup → completed`；`pending_check/checking/pending_confirm` 可 `cancelled`；`pending_confirm` 可退回 `checking`。
来源：external（店外机）、inventory（本店机）。所有写操作带 requestKey + version + reason。

## 9.1 开单

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPO-001 | P0 | API | 工程师 | 店外机开单（型号、串码、联系人、电话、故障） | status=pending_check；engineer=本人；串码占用 repair_external_slots；审计「创建维修单」 |
| RPO-002 | P0 | API | 店长 | 开单并指派工程师 A | engineer=A |
| RPO-003 | P0 | API | 工程师 A | 开单指派工程师 B | 403「不能指派其他工程师」 |
| RPO-004 | P1 | API | 店长 | 指派已停用、非工程师账号 | 400「工程师账号不可用」 |
| RPO-005 | P0 | API | 任意 | body 含 password 或未知字段 | 400「提交参数无效；不保存开机密码」 |
| RPO-006 | P1 | API | 工程师 | kind 非 external/inventory | 400「维修来源无效」 |
| RPO-007 | P1 | API | 工程师 | 店外机电话不合法 | 400「请填写11位联系电话」 |
| RPO-008 | P1 | API | 工程师 | 故障为空、超 2000 字 | 400「故障格式无效」 |
| RPO-009 | P1 | API | 工程师 | 店外机传 unitId | 400「外部送修不得关联本店库存」 |
| RPO-010 | P1 | API | 工程师 | 15 位数字串码校验位错 | 400「IMEI校验位无效」 |
| RPO-011 | P2 | API | 工程师 | 非 15 位序列号（字母+数字） | 允许，转大写保存 |
| RPO-012 | P0 | API | 工程师 | 店外机串码属于在库设备 | 409「该串码属于门店业务库存，请从库存档案发起」 |
| RPO-013 | P1 | API | 工程师 | 店外机串码属于已售或已归还设备 | 允许（售后机） |
| RPO-014 | P0 | 并发 | 工程师 | 同一串码同时开两张外部单 | 只开一单；取消后才释放 |
| RPO-015 | P0 | API | 工程师 | 同 requestKey 同内容重试 | 返回原单 |
| RPO-016 | P0 | API | 工程师 | 同 requestKey 不同内容 | 409「提交标识内容冲突」 |
| RPO-017 | P0 | API | 工程师 | 本店机送修 | units→repairing；分享全关；ledger in_stock→repairing；故障不含顾客信息 |
| RPO-018 | P0 | API | 工程师 | 非 in_stock 设备、借入设备送修 | 409「只有本店自有可售设备能从库存发起送修」 |
| RPO-019 | P1 | API | 工程师 | 附件：10 张、重复、公开文件 | 400「每组附件最多9张」/「附件重复」/「维修附件须单独上传为内部图片」 |
| RPO-020 | P1 | API | 工程师 | 引用入库凭证、借还附件、收款凭证 | 400「入库凭证不能用作维修附件」「借还附件不能作为维修凭证」「收款凭证不能作为维修凭证」 |
| RPO-021 | P0 | API | 工程师 | 引用无权读取的内部附件 | 403「无权引用此附件」 |
| RPO-022 | P1 | API | 工程师 | expectedAt 非法 | 400「预计完成日期格式无效」 |
| RPO-023 | P0 | 数据 | 全部 | 搜库、接口、页面 | 全程没有开机密码字段；options.passwordStorage=false |
| RPO-024 | P1 | 页面 | 工程师 | 开单页拍外观照片 | 走 internal 上传；提交后看板“待检测”列最上方 |
| RPO-025 | P1 | 页面 | 工程师 | 响应丢失后重试 | 只一单 |

## 9.2 查询与范围

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPQ-001 | P0 | API | 工程师 A | 查看工程师 B 的单 | 404「维修单不存在」 |
| RPQ-002 | P0 | API | 工程师 A | 修改工程师 B 的单 | 404 |
| RPQ-003 | P1 | API | 工程师 | 列表、看板 | 只含本人单 |
| RPQ-004 | P1 | API | 店长/财务 | 列表、看板 | 全部单 |
| RPQ-005 | P1 | API | 店长 | 按 status、engineerId、keyword、waitingParts、overdue 筛选 | 正确 |
| RPQ-006 | P1 | API | 店长 | status=xxx | 400「维修状态无效」 |
| RPQ-007 | P1 | API | 店长 | overdue=true | 今天到期不算；终态不算；按北京时间 |
| RPQ-008 | P1 | API | 店长 | 看板 | 未完结单优先、新单在前；终态排后；hasMore 正确 |
| RPQ-009 | P1 | API | 销售 | 维修接口 | 403「无权限执行该操作」 |
| RPQ-010 | P1 | API | 工程师 | options | engineers 只含本人；店长含全部 |
| RPQ-011 | P0 | API | 工程师 | 查看详情 | 串码按权限脱敏；无成本；无费用凭证链接 |
| RPQ-012 | P1 | API | 维修单不存在 | 任意接口 | 404「维修单不存在」 |
| RPQ-013 | P1 | 页面 | 店长 | 看板列卡片 | 超期、待确认、待配件突出显示 |

## 9.3 检测、报价、确认

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPS-001 | P0 | API | 工程师 | pending_check→checking | 成功，时间线新增 |
| RPS-002 | P0 | API | 工程师 | pending_check→repairing 等跨节点 | 409「不允许跨节点推进」 |
| RPS-003 | P0 | API | 店长 | 节点外报价（pending_check、repairing） | 409「当前节点不能报价」 |
| RPS-004 | P0 | API | 店长 | checking 报价 800 | quote_version+1；confirmed_version 清空 |
| RPS-005 | P1 | API | 工程师（无 repair:quote） | 报价 | 403 |
| RPS-006 | P0 | API | 工程师 | 无检测结果或无报价推到待确认 | 400「请先保存检测结果并由有权限人员报价」 |
| RPS-007 | P0 | API | 工程师 | 确认：传当前 quoteVersion + confirmed=true | confirmed_version=当前版本 |
| RPS-008 | P0 | API | 工程师 | 确认用旧 quoteVersion、confirmed=false、非待确认节点 | 409「请核对当前报价版本并记录已获确认」 |
| RPS-009 | P0 | API | 店长 | 确认后改价 | 旧确认失效；推进 repairing 409「当前报价尚未确认」 |
| RPS-010 | P0 | API | 店长 | 新报价低于已收净额 | 400「新报价低于已收净额，请先办理退款」 |
| RPS-011 | P1 | API | 店长 | 零元报价 | 允许；可继续流程 |
| RPS-012 | P1 | API | 店长 | 待确认退回检测 | status=checking；confirmed_version 清空 |
| RPS-013 | P0 | API | 工程师 | 本店机确认（无 repair:assign） | 403 |
| RPS-014 | P0 | API | 任意 | version 过期 | 409「维修单已更新，请刷新核对」 |
| RPS-015 | P0 | API | 任意 | 操作 requestKey 同内容重放 | 不重复执行，返回当前视图 |
| RPS-016 | P0 | API | 任意 | 操作 requestKey 不同内容 | 409「操作标识内容冲突」 |
| RPS-017 | P1 | API | 店长 | 不填 reason | 400「处理说明格式无效」 |
| RPS-018 | P0 | 并发 | 两人 | 同版本同时操作 | 一个成功，一个 409；不同维修单互不阻塞 |
| RPS-019 | P1 | 页面 | 店长 | 打开旧详情改报价 | 版本冲突提示，刷新后可报价 |

## 9.4 编辑

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPE-001 | P1 | API | 工程师 | 更新故障、检测结果、待配件 | 成功 |
| RPE-002 | P1 | API | 工程师 | 终态编辑 | 409「已结束维修不能编辑」 |
| RPE-003 | P0 | API | 工程师 | 改联系人、电话、工程师 | 403（需 repair:assign） |
| RPE-004 | P1 | API | 店长 | 本店机改联系人 | 400「本店维修不登记顾客联系资料」 |
| RPE-005 | P1 | API | 店长 | 电话不合法 | 400「联系电话格式无效」 |
| RPE-006 | P1 | API | 工程师 | waitingParts 非布尔 | 400「待配件标记无效」 |
| RPE-007 | P1 | API | 工程师 | 无任何改动 | 400「没有需保存的改动」 |
| RPE-008 | P1 | API | 工程师 | 单组附件累计超 9 张 | 400「每组维修附件最多9张」 |
| RPE-009 | P0 | API | 工程师 | 把费用凭证转作普通附件 | 400「费用凭证不能转作普通维修附件」 |
| RPE-010 | P0 | API | 非分派、无 assign 的工程师（有查看权的自定义角色） | 写入 | 403「仅可处理本人获分派工单」 |

## 9.5 配件

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| PRT-001 | P1 | API | 采购 | 新增配件（SKU、名称、单位） | 成功；审计「新增维修配件」 |
| PRT-002 | P1 | API | 采购 | 同 SKU 同内容重提 | 返回原配件（幂等） |
| PRT-003 | P1 | API | 采购 | 同 SKU 不同名称 | 409「配件SKU已存在」 |
| PRT-004 | P0 | API | 店长（默认无 cost 字段） | 新增或入库配件 | 403「无权登记配件成本」 |
| PRT-005 | P0 | API | 采购 | 配件入库：10 件，单价 50 | quantity+10；stock_value+500；version+1 |
| PRT-006 | P1 | API | 采购 | 入库重放、内容不同 | 不重复入库 / 409「提交标识内容冲突」 |
| PRT-007 | P1 | API | 采购 | 旧 version、已停用配件 | 409「配件或版本已变化」 |
| PRT-008 | P1 | API | 采购 | 总量超 1000000 | 400「库存数量超出范围」 |
| PRT-009 | P1 | API | 采购 | 配件不存在 | 404「配件不存在」 |
| PRT-010 | P0 | API | 工程师 | `GET /repair-parts` | 只看数量，无 stockValue |
| PRT-011 | P0 | API | 工程师 | ledger | 非本人单的 orderId、issueId 不返回；无成本 |
| PRT-012 | P0 | API | 工程师 | repairing 节点领用 3 件 | quantity-3；成本按加权平均分摊 |
| PRT-013 | P0 | API | 工程师 | 非 repairing 领用 | 409「仅维修中可领用配件」 |
| PRT-014 | P0 | API | 工程师 | 领用超库存 | 409「配件库存不足」 |
| PRT-015 | P0 | 并发 | 两名工程师 | 同时领走最后一件 | 只有一方成功，库存不为负 |
| PRT-016 | P0 | 数据 | 工程师 | 领用清空库存 | stock_value 精确归零，无分钱误差 |
| PRT-017 | P0 | API | 工程师 | 部分退料 | 按原领用成本比例退回，守恒 |
| PRT-018 | P0 | API | 工程师 | 退料超原领用 | 400「退料超过原领用数量」 |
| PRT-019 | P1 | API | 工程师 | 领用记录不属于本单 | 404「领用记录不存在」 |
| PRT-020 | P1 | API | 工程师 | pending_pickup 可退料；其他节点 | 其他节点 409「当前节点不能退料」 |
| PRT-021 | P0 | API | 工程师 | 领料请求重放 | 不重复扣料 |
| PRT-022 | P1 | 页面 | 工程师 | 配件页 | 不显示成本 |

## 9.6 收退款与费用

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPP-001 | P0 | API | 财务 | 店外机收款 500（报价 800） | 已收 500 |
| RPP-002 | P0 | API | 财务 | 收款累计超报价、未报价、已取消 | 400「未报价或收款超过报价」 |
| RPP-003 | P0 | API | 财务 | 退款 200 | 已收 300 |
| RPP-004 | P0 | API | 财务 | 退款超已收净额 | 400「退款超过已收净额」 |
| RPP-005 | P1 | API | 财务 | confirmed≠true、kind 或 method 非法 | 400「请选择收支类型/方式并确认已实际办理」 |
| RPP-006 | P1 | API | 财务 | 金额 0 | 400「金额须大于零」 |
| RPP-007 | P0 | API | 无 sales:refund 的收款人 | 退款 | 403 |
| RPP-008 | P0 | API | 财务 | 费用 expense | 记录；计入费用 |
| RPP-009 | P0 | API | 无 cost 字段者（店长默认） | 登记费用 | 403「无权登记维修成本」 |
| RPP-010 | P1 | API | 财务 | 费用退回超已登记 | 400「超过可退维修费用」 |
| RPP-011 | P0 | API | 财务 | 本店机收款、退款 | 400「本店维修不登记对客收退款」 |
| RPP-012 | P0 | API | 财务 | 本店机终态后登记费用 | 409「本店维修成本已归档，不能重复调整」 |
| RPP-013 | P0 | API | 财务 | 重放收款 | 只记一次 |
| RPP-014 | P1 | API | 财务 | 费用凭证 | 工程师和店长无链接；旧签名失效 |
| RPP-015 | P1 | 页面 | 财务 | 收款页 | 需确认已实际办理 |

## 9.7 完工、取消

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPF-001 | P0 | API | 工程师 | repairing→pending_pickup，填结果 | 成功 |
| RPF-002 | P1 | API | 工程师 | 不填结果 | 400「维修结果格式无效」 |
| RPF-003 | P0 | API | 工程师 | 待配件时推进 | 400「仍在等待配件」 |
| RPF-004 | P0 | API | 工程师 | 店外机未结清取机 | 409「请先结清当前维修报价」 |
| RPF-005 | P0 | API | 工程师 | 店外机取机：交接人、凭证、质保 90 天 | completed；串码占用释放；completed_at 写入 |
| RPF-006 | P0 | API | 工程师 | 不传凭证 | 400「请上传取机/交接凭证」 |
| RPF-007 | P1 | API | 工程师 | 不填交接人 | 400「取机/交接人格式无效」 |
| RPF-008 | P1 | API | 工程师 | 质保 -1、3651、非整数 | 400「维修质保天数需为 0～3650 的整数」 |
| RPF-009 | P0 | API | 工程师 | 本店机完工 | units→recheck（不直接可售）；ledger repairing→recheck；生成成本归集 |
| RPF-010 | P0 | 数据 | 财务 | capitalize 策略 | 新成本=原成本+配件+费用 |
| RPF-011 | P0 | 数据 | 财务 | separate 策略 | 单位成本不变；成本单列 |
| RPF-012 | P1 | API | 工程师 | 未知策略 | 503「本店维修成本处理尚未配置」，事务回滚 |
| RPF-013 | P0 | API | 工程师 | 本店机单对应设备状态被改 | 409「本店设备维修状态已变化」 |
| RPF-014 | P0 | API | 店长 | 已收款未退取消 | 409「请先退清已收款」 |
| RPF-015 | P0 | API | 店长 | 已领配件未退取消 | 409「请先核对领用配件」 |
| RPF-016 | P0 | API | 店长 | 店外机取消 | cancelled；串码释放，可再入库 |
| RPF-017 | P0 | API | 店长 | 本店机取消 | 设备→recheck；需独立复检 |
| RPF-018 | P0 | API | 店长 | repairing 直接取消 | 409「不允许跨节点推进」 |
| RPF-019 | P0 | 数据 | 工程师 | 成本只记一次 | 重放完工不重复累加 |
| RPF-020 | P0 | 页面 | 工程师 | 本店机送修期间 | 不可售、不可代理转发 |

## 9.8 统计

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| RPT-001 | P1 | API | 老板 | `GET /repair-orders/stats` | 开单量、完成率、平均时长、收入、配件成本、费用、毛利 |
| RPT-002 | P1 | API | 老板 | 空范围 | 全部补零 |
| RPT-003 | P0 | API | 工程师 | stats | 只统计本人单；成本利润按权限裁剪 |
| RPT-004 | P1 | API | 老板 | 按 engineerId、来源筛选 | 生效 |
| RPT-005 | P0 | 数据 | 老板 | 本店维修 | 不计对客收入；成本单列 |
