# 13 代理

涉及接口：`POST /agent/applications`、`GET /agent/me`、`GET /agent/invite`、`GET /agent/units`、`PUT /agent/units/:id/markup`、`GET /agent/overview`、`GET /agent/orders`、`GET /agent/commissions`、`GET/PUT /admin/agent-settings`、`GET /admin/agent-applications`、`GET /admin/agents`、`POST /admin/agent-applications/:id/review`、`PATCH /admin/agents/:id`、`GET /admin/agent-orders`、`GET /admin/agent-earnings`、`POST /admin/agent-earnings/settle`
涉及页面：`pages/agent-landing`、`agent/apply|center|markup|orders|commission|invite`、`staff/agents/review|orders|settlement`

规则：加价归代理；固定金额上限；分享价=代理底价+加价；按单记账线下转账；只做一级邀请；锁库默认 30 分钟（`AGENT_LOCK_MINUTES`，5～1440）。

## 13.1 申请

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGA-001 | P0 | API | 顾客 | 提交：姓名、手机、地区、agreed=true | status=pending；审计「提交代理申请」 |
| AGA-002 | P0 | API | 顾客 | agreed≠true | 400「请先阅读并同意代理协议」 |
| AGA-003 | P1 | API | 顾客 | 手机不合法 | 400「请填写11位手机号」 |
| AGA-004 | P1 | API | 顾客 | 未知字段 | 400「申请参数无效」 |
| AGA-005 | P0 | API | 员工 | 申请 | 403「员工账号不能申请代理」 |
| AGA-006 | P1 | API | 未登录 | 申请 | 401「请先登录」 |
| AGA-007 | P1 | API | 待审核者 | 重复申请 | 409「申请正在审核中」 |
| AGA-008 | P1 | API | 已通过者 | 再次申请 | 409「你已经是代理」 |
| AGA-009 | P1 | API | 已停用者 | 再次申请 | 409「代理资格已停用，请联系门店」 |
| AGA-010 | P1 | API | 被拒绝者 | 重新申请 | status=pending；清空原审核信息 |
| AGA-011 | P0 | API | 顾客 | 有效邀请码（小写也可） | inviter_id 绑定 |
| AGA-012 | P1 | API | 顾客 | 无效码、停用代理的码、自己的码 | 400「邀请码无效」 |
| AGA-013 | P1 | API | 顾客 | `GET /agent/me` 未申请 | `{status:"none"}` |
| AGA-014 | P0 | 页面 | 顾客 | 落地页：优势、规则、申请入口 | 文案含无需囤货、无需投资、一键转发 |
| AGA-015 | P1 | 页面 | 顾客 | 不勾协议 | 不能提交 |
| AGA-016 | P1 | 页面 | 顾客 | 地区选择器 | 必选 |

## 13.2 审核与管理

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGR-001 | P0 | API | 老板 | 通过，留空上限 | active；markup_max=默认值；生成 8 位邀请码；users.role=agent；审计「通过代理申请」 |
| AGR-002 | P0 | API | 老板 | 通过，单独设上限 | 用单独值 |
| AGR-003 | P1 | API | 老板 | 上限超过 100000 元 | 400「加价上限过大」 |
| AGR-004 | P1 | API | 老板 | 拒绝，填说明 | rejected；审计「拒绝代理申请」；申请人看到说明 |
| AGR-005 | P1 | API | 老板 | 不填说明 | 400「审核说明格式无效」 |
| AGR-006 | P1 | API | 老板 | approve 非布尔 | 400「请选择通过或拒绝」 |
| AGR-007 | P1 | API | 老板 | 申请不存在 | 404「申请不存在」 |
| AGR-008 | P0 | API | 老板 | 重复审核或旧 version | 409「申请已处理或已更新，请刷新」 |
| AGR-009 | P0 | API | 销售 | 审核 | 403 |
| AGR-010 | P1 | API | 老板 | 列表 status 非法 | 400「代理状态无效」 |
| AGR-011 | P1 | API | 老板 | 查 admin/agents 按 keyword、status | 正确 |
| AGR-012 | P0 | API | 老板 | 停用代理，填原因 | disabled；agent_status 同步；审计「调整代理资格或加价上限」 |
| AGR-013 | P1 | API | 老板 | 恢复代理 | active；旧分享按有效期判断 |
| AGR-014 | P0 | API | 老板 | 调整单个上限 | 只影响该代理 |
| AGR-015 | P1 | API | 老板 | 未知字段、status 非法 | 400「参数无效」/「代理状态无效」 |
| AGR-016 | P1 | API | 老板 | 操作 pending/rejected/不存在 | 404「代理不存在」 |
| AGR-017 | P1 | API | 老板 | 旧 version | 409「代理资料已更新，请刷新」 |
| AGR-018 | P0 | API | 老板 | 修改默认上限，填原因 | version+1；审计「调整代理默认加价上限」 |
| AGR-019 | P1 | API | 老板 | 默认上限旧 version | 409「设置已被他人修改，请刷新」 |
| AGR-020 | P1 | API | 老板 | 配置 AGENT_LOCK_MINUTES=4、1441 | 503「代理下单锁库时长配置无效」 |
| AGR-021 | P0 | API | 被停用代理 | 调代理接口 | 403「仅已审核通过的代理可使用」 |
| AGR-022 | P1 | 页面 | 老板 | 审核页 | 通过、拒绝、停用都要原因；上限留空用默认值 |

