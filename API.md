# 人机？ V2 API

版本 2.0.0；SQLite schema 6。基址为服务的 HTTP / HTTPS origin，生产要求 HTTPS。请求与响应为 JSON，POST 使用 Content-Type: application/json。除下列公开接口与管理员接口外，使用 Authorization: Bearer <token>；不要把凭据放到 URL 中。

错误格式为 `{ "error": "可显示的说明", "code": "稳定错误码" }`。时间为 Unix 毫秒，消息 ID 全局递增；每次消息读写都限定到已授权会话。非参与者返回 404，不暴露会话是否存在。

## 公开接口与账号

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /health | {ok,name,version,schemaVersion} |
| GET | /service/config | {mailAvailable,pushAvailable:false,privacyUrl,rulesUrl} |
| GET | /privacy、/rules | HTML 隐私政策、使用规则与真人回复说明 |
| POST | /auth/register | {username,password,acceptPolicy:true,policyVersion:"2026-11-20",deviceId?,deviceName?} → {token,expiresAt,user}，201 |
| POST | /auth/login | {username,password,deviceId?,deviceName?} → {token,expiresAt,user} |
| POST | /auth/recovery/request | {email} → {ok,challengeId,expiresAt,messageText} |
| POST | /auth/recovery/reset | {challengeId,code,newPassword} → {ok,messageText}，撤销全部旧登录 |

用户名转为小写，3–24 位 ASCII 字母、数字或下划线，是稳定登录标识。密码 8–128 字符。deviceId 是客户端持久随机编号，deviceName 最长 80 字符；不发送硬件唯一识别码。token 最长有效 7 天，服务端只保存 SHA-256 摘要，客户端使用安全存储。

找回请求对未绑定/未验证邮箱也给出通用说明和无效挑战编号，避免直接暴露账号。没有邮件配置时返回 503 MAIL_NOT_CONFIGURED。真实投递尚未接入；接口流程用测试 mailer 验证。

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /me | {user,expiresAt} |
| POST | /auth/logout | {} → {ok}，撤销当前凭据 |
| POST | /auth/password | {currentPassword,newPassword} → {ok}，撤销包括当前设备的全部凭据 |
| GET | /auth/devices | {devices:[{id,name,createdAt,lastSeen,expiresAt,current}]}，id 为登录会话编号 |
| POST | /auth/devices/revoke | {sessionId} 或 {otherDevices:true} → {ok} |
| POST | /me/profile | {nickname,bio,aiStyle,aiTopics} → {user}，须提交四个字段 |
| POST | /me/accepting | {accepting:boolean} → {ok}，兼容单开关 |
| POST | /me/availability | {accepting:boolean,busy:boolean,maxChats:1..100} → {user} |
| POST | /me/preferences | {notificationEnabled:boolean,notificationPreview:boolean} → {user} |
| GET | /me/unread | {unread:{user:number,ai:number}}，分别计算两个身份的可见会话 |
| GET | /me/notices | {notices:[{id,reason,createdAt,readAt}]}，最近 50 条管理员警告 |
| POST | /me/email/request | {email,currentPassword} → {ok,challengeId,expiresAt}，绑定或更换 |
| POST | /me/email/verify | {challengeId,code} → {user}，验证成功才替换旧邮箱 |
| POST | /me/email/unbind | {currentPassword} → {ok} |
| POST | /me/delete | {currentPassword,confirm:"注销账号"} → {ok,messageText} |

昵称不能为空且最多 30 字符，简介 300、AI 风格 120、话题 200。通知偏好已保存和同步，当前没有 Push Kit 设备注册或发送接口。

邮箱验证码为 6 位字符串，10 分钟有效，最多 5 次尝试，一次性消费。重新获取使相同用途的旧挑战失效。更换/解绑邮箱需当前密码；改密、重置、恢复服务会使未用挑战作废。验证码保存 HMAC 摘要，密钥须固定且不少于 32 字符。

客户端退出应先清理本机账号、草稿和待发队列，再尽力请求 /auth/logout；断网时不等待后端成功。本机退出不承诺已经撤销服务器上的离线凭据；在线时可从其他设备撤销。

