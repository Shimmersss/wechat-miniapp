# 01 登录与会话

涉及接口：`POST /auth/wx-login`、`POST /auth/sms-code`、`POST /auth/staff-login`、`GET /auth/me`、`POST /auth/logout`、`GET /health`
涉及页面：`pages/login`、`pages/mine`、`utils/auth.js`、`utils/page.js`

## 1.1 微信静默登录

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AUTH-001 | P0 | API | 新访客 | 用有效 code 调 wx-login | 200；返回 43 位 token 和 user，role=customer；users 表新增一行 |
| AUTH-002 | P1 | API | 老访客 | 同一 openid 再次 wx-login | 不新增用户；生成新会话，旧会话未到期前仍有效 |
| AUTH-003 | P0 | API | 已绑定员工的微信 | 只走 wx-login，不走短信 | 拿到的是微信会话（assurance=wechat）；`/auth/me` 不含 staffNo，无任何员工权限 |
| AUTH-004 | P0 | API | 同上 | 用该 token 调 `GET /units` | 403「无权限执行该操作」，不能靠绑定关系提权 |
| AUTH-005 | P1 | API | 任意 | code 为空、非字符串、超过 256 字符 | 400「微信登录凭证格式无效」 |
| AUTH-006 | P1 | API | 任意 | 微信返回 code 无效 | 401「微信登录凭证无效，请重试」，不建用户 |
| AUTH-007 | P0 | API | 任意 | 未配置 `WX_APP_ID`/`WX_APP_SECRET` 时登录 | 503「微信登录服务尚未配置」，绝不伪造 openid |
| AUTH-008 | P1 | API | 任意 | 微信接口超时或 5xx | 503「微信登录服务暂不可用」 |
| AUTH-009 | P1 | API | 被停用的用户（users.status≠active） | wx-login | 403「账号已停用」 |
| AUTH-010 | P2 | API | 同一 IP | 1 分钟内第 21 次 wx-login | 429「请求过于频繁，请稍后重试」，信封 code=429 |

## 1.2 短信验证码

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AUTH-020 | P0 | API | 在职员工手机号 | 调 sms-code | 200 `{sent:true}`；生成挑战，delivered=true；库里只存 HMAC，不存明文 |
| AUTH-021 | P0 | API | 非员工手机号 | 调 sms-code | 响应与 AUTH-020 完全一致（防枚举员工）；不发短信、不建挑战 |
| AUTH-022 | P0 | API | 已停用员工手机号 | 调 sms-code | 响应同上；不发短信 |
| AUTH-023 | P1 | API | 在职员工 | 60 秒内重复获取 | 429「请稍后再获取验证码」；原挑战未被覆盖 |
| AUTH-024 | P2 | API | 在职员工 | 第 61 秒再次获取 | 成功；attempts 归零，旧验证码失效 |
| AUTH-025 | P1 | API | 任意 | 手机号 10 位、12 位、非 1 开头、含字母 | 400「手机号格式无效」 |
| AUTH-026 | P0 | API | 在职员工 | 未配置腾讯云短信时获取 | 503「短信服务尚未配置」；挑战标记 consumed，不能用于登录 |
| AUTH-027 | P1 | API | 在职员工 | 短信服务返回失败 | 503「短信暂未发送成功，请稍后重试」；挑战 consumed |
| AUTH-028 | P2 | API | 同一 IP | 1 分钟内第 6 次 sms-code | 429 |
| AUTH-029 | P1 | 页面 | 员工 | 登录页点“获取验证码” | 按钮进入倒计时；倒计时内不可重复点击；离开页面定时器被清理 |
| AUTH-030 | P2 | 页面 | 员工 | 手机号不合法时点获取 | 前端提示，不发请求 |

