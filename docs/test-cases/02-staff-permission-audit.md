# 02 员工、角色权限、字段裁剪、操作日志

涉及接口：`GET/POST /staff`、`PATCH /staff/:id`、`POST /staff/:id/unbind`、`GET /roles`、`PUT /roles/:key`、`GET /audit-logs`、`GET /audit-logs/filters`
涉及页面：`staff/staff/index`、`staff/staff/roles`、`staff/audit/index`

## 2.1 默认权限矩阵（逐格验证）

以 `constants/roles.js` 的 `ROLE_PERMISSIONS` 为准。对下表每一格，用该角色调用代表接口：✓ 不返回 403，✗ 返回 403「无权限执行该操作」。例外：profit:view 一行看响应里有没有 profit 字段，不看 403；stats:view 一行的接口持 dashboard:view 也能读，“仅 dashboard”表示能调用但统计页入口按 stats:view 控制。

| 权限点 | 代表接口 | 老板 | 店长 | 采购 | 库管 | 销售 | 工程师 | 财务 |
|---|---|---|---|---|---|---|---|---|
| dashboard:view | `GET /staff/dashboard` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| profit:view | `GET /stats/overview` 含 profit | ✓ | ✓ 但字段裁剪 | ✗ | ✗ | ✗ | ✗ | ✓ |
| purchase:manage | `POST /purchase-orders` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| supplier:view | `GET /suppliers` | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| acceptance:do | `POST /purchase-orders/:id/acceptance` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| inbound:do | `POST /inbound/units` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| template:manage | `POST /models` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| inventory:view | `GET /units` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| price:edit | `PATCH /units/:id/price` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| label:print | `GET /units/:id/label` | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| stocktake:do | `POST /stocktake-sessions` | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| sales:create | `POST /sales-orders` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| sales:refund | `POST /sales-orders/:id/refund` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| repair:handle | `POST /repair-orders` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| repair:quote | `POST /repair-orders/:id/quote` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| repair:assign | `PUT /repair-orders/:id` 改工程师 | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| repair:cash | `POST /repair-orders/:id/payment` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| parts:manage | `POST /repair-parts` | ✓ | ✓ 但无成本字段时 403 | ✓ | ✗ | ✗ | ✗ | ✗ |
| loan:manage | `POST /loans` | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| share:do | `POST /share/links` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| consult:manage | `GET /customer-requests` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| agent:review | `POST /admin/agent-applications/:id/review` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| agent:settle | `POST /admin/agent-earnings/settle` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| stats:view | `GET /stats/trend`（另需 dashboard 可读） | ✓ | ✓ | 仅 dashboard | 仅 dashboard | 仅 dashboard | 仅 dashboard | ✓ |
| data:export | `POST /stats/export` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| staff:manage | `GET /staff` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| audit:view | `GET /audit-logs` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| PERM-001 | P0 | API | 7 个员工角色 | 按上表逐格调用（27×7 共 189 格） | 全部符合 |
| PERM-002 | P0 | API | 顾客/同行/代理 | 依次调用上表全部接口 | 全部 401 或 403；无一返回业务数据 |
| PERM-003 | P0 | API | 未登录 | 依次调用上表全部接口 | 全部 401「请先登录」 |
| PERM-004 | P0 | API | 微信会话下的老板 | 只走静默登录后调用上表接口 | 全部 403，员工权限只来自短信会话 |

