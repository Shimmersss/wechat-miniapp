# 03 分类、型号与模板

涉及接口：`GET/POST /catalog/categories`、`PUT /catalog/categories/:id`、`GET /models/tree`、`POST /models`、`PUT /models/:id`、`GET /models/:id/form`、`GET /templates`、`GET /templates/:id`、`GET /templates/:id/versions`、`POST /templates/:id/versions`、`POST /inbound/identify-model`、`GET /shop/categories`
涉及页面：`staff/templates/index`、`staff/templates/edit`

## 3.1 分类

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| CAT-001 | P0 | API | 老板 | 新增分类，copyTemplateId=t_phone | 分类创建；复制出“<分类>通用模板”v1；字段与描述预设同基础模板 |
| CAT-002 | P1 | API | 老板 | 不传 copyTemplateId | 400「基础模板格式无效」 |
| CAT-003 | P1 | API | 老板 | copyTemplateId 不存在 | 404「模板不存在」，分类不落库 |
| CAT-004 | P1 | API | 老板 | 名称为空、超过 50 字 | 400「分类名称格式无效」 |
| CAT-005 | P1 | API | 老板 | 修改分类名称 | 成功；型号、模板不变；审计「修改分类」 |
| CAT-006 | P1 | API | 老板 | 修改不存在的分类 | 404「分类不存在」 |
| CAT-007 | P0 | API | 销售 | 新增分类 | 403 |
| CAT-008 | P2 | API | 顾客 | `GET /shop/categories` | 无需登录；分类→品牌→系列→型号，只有 id 和 name |
| CAT-009 | P1 | 页面 | 老板 | 新建分类弹窗 | 必须选择复制哪套模板 |

## 3.2 型号

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| MOD-001 | P0 | API | 老板 | 新增型号（名称、品牌、系列、分类、specs） | 成功；templateId 自动等于分类模板 |
| MOD-002 | P1 | API | 老板 | 分类不存在 | 400「分类不存在」 |
| MOD-003 | P1 | API | 老板 | 分类没有模板 | 400「该分类还没有入库模板」 |
| MOD-004 | P1 | API | 老板 | TAC 含 7 位、9 位、字母、重复 | 400「TAC 必须为不重复的八位数字」 |
| MOD-005 | P1 | API | 老板 | 传 TAC 但不传来源 | 400「TAC 核验来源格式无效」 |
| MOD-006 | P1 | API | 老板 | TAC 超过 100 个 | 400 |
| MOD-007 | P1 | API | 老板 | 某 TAC 已映射到其他型号 | 409「记录重复或映射冲突，请核对后重试」 |
| MOD-008 | P1 | API | 老板 | specs 含 storage/color 以外的键 | 400 |
| MOD-009 | P1 | API | 老板 | 编辑型号不传 specs | 原 specs 保留 |
| MOD-010 | P1 | API | 老板 | 修改不存在的型号 | 404「型号不存在」 |
| MOD-011 | P1 | API | 老板 | 同名品牌新增第二个型号 | brand 复用已有值，不产生重复品牌 |
| MOD-012 | P1 | API | 库管 | `GET /models/tree` | 可读；不含 tacs |
| MOD-013 | P1 | API | 老板 | `GET /models/tree` | 含 tacs、tacSource |
| MOD-014 | P1 | API | 老板 | 按 category 过滤型号树 | 只返回该分类 |
| MOD-015 | P2 | 页面 | 老板 | 编辑型号 | 容量、颜色回显；列表显示规格 |
| MOD-016 | P1 | 页面 | 库管 | 作为入库选择器进入模板页 | 只能选择，不能编辑；选中后回传 modelId |

## 3.3 入库表单

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| FORM-001 | P0 | API | 库管 | `GET /models/:id/form` | 返回分类模板当前版本字段，容量、颜色选项替换为型号规格 |
| FORM-002 | P1 | API | 库管 | 型号没配 specs | 使用模板默认选项 |
| FORM-003 | P1 | API | 库管 | 型号不存在 | 404「型号不存在」 |
| FORM-004 | P1 | API | 销售 | 调用 form | 403（需 template/inbound/purchase/acceptance 之一） |
| FORM-005 | P1 | 页面 | 库管 | 手机模板 | 含网络锁、ID 锁、拆修情况、激活状态、官方保修到期（日期可清空） |