## AI 列表与会话分页

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /ais?q=&sort=recent&limit=50&cursor= | {users,hasMore,nextCursor} |
| POST | /conversations | {aiId} → {conversationId}，存在同角色对话时复用 |
| GET | /conversations?role=user&limit=50&cursor=&q= | {conversations,hasMore,nextCursor} |
| GET | /conversations/:id | {conversation,peerReadId}，含本人设置、双方拉黑和对方可用状态 |
| POST | /conversations/:id/settings | {pinned?,hidden?,muted?} → {ok}，至少一个布尔字段 |
| GET | /conversations?role=user&hidden=1 | 只列本人隐藏会话，仍可分页；默认 hidden=0 |

列表 limit 为 1–100，默认 50。AI 和会话 nextCursor 为不透明字符串，下页通过 cursor 原样传回，不自己解析。搜索或排序变化时清空旧游标，实时排序变化时从首屏重新校对已加载窗口。

AI sort 可选 recent（账号编号降序）、available（可接聊优先，再考虑在线，编号降序）、name（昵称排序）。只列开放接聊、未禁用、未注销且无双方拉黑的其他账号；搜索用户名、昵称、风格、话题。online 由实时连接与心跳判断，accepting 是持久意愿；available 综合意愿、忙碌与名额。轮询设备没有实时连接时不能由此判为在线。

会话按置顶、最近消息 ID、会话 ID 降序。q 最多 100 字符，匹配联系人用户名、昵称或本人会话中的消息关键词。会话中的角色固定；反向发起会形成另一段角色相反的对话。

仅创建新对话检查接聊意愿、忙碌和上限，已有对话可重新打开/回复。activeChats 统计 AI 身份自己的可见会话，隐藏可释放名额，新消息会使隐藏会话重新出现。hidden 只影响本人列表和本人大厅未读统计，不删除双方文字；read 游标不因此清空。

## 消息确认、去重与历史

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /conversations/:id/messages | 最近 50 条，按 ID 升序返回 |
| GET | /conversations/:id/messages?before=ID&limit=50 | 更早历史，ID 小于 before |
| GET | /conversations/:id/messages?after=ID&limit=100 | 增量补齐，ID 大于 after |
| POST | /conversations/:id/messages | {text,clientMessageId} → {messageId,message,replayed} |
| POST | /conversations/:id/read | {messageId} → {ok}，只接受该会话的真实消息，游标单调增加 |

读消息响应为 {messages,hasMore,hasEarlier,cursor,historyVersion,peerName,peerReadId,peerUnavailable,blocked,selfBlocked,peerBlocked}。before 与 after 不能同时提供。默认/向前历史使用 hasEarlier，增量 after 使用 hasMore。cursor 是本批最后一条消息 ID；空增量保持传入游标。历史翻页用最早已加载消息 ID 的 before，向前补齐持续请求到 hasMore=false。

clientMessageId 必须为 16–80 位字母、数字、下划线或短横线；推荐 UUID。唯一范围为发送账号 + 编号，涵盖该账号的所有会话与身份。消息去除首尾空白后长度为 1–2000 字符。

首次请求持久保存后返回 201，例如：

```json
{
  "messageId": 42,
  "message": {
    "id": 42,
    "senderId": 7,
    "text": "你好",
    "createdAt": 1795120000000,
    "clientMessageId": "1d924ae3-757c-4a8b-9bcf-526aaae9bddc",
    "redacted": 0
  },
  "replayed": false
}
```

同编号、同会话、同文字重试返回同一条 message，200 / replayed=true。编号复用于不同文字或会话返回 409 CLIENT_ID_CONFLICT。HTTP 超时不说明服务端一定没保存：保留原文字与编号，按原编号重试，不能创建新的发送记录。重复确认不会重复写入消息，也不会重复发布新消息事件。

客户端仅在收到授权 HTTP 确认/拉取到对应编号后标记成功；WebSocket 是更新提示。每会话 FIFO 队列在前一条未确认时暂停后续发送，失败后重试原条。服务端按实际写入生成 ID，客户端有序发送决定同设备顺序；多设备同时发送按服务器接受顺序排序。

**消息同步游标与单条发送确认、已读游标分别维护。** 自己的 ACK 可能晚于其他消息，不能直接跳过所有较小 ID；补齐按 lastSyncCursor 请求、按消息 ID / 客户端编号去重并排序。真正显示消息后才提交 read，后台或正在阅读旧历史时不提前标记末尾已读。peerReadId 用于发送方显示对方已读。

