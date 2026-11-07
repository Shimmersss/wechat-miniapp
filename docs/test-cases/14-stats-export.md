# 14 工作台、访问量、经营统计、导出

涉及接口：`POST /visits/batch`、`GET /stats/visits`、`GET /stats/visit-trend`、`GET /stats/ageing`、`GET /staff/dashboard`、`GET /stats/overview`、`GET /stats/breakdown`、`GET /stats/trend`、`GET /stats/agent-earnings`、`POST /stats/export`、`GET /stats/exports/:id`
涉及页面：`staff/dashboard`、`staff/stats`、`utils/track.js`

口径（框架文档 8.2）：动销率=当日成功销售台数÷当日 0 点可售库存；销售毛利=实收−成本快照−退款调整；时间统一按北京时间。

## 14.1 访问上报

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| VIS-001 | P0 | API | 匿名 | 上报 pv | accepted=1；visitor_hash 为 HMAC，不存原值 |
| VIS-002 | P0 | API | 匿名 | 同 eventId 重复上报 | 去重，ignored+1 |
| VIS-003 | P1 | API | 匿名 | visitorId 少于 8 位、含非法字符；events 空或超 100 | 400「访问上报格式无效」 |
| VIS-004 | P1 | API | 匿名 | type 非 pv/event | 400「事件类型无效」 |
| VIS-005 | P1 | API | 匿名 | eventId 格式错 | 400「事件标识无效」 |
| VIS-006 | P0 | API | 匿名 | route 是员工路径或未知路径 | 忽略，不落库 |
| VIS-007 | P1 | API | 匿名 | 事件名不在 consult_click、share、poster_save | 忽略 |
| VIS-008 | P1 | API | 匿名 | unitId 不存在 | 忽略 |
| VIS-009 | P0 | API | 匿名 | 附带手机号等额外字段、客户端时间 | 不落库，以服务端时间为准 |
| VIS-010 | P0 | API | 匿名 | 带有效 X-Channel | 归因到分享和分享人 |
| VIS-011 | P0 | API | 匿名 | 带已撤销或伪造 X-Channel | 上报成功但不归因到分享人 |
| VIS-012 | P1 | API | 匿名 | X-Channel 超 100 字符 | 400「分享标识无效」 |
| VIS-013 | P2 | API | 同一 IP | 1 分钟第 61 次 | 429 |
| VIS-014 | P1 | 页面 | 顾客 | 浏览若干页 | 批量上报；login 页不计 PV |
| VIS-015 | P1 | API | 老板 | `GET /stats/visits` | UV、PV、商品详情、分享访问、咨询点击、咨询人数、预约、来源拆分 |
| VIS-016 | P1 | API | 老板 | 同一访客多次 PV | UV=1 |
| VIS-017 | P1 | API | 老板 | visit-trend | 空日期补零 |

## 14.2 工作台

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| DSH-001 | P0 | API | 老板 | `GET /staff/dashboard` | 销售、访问、库存（在库、在途、待验收、维修、出借、复检、今日入库、在库成本）、待办 |
| DSH-002 | P0 | API | 销售 | 同上 | 无 stockCost、profit；待办只含有权限的项 |
| DSH-003 | P1 | API | 库管 | 同上 | 有待验收、待复检、库龄；无代理收益 |
| DSH-004 | P1 | API | 财务 | 同上 | 有代理收益待转账 |
| DSH-005 | P1 | 数据 | 老板 | 入库、验收、售出前后 | 各计数实时变化；借入不计今日入库 |
| DSH-006 | P1 | 页面 | 老板 | 点各待办 | 带筛选跳转；数量与列表一致 |
| DSH-007 | P2 | 页面 | 销售 | 工作台 | 只显示有权限的入口 |
| DSH-008 | P1 | 数据 | 老板 | 库龄 30 天边界 | 待办算 >30；`/stats/ageing` 算 >=days |