## 3.4 模板发布

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| TPL-001 | P0 | API | 老板 | 用当前 baseVersion 发布新版本 | 版本号+1；current_version 更新；审计「发布模板版本」 |
| TPL-002 | P0 | 并发 | 两个老板 | 同一 baseVersion 同时发布 | 一个成功，另一个 409「模板已更新，请刷新后编辑」 |
| TPL-003 | P0 | 数据 | 老板 | 发布后查看已入库设备 | template_snapshot 仍是旧版本字段；旧机展示不变 |
| TPL-004 | P0 | API | 库管 | 持旧 templateVersion 入库 | 409「模板已更新，请重新加载型号」 |
| TPL-005 | P1 | 数据 | runtime 账号 | 修改 template_versions 旧行 | 权限拒绝 |
| TPL-006 | P1 | API | 老板 | fields 为空、超过 50 个 | 400「模板需包含 1～50 个字段」 |
| TPL-007 | P1 | API | 老板 | key 大写开头、含中文、超过 40 位 | 400「字段标识须以小写字母开头，限 40 位字母、数字或下划线」 |
| TPL-008 | P1 | API | 老板 | key 为 imei1、cost、retail、wholesale、agentBase、flags、`__proto__` | 400「字段标识为系统保留名称」 |
| TPL-009 | P1 | API | 老板 | key 重复 | 400「字段标识不能重复」 |
| TPL-010 | P1 | API | 老板 | label 空或超过 30 字 | 400「字段名称需为 1～30 个字符」 |
| TPL-011 | P1 | API | 老板 | type 不在 text/number/select/boolean/ref/image/date | 400「不支持的字段类型」 |
| TPL-012 | P1 | API | 老板 | required/filterable 不是布尔 | 400「请设置必填与筛选规则」 |
| TPL-013 | P1 | API | 老板 | visibility 为空或含未知值 | 400「请选择有效的可见范围」 |
| TPL-014 | P0 | API | 老板 | visibility 同时含 internal 和 customer | 400「仅内部字段不能同时对外展示」 |
| TPL-015 | P0 | API | 老板 | supplier、receipt、internalNote 设为对外可见 | 400，这些字段只能内部可见 |
| TPL-016 | P1 | API | 老板 | select 无选项或超过 50 项 | 400 |
| TPL-017 | P1 | API | 老板 | number 的 min/max 非数字 | 400 |
| TPL-018 | P2 | API | 老板 | 默认值类型不符（数字超范围、日期格式错、开关非布尔、下拉不在选项内） | 分别提示对应错误，如「默认值必须属于选项」「日期默认值格式应为 YYYY-MM-DD」 |
| TPL-019 | P2 | API | 老板 | image 字段设默认值 | 400「图片字段不能设置默认值」 |
| TPL-020 | P1 | API | 老板 | 描述预设单类超过 6 句或单句超过 200 字 | 400「每类快捷描述最多 6 句，每句 1～200 字」 |
| TPL-021 | P1 | API | 老板 | 不传 descriptionPresets | 沿用上一版本 |
| TPL-022 | P1 | API | 老板 | `GET /templates/:id/versions` | 倒序列出历史版本，含操作人和时间 |
| TPL-023 | P1 | API | 库管 | `GET /templates` | 403；`GET /templates/:id` 可读 |
| TPL-024 | P1 | API | 老板 | 操作不存在的模板 | 404「模板不存在」 |
| TPL-025 | P1 | 页面 | 老板 | 增删字段、调序、改可见范围后发布 | 分类下所有型号入库立即用新版本 |

## 3.5 串码识别型号

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| TAC-001 | P1 | API | 库管 | 已核验 TAC 的 IMEI 调 identify-model | matched=true，提示“请核对实机型号；容量、颜色与机况需另行填写” |
| TAC-002 | P1 | API | 库管 | 未知 TAC | matched=false「未找到已核验型号，请手动选择」 |
| TAC-003 | P1 | API | 库管 | 校验位错误 | 400「IMEI 格式或校验位无效」 |
| TAC-004 | P1 | API | 销售 | 调用 identify-model | 403 |

## 3.6 迁移

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| MIG-001 | P0 | 数据 | 迁移账号 | 旧的一型号一模板数据执行迁移 022 | 同分类型号全部指向分类模板；手机用 t_phone |
| MIG-002 | P1 | 数据 | 迁移账号 | 无模板的分类 | 复制手机模板 |
| MIG-003 | P0 | 数据 | 迁移账号 | 迁移后查已入库设备 | 快照可追溯，旧模板保留 |
| MIG-004 | P1 | 数据 | 迁移账号 | 重复执行 migrate | 幂等，不产生重复数据 |
| MIG-005 | P0 | 数据 | 空库 | 从 001 依次执行全部 22 个迁移并 `db:grants` | 成功，应用账号最小权限可跑通 |