## 13.3 可转发库存与加价

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGU-001 | P0 | API | 代理 | `GET /agent/units` | 只含 in_stock、自有、shareAgent=true |
| AGU-002 | P0 | API | 代理 | 响应字段 | 无 cost、supplier、完整串码、代理底价；有 sharePrice、markup、markupMax、aboveRetail |
| AGU-003 | P0 | API | 代理 | 加价 300（上限 500） | sharePrice=底价+300；审计「代理设置加价」 |
| AGU-004 | P0 | API | 代理 | 加价等于上限 | 通过 |
| AGU-005 | P0 | API | 代理 | 超上限 | 400「加价不能超过上限 ¥500」 |
| AGU-006 | P0 | API | 代理 | 负数、三位小数 | 400 |
| AGU-007 | P0 | API | 代理 | body 带 sharePrice、agentBase | 400「加价参数无效」 |
| AGU-008 | P0 | API | 代理 | 设备未开放转发、非在库 | 409「该设备当前不允许代理转发」 |
| AGU-009 | P1 | API | 代理 | 分享价高于零售价 | 允许；aboveRetail=true，页面提示 |
| AGU-010 | P0 | API | 顾客 | 调代理接口 | 403 |
| AGU-011 | P0 | API | 代理 A | 看不到代理 B 的加价、订单、收益 | 隔离 |
| AGU-012 | P0 | API | 代理 | 上限下调到低于已设加价后生成分享 | 见 README 疑点 Q2；预期应拒绝或按新上限 |
| AGU-013 | P1 | 页面 | 代理 | 加价管理 | 只提交 markup，分享价由服务端返回 |

## 13.4 代理分享与下单锁库

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGS-001 | P0 | API | 代理 | 生成 agent 渠道分享 | 快照 price=底价+加价，markup 一并保存 |
| AGS-002 | P0 | API | 顾客 | 打开代理分享 | 看到分享价 |
| AGS-003 | P0 | API | 顾客 | 带 X-Channel 下单 `/shop/orders` | kind=order；设备→locked；agent_orders 快照底价、加价、分享价、版本；ledger in_stock→locked；审计「代理链接下单」 |
| AGS-004 | P0 | API | 顾客 | 不带分享下单 | 400「仅代理分享链接支持下单」 |
| AGS-005 | P0 | API | 代理 | 用自己的链接下单 | 400「不能通过自己的分享链接下单」 |
| AGS-006 | P1 | API | 顾客 | 下单无 unitId | 400「请选择要下单的设备」 |
| AGS-007 | P0 | API | 顾客 | 设备不在本分享 | 404「商品不在本分享内」 |
| AGS-008 | P0 | 并发 | 两名顾客 | 同时下单同一台 | 只有一单锁定，另一方 409 或 410，不产生第二条锁 |
| AGS-009 | P0 | API | 顾客 2 | 已锁定后下单 | 失败：分享校验 410「分享中的设备已下架或不可售」；绕过分享校验的并发情形 409「该设备已被锁定或售出」 |
| AGS-010 | P0 | API | 顾客 | 改价后下单 | 410「商品价格已变化，请重新获取分享」 |
| AGS-011 | P0 | API | 顾客 | 快照底价+加价≠分享价（数据不一致） | 410「代理价已变化，请重新获取分享」 |
| AGS-012 | P0 | API | 顾客 | 同 requestKey 重复下单 | 只一条 |
| AGS-013 | P0 | API | 顾客 | 取消订单 | 设备→in_stock；状态 released；原因“顾客取消代理订单” |
| AGS-014 | P0 | API | 销售 | 关闭订单 | 释放；原因含“门店关闭代理订单” |
| AGS-015 | P0 | API | 系统 | 到期扫描（每 60 秒，或访问代理订单接口时） | 设备回 in_stock；原因“下单锁定到期自动释放” |
| AGS-016 | P0 | 并发 | 系统 + 收银 | 到期释放与成交同时 | 只有一个结果 |
| AGS-017 | P1 | API | 系统 | 锁定期内设备不可改价、不可出借、不可送修、不可普通收银 | 各返回 409 |
| AGS-018 | P1 | 页面 | 顾客 | 代理详情“立即下单” | 显示代理分享价；提示锁定时长 |
| AGS-019 | P0 | API | 代理 | `GET /agent/orders` | 顾客姓名、手机脱敏；有 markup |
| AGS-020 | P1 | API | 代理 | status=xxx | 400「订单状态无效」 |
| AGS-021 | P0 | API | 销售 | `GET /admin/agent-orders` | 无 markup、无代理底价 |
| AGS-022 | P0 | API | 财务 | 同上 | 有 markup |
| AGS-023 | P1 | API | 老板 | 按 agentId、status 筛选 | 正确 |