## 14.3 经营统计

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| STA-001 | P0 | API | 老板 | range=day/week/month | 周一起算；月初起算；end 为明日 0 点 |
| STA-002 | P1 | API | 老板 | range=xxx | 400「统计周期无效」 |
| STA-003 | P1 | API | 老板 | 只传 from | 400「请同时填写起止日期」 |
| STA-004 | P1 | API | 老板 | 范围 0 天、367 天、from>to | 400「统计范围需为1～366天」 |
| STA-005 | P1 | API | 老板 | 日期非法 | 400「日期格式无效」 |
| STA-006 | P0 | 数据 | 老板 | 2 台售价 5000、成本 4000，退 1 台 | 净额、退货台次、退款、毛利逐项手算核对 |
| STA-007 | P0 | 数据 | 老板 | 动销率：0 点可售 10，当日售 2 | 0.2；维修、借出、在途不算可售 |
| STA-008 | P0 | 数据 | 老板 | 当日入库并售出 | 不进入 0 点基数 |
| STA-009 | P0 | 数据 | 老板 | 出借 | 不计销售台数和毛利 |
| STA-010 | P0 | API | 销售 | overview、breakdown、trend | 无 profit、毛利率 |
| STA-011 | P1 | API | 老板 | dimension=model/staff/store | 按快照归类；未指定门店显示“未指定门店” |
| STA-012 | P1 | API | 老板 | dimension=xxx | 400「统计维度无效」 |
| STA-013 | P1 | API | 老板 | trend 空日期 | 补零 |
| STA-014 | P0 | 数据 | 老板 | 跨日退款 | 退款计入退款发生日；原成交日不变 |
| STA-015 | P1 | API | 老板 | `GET /stats/ageing?days=30` | 只含 in_stock，升序；需 inventory:view |
| STA-016 | P1 | 页面 | 老板 | 趋势图、维度切换、库龄预警 | 与接口一致 |
| STA-017 | P0 | API | 财务 | `GET /stats/agent-earnings` | 成交台数、成交额、收益、冲回、净额、本期已转账、累计待转账；按代理拆分 |
| STA-018 | P0 | API | 销售 | 同上 | 403；页面无该区块 |
| STA-019 | P1 | 数据 | 财务 | 冲回按退货发生时间；未转账作废和已转账负数都计入 | 核对 |

## 14.4 导出

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| EXP-001 | P0 | API | 财务 | 导出：reason、requestKey、范围 | 生成快照，15 分钟有效；审计「导出销售退款报表」 |
| EXP-002 | P0 | API | 财务 | 不填原因 | 400「导出原因格式无效」 |
| EXP-003 | P0 | API | 财务 | 重放同内容 | 返回同一导出 |
| EXP-004 | P0 | API | 财务 | 同标识不同内容 | 409「导出标识已用于其他内容」 |
| EXP-005 | P1 | 并发 | 财务 | 同标识并发 | 只一条；内容不同的输家 409「导出标识内容冲突」 |
| EXP-006 | P0 | API | 财务 | 下载 | CSV 带 BOM、CRLF、12 列 |
| EXP-007 | P0 | API | 财务 | 单元格以 = + - @ 开头 | 前缀单引号，防公式注入 |
| EXP-008 | P0 | API | 财务 B | 下载财务 A 的导出 | 404「导出记录不存在」 |
| EXP-009 | P0 | API | 财务 | 15 分钟后下载 | 410「下载已过期，请重新导出」 |
| EXP-010 | P0 | API | 被降权的财务 | 下载已生成的导出 | 重新鉴权，成本利润列裁剪或 403 |
| EXP-011 | P1 | API | 财务 | 明细超 10000 行 | 400「明细超过10000行，请缩小日期范围后导出」 |
| EXP-012 | P0 | 数据 | 财务 | 导出后发生退款 | 已生成快照不变 |
| EXP-013 | P0 | API | 销售 | 导出 | 403 |
| EXP-014 | P1 | API | 店长（无 cost、profit） | 导出 | 成本、毛利列裁剪 |
| EXP-015 | P2 | API | 同一人 | 1 分钟第 11 次 | 429 |
| EXP-016 | P1 | 页面 | 财务 | 导出防重复点击 | 走 `confirmSensitive`，只生成一次 |
| EXP-017 | 外部 | 真机 | 财务 | 保存到本机、转发文件 | 本机保存已验证；转发需实机 |