## 2.2 敏感字段裁剪（响应中“字段不存在”，不是遮挡）

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| FIELD-001 | P0 | API | 老板 | `GET /units/:id` | 含 cost、supplier、internalNote、imei1/2、wholesale、agentBase |
| FIELD-002 | P0 | API | 店长 | 同上 | 无 cost；含 supplier、internalNote、完整串码、wholesale、agentBase |
| FIELD-003 | P0 | API | 采购 | 同上 | 含 cost、supplier、internalNote、完整串码、agentBase；无 wholesale |
| FIELD-004 | P0 | API | 库管 | 同上 | 含 internalNote、完整串码；无 cost、supplier、wholesale、agentBase |
| FIELD-005 | P0 | API | 销售 | 同上 | 仅 imeiMasked + wholesale；无 cost、supplier、internalNote、完整串码、agentBase |
| FIELD-006 | P0 | API | 工程师 | 同上 | 仅 imeiMasked；无 cost、supplier、internalNote、wholesale、agentBase |
| FIELD-007 | P0 | API | 财务 | 同上 | 含 cost；无 supplier、internalNote、完整串码、wholesale、agentBase |
| FIELD-008 | P0 | API | 销售 | `GET /units` 列表 | 每行都不含 cost；summary 不含 costTotal |
| FIELD-009 | P0 | API | 财务 | `GET /units` | summary 含 costTotal |
| FIELD-010 | P0 | API | 销售 | `GET /sales-orders/:id` | 无 profit，items 无 cost |
| FIELD-011 | P0 | API | 老板 | 同上 | 有 profit，items 有 cost |
| FIELD-012 | P0 | API | 老板把销售的 profit 字段打开但不给 profit:view | 同上 | 仍无 profit（字段权限与权限点同时满足才返回） |
| FIELD-013 | P1 | 页面 | 销售 | 库存/销售详情查看被裁字段 | 显示“无权限查看”，不显示 0、空白或 undefined |
| FIELD-014 | P1 | API | 库管 | `GET /units/:id` 的 parameters | 不含 supplier；receipt 仅在本人上传时可见 |
| FIELD-015 | P0 | API | 销售 | keyword 用部分数字串搜库存 | 400「串码查询请扫描完整 IMEI」，不能靠模糊搜索反推串码 |
| FIELD-016 | P1 | API | 老板 | 同样部分数字搜索 | 正常执行，返回 200 |
| FIELD-017 | P0 | 页面 | 任意 | 点金额遮挡后抓包 | 接口仍按权限返回，遮挡只影响屏幕；切换后全页金额隐藏 |

## 2.3 员工管理

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STAFF-001 | P0 | API | 老板 | 新增销售（姓名、11 位手机、原因） | 成功；审计「新增员工」含原因 |
| STAFF-002 | P1 | API | 老板 | 手机号已是员工 | 409「该手机号已是员工」 |
| STAFF-003 | P1 | API | 老板 | 手机号不合法 | 400「请填写11位手机号」 |
| STAFF-004 | P1 | API | 老板 | roleKey 为 customer、peer、不存在的值 | 400「角色无效」 |
| STAFF-005 | P1 | API | 老板 | body 带未定义字段（如 password） | 400「员工参数无效」 |
| STAFF-006 | P1 | API | 老板 | 不填原因 | 400「调整原因格式无效」 |
| STAFF-007 | P0 | API | 店长 | 新增老板 | 403「仅老板可添加老板账号」 |
| STAFF-008 | P0 | API | 店长 | 修改老板账号、把别人改成老板 | 403「仅老板可修改老板账号或授予老板角色」 |
| STAFF-009 | P0 | API | 任意管理者 | 停用自己、改自己的角色 | 400「不能停用或更改自己的角色」 |
| STAFF-010 | P0 | 并发 | 两名在职老板 A、B | A 停用 B 与 B 停用 A 同时提交 | 至多一个成功，另一个 409「至少保留一名在职老板」，库里始终保留一名在职老板（见 README 疑点 Q5） |
| STAFF-010a | P1 | API | 两名在职老板 | A 停用 B 后，A 再改自己的角色 | 400「不能停用或更改自己的角色」，系统不会出现零老板 |
| STAFF-011 | P1 | API | 老板 | 用旧 version 修改 | 409「员工资料已更新，请刷新」 |
| STAFF-012 | P0 | API | 老板 | 停用员工 | 该员工全部会话立即删除；sms-code 不再发码 |
| STAFF-013 | P1 | API | 老板 | 恢复员工 | 审计「恢复员工」；需重新登录 |
| STAFF-014 | P0 | API | 老板 | 解绑员工微信 | staff.user_id 置空；会话清除；审计「解绑员工微信」 |
| STAFF-015 | P1 | API | 老板 | 解绑未绑定微信的员工 | 409「该员工尚未绑定微信」 |
| STAFF-016 | P1 | API | 老板 | 解绑自己 | 400「不能解绑自己的微信」 |
| STAFF-017 | P0 | API | 店长 | 解绑老板 | 403「仅老板可解绑老板账号」 |
| STAFF-018 | P1 | API | 老板 | 操作不存在的员工 | 404「员工不存在」 |
| STAFF-019 | P1 | API | 老板 | status=xxx 查询、修改 | 400「员工状态无效」 |
| STAFF-020 | P2 | API | 老板 | 按状态、角色、关键字筛选，翻页 | total 与分页正确 |
| STAFF-021 | P1 | 页面 | 老板 | 新增→改角色→停用→恢复→解绑 | 每步弹原因框；自己的账号不显示停用/解绑 |
| STAFF-022 | P1 | 页面 | 店长 | 打开员工页 | 角色选项无“老板”；老板账号不可操作 |

