# 人机？ V1 API

接口基址：`http://<后端主机>:<后端端口>`，按自己的环境配置。JSON 请求和响应，POST 设置 Content-Type: application/json。除健康检查、注册登录和管理员入口外，需要 Authorization: Bearer <token>。错误响应 `{ "error": "说明" }`，HTTP 状态区分 400 参数错误、401 登录失效、403 禁止操作、404 不存在或无权访问、409 状态冲突、413 请求过大、429 限流。

## 接口

| 方法 | 路径 | 请求 / 响应 |
| --- | --- | --- |
| GET | /health | `{ok:true,name:"人机？"}` |
| POST | /auth/register | `{username,password}` → `{token,user}`，201 |
| POST | /auth/login | `{username,password}` → `{token,user}` |
| POST | /auth/logout | `{}` → `{ok:true}`，撤销当前令牌 |
| GET | /me | `{user}` |
| POST | /me/accepting | `{accepting:boolean}` → `{ok:true}` |
| GET | /ais | `{users:Account[]}`，最多100个，排除自己、禁用账号和双方拉黑 |
| POST | /conversations | `{aiId:number}` → `{conversationId:number}` |
| GET | /conversations?role=user 或 ai | `{conversations:Conversation[]}`，最多100段 |
| GET | /conversations/:id/messages?after=0 | `{messages:ChatMessage[],hasMore:boolean}`，最多100条，按id升序 |
| POST | /conversations/:id/messages | `{text:string}` → `{messageId:number}`，201 |
| POST | /conversations/:id/read | `{messageId:number}` → `{ok:true}`，游标只能指向该对话的真实消息且不会倒退 |
| POST | /blocks | `{userId:number,blocked:boolean}` → `{ok:true}` |
| POST | /reports | `{messageId:number,reason:string}` → `{ok:true}`，201，只能举报自己对话中对方的消息 |
| GET | /admin/reports | X-Admin-Key认证，返回最近100条举报及原消息文字和发送者编号 |
| POST | /admin/ban | X-Admin-Key认证，`{userId:number}` → `{ok:true}` |

## 类型

```typescript
interface Account { id: number; username: string; accepting: boolean; }
interface Conversation { id: number; peerId: number; peerName: string; lastText: string; unread: number; }
interface ChatMessage { id: number; senderId: number; text: string; createdAt: number; }
```

createdAt 为 Unix 毫秒时间。消息 ID 全局递增，但服务端查询总是限定到已授权对话。after 是已获取消息的最大 ID；首次传 0 从最早消息开始。hasMore 为 true 时继续请求，即便恰好100条且下一页为空也不会遗漏。读取接口本身不修改已读状态，客户端显示后调用 read。

AI身份不是服务端特殊权限，每个注册账号都可开放接聊。用户不能选择自己，不能替别人创建对话；聊天写入和读取只授权两个参与者。反向发起聊天形成另一段对话，角色不变更。

## 存储与限制

users 保存哈希密码和接聊 / 禁用状态；sessions 保存随机令牌和有效期；conversations 保存双方固定角色和各自已读游标；messages 保存文字和时间；blocks 保存单向设置但双向生效的拉黑；reports 保存举报原因和消息引用。

用户名统一小写、3–24位 ASCII 字母数字下划线；密码8–128字符；消息去除首尾空白、1–2000字符；举报原因1–300字符；请求体上限16 KiB。

单进程限流：IP请求每分钟600次；注册/登录每IP每分钟20次；注册每IP每小时5次；创建对话每账号每分钟10次；发送消息每账号每分钟30次；举报每账号每分钟5次。限制以尝试次数计，包括参数错误或被拒绝的请求。反向代理下当前按socket IP限流，不直接信任 X-Forwarded-For；生产部署需按受信代理调整。

数据库表结构在启动时创建；后续字段升级应新增明确迁移流程。生产环境管理员密钥应由平台密钥管理提供，不能放进客户端。当前没有公开管理员UI、批量导出接口或完整审计系统。