## 13.5 成交与收益

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGE-001 | P0 | API | 销售 | 代理订单收银，channel=agent + customerRequestId | 按分享价成交；agent_order=sold；生成收益=加价快照；审计「代理订单成交记收益」 |
| AGE-002 | P0 | API | 销售 | 代理订单传 price | 400「代理订单按分享价成交，不能改价」 |
| AGE-003 | P0 | API | 销售 | channel=agent 但无 requestId 或设备不符 | 400「代理订单与设备不符」 |
| AGE-004 | P0 | API | 销售 | 锁已释放 | 409「代理订单锁定已释放，不能按代理价成交」 |
| AGE-005 | P0 | API | 销售 | 锁已到期未被扫描 | 409「代理订单锁定已到期，请让顾客重新下单」 |
| AGE-006 | P0 | API | 销售 | channel=retail 卖锁定设备 | 409「设备不可售，请刷新库存」 |
| AGE-007 | P0 | 数据 | 老板 | 成交后改底价、改上限 | 收益快照不变 |
| AGE-008 | P0 | API | 代理 | `GET /agent/commissions` | 只有本人；summary 待转账、已转账正确 |
| AGE-009 | P1 | API | 代理 | status=xxx | 400「收益状态无效」 |
| AGE-010 | P1 | API | 代理 | overview | 今日访问、PV、分享次数、锁定单、成交单、收益合计；visits 只算本人分享 |
| AGE-011 | P0 | API | 财务 | 标记已转账 1～100 条，填说明 | settled；审计「标记代理收益已转账」 |
| AGE-012 | P0 | API | 财务 | 不填说明 | 400「转账说明格式无效」 |
| AGE-013 | P1 | API | 财务 | ids 空、超 100、含非字符串 | 400「请选择1～100条收益记录」 |
| AGE-014 | P1 | API | 财务 | id 不存在 | 404「收益记录不存在」，整批不变 |
| AGE-015 | P0 | API | 财务 | 含已转账或已冲回 | 409「所选记录已转账或已冲回，请刷新」，整批不变 |
| AGE-016 | P0 | 并发 | 两名财务 | 同时转账同一批 | 只有一方成功 |
| AGE-017 | P0 | API | 店长 | 标记转账 | 403（无 agent:settle） |
| AGE-018 | P0 | API | 财务 | 未转账收益的订单整机退货 | 收益→reversed；审计「退货冲回代理收益」 |
| AGE-019 | P0 | API | 财务 | 已转账收益的订单整机退货 | 新增 kind=reversal 负向记录，待转账相应扣减；审计「已转账收益退货生成冲回记录」 |
| AGE-020 | P0 | API | 财务 | 差价退款 | 不冲回收益（2026-11-04 定案） |
| AGE-021 | P0 | 数据 | 财务 | 只有负向记录时 | 待转账合计为负，页面正确显示 |
| AGE-022 | P1 | 页面 | 财务 | 转账页勾选 | 走二次确认；从对账点入时只看该代理，可切回全部 |
| AGE-023 | P1 | 页面 | 代理 | 收益明细 | 成交、冲回、已转账状态清晰 |

## 13.6 邀请

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AGI-001 | P1 | API | 代理 | `GET /agent/invite` | 邀请码；直属成员姓名脱敏；最多 200 |
| AGI-002 | P0 | API | 下线代理 | 下线成交后 | 上级无任何分润（只做一级） |
| AGI-003 | P1 | API | 系统 | 邀请码冲突 10 次 | 503「邀请码生成失败，请重试」 |
| AGI-004 | P1 | 页面 | 代理 | `open-type="share"` 邀请卡片 | 卡片不含价格 |
| AGI-005 | 待开发 | 页面 | 代理 | 邀请海报成图 | 依赖正式小程序码 |