## 2.4 角色权限与字段可见性

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| ROLE-001 | P0 | API | 老板 | 给销售勾“成本价”可见并保存 | 销售下一次请求即可见 cost，无需重新登录 |
| ROLE-002 | P0 | API | 老板 | 取消销售的成本可见 | 下一次请求 cost 消失 |
| ROLE-003 | P0 | API | 店长 | `PUT /roles/sales` | 403「仅老板可调整角色权限」 |
| ROLE-004 | P0 | API | 老板 | `PUT /roles/boss` | 400「老板角色固定拥有全部权限，不能编辑」 |
| ROLE-005 | P1 | API | 老板 | `PUT /roles/customer`、`PUT /roles/xxx` | 404「角色不存在」 |
| ROLE-006 | P1 | API | 老板 | permissions 含未知权限点、visibleFields 含未知字段 | 400「权限点或字段无效」 |
| ROLE-007 | P1 | API | 老板 | 旧 version 保存 | 409「角色已被他人修改，请刷新」 |
| ROLE-008 | P0 | API | 老板 | 收回销售的 sales:create | 销售开单立即 403 |
| ROLE-009 | P0 | API | 老板 | 收回店长 supplier 字段可见后，店长访问供应商、建采购单、按供应商筛选 | 分别 403「无权限查看供应商」「无权限筛选供应商」 |
| ROLE-010 | P0 | API | 老板 | 收回工程师 repair:handle | 其分派单不可再操作；工程师从 `/repair-orders/options` 的列表消失 |
| ROLE-011 | P1 | API | 老板 | 调 `GET /roles` | 列出 7 个员工角色，含 staffCount；老板行 editable=false |
| ROLE-012 | P1 | 页面 | 老板 | 角色页勾选保存 | 需填原因；老板角色只读 |
| ROLE-013 | P2 | 页面 | 店长 | 打开角色页 | 可查看，不可保存（canEdit=false） |

## 2.5 操作日志

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| LOG-001 | P0 | 数据 | 全流程后 | 核对 入库、改价、出库、退款、导出、权限变更 | 每项都有审计记录，含操作人、对象、改前改后、原因、IP、请求号 |
| LOG-002 | P0 | 数据 | 数据库 runtime 账号 | 尝试 UPDATE/DELETE audit_logs | 权限拒绝；旧模板版本同样不可改 |
| LOG-003 | P1 | API | 老板 | 按 actorId、action、objectId、from、to 组合筛选 | 结果正确；日期按北京时间切日 |
| LOG-004 | P1 | API | 老板 | from 格式错误 | 400「日期格式无效」 |
| LOG-005 | P0 | API | 店长 | 查看含成本的日志 | 成本、毛利显示「无权限查看」 |
| LOG-006 | P0 | API | 被授权 audit:view 的库管 | 查看改价日志 | 代理底价（含嵌套 agent_base）显示「无权限查看」，零售价正常 |
| LOG-007 | P0 | API | 同上 | 查看含供应商、内部备注、完整串码的日志 | 均按其字段权限脱敏 |
| LOG-008 | P1 | API | 老板 | `GET /audit-logs/filters` | 返回近 180 天动作和操作人，最多 100 项动作 |
| LOG-009 | P1 | API | 无 audit:view | 调日志接口 | 403 |
| LOG-010 | P2 | 页面 | 老板 | 按动作/人员/日期筛选并展开一条 | 显示改前改后、原因、IP、请求号 |