historyVersion 在注销移除正文时递增；断线恢复发现版本变化，应刷新已加载历史正文，避免保留已移除文字。redacted=1 表示已按规则替换；消息 ID 和历史关联仍保留。

## WebSocket

使用 ws(s)://服务主机/realtime，握手 Authorization: Bearer <token>。不允许 URL 查询令牌。前台连接正常时用事件触发 HTTP 补齐，并周期校对；后台停止长连接，回到前台立即补齐。实时不可用时回退轮询。

客户端可发送：

```json
{"type":"ping"}
{"type":"pong"}
{"type":"view","conversationId":123}
{"type":"view","conversationId":0}
```

view 必须是自己参与的会话；0 表示未查看任何会话。为未来通知抑制记录查看状态，当前未接入系统推送。

| 服务端事件 | 含义 |
| --- | --- |
| ready {heartbeatMs,timeoutMs} | 握手成功，默认心跳 15 秒，45 秒无响应关闭 |
| ping {at} / pong | 心跳 |
| message {conversationId,messageId} | 有新消息，按游标 HTTP 补齐 |
| conversation {conversationId} | 会话创建/重新可见 |
| read {conversationId,userId,messageId} | 读游标变化，更新多设备未读与对方已读 |
| settings {conversationId} | 本人会话设置变化 |
| account | 本人资料/接聊/通知设置变化 |
| directory | AI 状态或列表变化，校对已加载列表 |
| block | 双方拉黑状态变化 |
| reports | 本人举报处理状态变化 |
| history_changed {conversationId} | 注销导致正文变化，刷新历史 |
| auth_invalid {code,error} | 凭据失效，关闭连接并返回登录 |

当前所有事件都只是同步信号，不传完整私聊。每账号最多 8 条实时连接，入站帧最多 4096 字节、每连接每分钟 120 条；缓冲超过限制或失联则断开。客户端连接超时 8 秒，退避自动重连；重连后按 HTTP 游标补齐。封禁/撤销凭据会立即关闭相应连接。系统通知和 WebSocket 是独立功能。

## 黑名单、举报与处理状态

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /blocks?before=&limit=50 | {users,hasMore,nextCursor}，nextCursor 作为 before |
| POST | /blocks | {userId,blocked:boolean} → {ok} |
| GET | /reports?before=&limit=50 | {reports,hasMore,nextCursor}，仅本人记录 |
| POST | /reports | {messageId,category,reason?} → {ok,reportId,status,replayed} |

举报分类 harassment、hate、sexual、scam、privacy、other，补充原因最多 300 字符。只允许举报本人会话中的对方消息，不能举报自己。相同举报人 + 消息编号重试返回原记录，不覆盖旧分类、理由或处理结果。

拉黑单方设置、双向阻止发送；已有历史可查看。重复消息请求可以确认已经保存的原条，不新增文字。黑名单与聊天状态同步给设备；系统通知抑制等待 Push Kit 接入。

举报保存被举报的单条必要文字、发送者/会话编号、分类、原因和结果；管理员不提供任意会话聊天浏览。处理结果 status 为 pending / resolved / dismissed。

## 独立管理员 API

浏览器页面 /admin。管理员不使用普通 Bearer token；独立账号登录获得 Path=/admin、HttpOnly、SameSite=Strict 的 Cookie，HTTPS 下增加 Secure，有效 8 小时。普通用户不能访问管理数据。

所有管理员 POST 需要同源 JSON；登录之外还需 X-CSRF-Token，值由管理员 login / session 返回。不要把 Cookie 或 CSRF 放进手机应用。页面支持退出、失效返回登录、空状态、错误重试、搜索与分页。

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| POST | /admin/api/login | {username,password} → {username,csrf,expiresAt} + Cookie |
| GET | /admin/api/session | {username,csrf,expiresAt} |
| POST | /admin/api/logout | {} → {ok}，Cookie 作废 |
| GET | /admin/api/summary | {users,banned,pending} |
| GET | /admin/api/users?q=&state=all&before=&limit=50 | {users,hasMore,nextCursor} |
| GET | /admin/api/users/:id | {user,counts,devices}，无密码/令牌 |
| GET | /admin/api/reports?state=pending&before=&limit=50 | {reports,hasMore,nextCursor}，必要证据 |
| GET | /admin/api/audit?before=&limit=50 | {logs,hasMore,nextCursor} |
| POST | /admin/api/moderate | {userId,action,reason,durationHours?,reportId?} → {ok} |
| POST | /admin/api/reports/:id/resolve | {status:"resolved"或"dismissed",result} → {ok} |