## 1.3 员工登录与绑定

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AUTH-040 | P0 | API | 首次登录员工 | 正确手机号+验证码+微信 code | 200；staff.user_id 绑定当前微信；会话 assurance=staff；审计「员工登录并绑定微信」 |
| AUTH-041 | P0 | API | 已绑定员工 | 同一微信再次登录 | 成功；该用户旧会话全部删除后新建 |
| AUTH-042 | P0 | API | 已绑定员工 | 换一个微信 + 正确验证码 | 409「员工账号已绑定其他微信，请联系管理员」；验证码状态回滚 |
| AUTH-043 | P0 | API | 员工 B | 用已绑定员工 A 的微信登录 B 账号 | 409「当前微信已绑定其他员工账号」 |
| AUTH-044 | P0 | API | 员工 | 验证码错误 | 401「验证码无效或已过期」；attempts+1 且已提交（不随事务回滚） |
| AUTH-045 | P0 | API | 员工 | 连错 5 次后输入正确码 | 第 6 次仍 401 |
| AUTH-046 | P0 | API | 员工 | 同一验证码第二次使用 | 401（防重放） |
| AUTH-047 | P1 | API | 员工 | 超过 5 分钟后使用验证码 | 401 |
| AUTH-048 | P0 | API | 员工 | 短信投递失败的验证码（delivered=false）用于登录 | 401 |
| AUTH-049 | P0 | API | 非员工 | 用任意手机号+验证码 | 401，与验证码错误文案相同，不暴露账号是否存在 |
| AUTH-050 | P1 | API | 员工 | 手机号格式错、验证码非 6 位数字 | 400「手机号或验证码格式无效」 |
| AUTH-051 | P0 | API | 攻击者 | body 带 mockRole、openid、permissions | 全部被忽略，身份只由短信+微信决定 |
| AUTH-052 | P2 | API | 同一 IP | 1 分钟内第 16 次 staff-login | 429 |
| AUTH-053 | P1 | 页面 | 员工 | 带 redirect 参数登录成功 | 回跳 redirect；redirect 不在 ROUTES 内时进入工作台 |
| AUTH-054 | P2 | 页面 | 员工 | redirect 是非法编码或外部路径 | 被清空，不跳转到未知地址 |
| AUTH-055 | P1 | 页面 | mock 模式 | 登录页选择模拟角色登录 | 仅 `useMock:true` 时显示角色选择；真实后端模式不显示 |

## 1.4 会话校验

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AUTH-060 | P0 | API | 无令牌 | 调 `GET /auth/me` | 401「请先登录」 |
| AUTH-061 | P0 | API | 任意 | Authorization 格式错误（非 Bearer、长度不是 43、含非法字符） | 401「登录已过期，请重新登录」 |
| AUTH-062 | P0 | API | 任意 | 令牌已过期（12 小时后） | 401「登录已过期，请重新登录」 |
| AUTH-063 | P0 | API | 员工 | 登录后老板把该员工停用，再用旧令牌访问 | 401；会话已被删除 |
| AUTH-064 | P0 | API | 员工 | 解绑微信后用旧令牌访问 | 401 |
| AUTH-065 | P1 | API | 员工 | 员工会话有效但 staff 记录已非 active（绕过删除会话的异常数据） | 401「员工账号已停用」 |
| AUTH-066 | P0 | API | 员工 | 老板调整其角色权限后，不重新登录直接请求 | 权限立即按新配置生效（loadUser 每次实时读取） |
| AUTH-067 | P1 | API | 用户 | 调 logout 后用同一令牌访问 | 401；重复 logout 仍返回成功 |
| AUTH-068 | P2 | API | 无令牌 | 调 logout | 200，true |
| AUTH-069 | P1 | 页面 | 员工 | 令牌过期后操作任一员工页 | 跳登录页，登录后回到原页面 |
| AUTH-070 | P1 | 页面 | 用户 | “我的”点退出 | 本地 token/user 清除；tab 恢复顾客态；员工页不可再进 |
| AUTH-071 | P2 | API | 任意 | `GET /health` | 数据库正常返回 `{status:"ready"}`；数据库停掉时返回 500 信封，不泄露内部信息 |

## 1.5 页面守卫

| 编号 | 级 | 层 | 身份 | 步骤 | 预期 |
|---|---|---|---|---|---|
| AUTH-080 | P0 | 页面 | 未登录 | 直接打开 `packages/staff/dashboard/index` | 转场结束后跳登录页，带 redirect；不出现长时间空白 |
| AUTH-081 | P0 | 页面 | 顾客 | 打开任一 `requireStaff` 页 | 同上，页面 onLoad 业务逻辑不执行 |
| AUTH-082 | P0 | 页面 | 非代理 | 打开 `packages/agent/center/index` | 跳代理落地页 |
| AUTH-083 | P0 | 页面 | 销售 | 打开 `packages/staff/staff/index` | 弹窗“无权限”，确定后返回 |
| AUTH-084 | P1 | 页面 | 员工 | 守卫页跳 tabBar 页 | 延迟 400ms 跳转，不被挂起 |
| AUTH-085 | P1 | 页面 | 任意 | 切身份后回到已打开页面 | `auth:changed` 事件刷新 user；金额遮挡状态同步 |