用户 state 为 all / active / disabled / deleted，举报 state 为 all / pending / resolved / dismissed；参数名是 **state**。nextCursor 原样用作 before。默认 50、最大 100。

action 为 warn、temporary_ban、permanent_ban、unban。reason / result 为 1–500 字符，临时封禁 durationHours 为整数 1–720。提供 reportId 时校验被举报账号并一并完成该举报；处理后再次处理返回 409。封禁立即关闭接聊、撤销所有设备、断开实时连接；临时到期自动解封并记录系统日志，旧凭据仍失效。解封不自动开放接聊。

旧 /admin/reports 与 /admin/ban 的 X-Admin-Key 模式默认关闭，仅 ALLOW_LEGACY_ADMIN=true 且设置 ADMIN_KEY 才启用，保留有限兼容，不用于日常管理。

## 错误与限流

常见 HTTP 状态：400 参数错误、401 登录/会话失效、403 禁止操作、404 不存在或无权限、409 冲突、410 验证码失效、413 请求过大、415 管理员请求类型错误、429 限流、503 服务/邮件不可用。

凭据失效代码：SESSION_EXPIRED、PASSWORD_CHANGED、PASSWORD_RESET、DEVICE_REVOKED、SIGNED_OUT、ACCOUNT_BANNED、ACCOUNT_DELETED、SERVICE_RESTORED。客户端返回登录并显示 error，清除当前账号本机数据；网络失败不误判成账号失效。

其他常见代码：CLIENT_ID_CONFLICT、AI_UNAVAILABLE、AI_CAPACITY、PEER_UNAVAILABLE、PRIVACY_ACCEPTANCE_REQUIRED、RATE_LIMITED、MAIL_NOT_CONFIGURED、MAIL_DELIVERY_FAILED、EMAIL_CODE_USED、EMAIL_CODE_EXPIRED、EMAIL_CODE_LOCKED、EMAIL_IN_USE、ADMIN_NOT_CONFIGURED、ADMIN_SESSION_EXPIRED、ADMIN_CSRF_REJECTED、ADMIN_ORIGIN_REJECTED。

| 范围 | 限额 |
| --- | --- |
| 全部 HTTP 每来源 IP | 600 / 分钟 |
| 注册/登录每 IP；登录每用户名 | 20 / 分钟；12 / 分钟 |
| 注册每 IP | 5 / 小时 |
| 创建对话；新消息每账号 | 10 / 分钟；30 / 分钟 |
| 举报请求；新增举报每账号 | 30 / 分钟；5 / 分钟且 20 / 天 |
| 邮件每邮箱；绑定每账号；邮件/找回每 IP | 3 / 小时；5 / 小时；10 / 小时 |
| 验证码每 IP；每挑战 | 30 / 分钟；最多 5 次 |
| 管理员登录每 IP | 10 / 10 分钟 |
| WebSocket 握手每 IP | 30 / 分钟 |

限流和验证码尝试持久保存，服务重启不重置。多数限额按尝试计算，消息同编号重放不计为新增消息，仍受总请求限制。受信代理用 TRUSTED_PROXIES 明确 IP，从右向左校验链路，默认不信任外部 X-Forwarded-For。请求体上限 16 KiB。

## 数据版本与删除规则

数据库使用 PRAGMA user_version 和显式迁移；V1 无版本数据库可保留账号、消息、会话、已读、举报及原有效登录迁移至 schema 6。新增设备/登录撤销原因、消息客户端编号、资料、通知、会话设置、验证码、举报证据与状态、管理员会话/操作日志、持久限流、政策同意及历史正文版本。未知的更高 schema 拒绝启动。

注销移除用户名、密码、邮箱和资料，本人消息替换提示，保留匿名内部编号与对方记录。必要举报证据例外保存：已处理 180 天，待处理最长一年后移除正文并标记不予处理；管理员操作日志一年、警告 180 天。过期验证记录一天后清理。备份 30 天、注销日志 35 天，恢复合并最新日志防止注销复活，并撤销全部旧登录。

服务的 /privacy 与 /rules 以及客户端离线政策给出完整说明；修改后运行 npm run sync:policy。备份、恢复和部署参数见 docs/DEPLOYMENT.md。
