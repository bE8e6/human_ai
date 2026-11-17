# 人机？

一个使用 ArkTS / ArkUI 编写的原生鸿蒙文字聊天应用。这里的 AI 是由真人扮演的身份，回复由对方亲自输入，不调用大模型。

项目由鸿蒙客户端和 Node.js + SQLite 后端组成，可先在本地运行。本文的路径、设备标识和端口均使用相对路径或按实际环境输入，不包含开发者的本机配置。

## 第一版功能

- 用户名注册、密码登录、退出；密码使用随机盐和 scrypt 哈希，登录令牌有效期为 7 天。
- 同一个账号切换“我是用户 / 我是 AI”；每段对话的双方角色固定。
- AI 自行开放或暂停接聊，用户选择 AI 发起一对一文字聊天。
- 文字消息、聊天历史、未读数量、前台每 3 秒获取增量消息。
- 拉黑、解除拉黑、长按对方消息举报；管理员查看举报和禁用账号。
- 服务端校验对话参与者，并限制注册、登录、发消息和举报频率。

“开放接聊”表示愿意接收新对话，不代表设备实时在线。暂停接聊后，已有对话仍可回复。

## 环境准备

- DevEco Studio 及工程所需的 HarmonyOS SDK。
- 兼容的 HarmonyOS 模拟器或真机；工程的 SDK 要求见 build-profile.json5。
- Node.js 24 或更新版本。
- Git；模拟器 / USB 转发方式还需要 SDK 自带的 hdc。

后端没有第三方运行依赖，不需要另装数据库。以下 PowerShell 命令从项目根目录执行。

## 启动后端

在项目根目录打开 PowerShell：

```powershell
Set-Location .\server
node --version
npm test
$env:PORT = Read-Host '后端端口（查看源码默认值，或指定未占用端口）'
$backendPort = $env:PORT
$serviceBase = "http://localhost:$backendPort"
npm start
```

保留后端终端。浏览器打开启动日志给出的 `/health` 地址，看到 `ok: true` 和名称“人机？”说明服务已启动。该服务只提供接口，没有网页聊天页面。

端口是开发配置，并非账号信息。客户端地址、hdc 转发和后端监听端口必须一致。未设置 PORT 时使用 server/index.mjs 中定义的默认值。

## 连接鸿蒙设备

### 模拟器 / USB 转发

在另一个 PowerShell 或 DevEco Terminal 中，等待设备完全开机，然后输入实际设备标识和后端端口：

```powershell
hdc list targets
$deviceId = Read-Host '设备标识（复制 list targets 的实际结果）'
$backendPort = Read-Host '正在运行的后端端口'
hdc fport ls
hdc -t $deviceId rport "tcp:$backendPort" "tcp:$backendPort"
```

如果转发表已经有该设备的同一条 Reverse 映射，直接复用，不重复创建。应用登录页填写设备本地回环地址和所选端口；格式为 `http://localhost:<后端端口>`。也可以使用设备回环 IPv4 地址，不能把电脑的局域网地址和设备回环地址混为一谈。

没有转发时，设备的 localhost 指设备自己，并不会自动访问电脑。找不到 hdc 时，在 DevEco SDK 设置中找到 toolchains 下的 hdc，使用它的实际完整路径运行。

### 真机 / 局域网连接

1. 手机和电脑连接同一个允许设备互通的网络。
2. 在电脑执行 ipconfig，找到实际联网网卡的 IPv4。
3. 停止后端，将 HOST 设为电脑的局域网地址，在同一个终端重启：

```powershell
$env:HOST = Read-Host '电脑实际的局域网 IPv4 地址'
npm start
```

4. 在手机应用中填写 `http://<电脑局域网地址>:<后端端口>`。
5. 根据需要允许后端通过专用网络防火墙；校园网或访客网络可能隔离设备。

HTTP 用于本地开发；正式运行应使用 HTTPS。

## 在 DevEco Studio 运行

1. 打开项目根目录，不是 server 子目录。
2. 等待工程同步，选择与工程 SDK 要求兼容的模拟器或真机。
3. 在 File → Project Structure → Signing Configs 按 IDE 提示配置签名。签名文件和本机配置不随源码提供。
4. 点击 Run，打开“人机？”，填写后端地址并注册或登录。

查看界面预览时，打开 entry/src/main/ets/pages/Index.ets，点击 Previewer 的 Reload。预览构建与真正运行不同，实际注册和聊天需连接后端。若缓存异常，可关闭预览窗、执行 Build → Clean Project，再重新加载。

## 测试聊天

1. 两个设备分别注册不同账号。
2. 账号 B 切换“我是 AI”并开放接聊。
3. 账号 A 保持“我是用户”，刷新 AI 列表，选择 B 发起聊天。
4. A 发送文字，B 打开“收到的对话”并回复。
5. 退出并重新登录，确认历史仍在；停止并重启后端，确认数据保留。

只有一个设备时，可交替登录两个账号测试。继续检查未读数量、暂停接聊、拉黑 / 解除拉黑和长按消息举报。

## 正确关闭与端口排查

结束测试时，先按需要暂停接聊和退出账号；保持设备仍连接，在连接终端清理本项目转发：

```powershell
hdc fport ls
hdc -t $deviceId fport rm "tcp:$backendPort" "tcp:$backendPort"
```

再关闭模拟器，在后端终端按 Ctrl+C，确认返回 PowerShell 提示符。Windows 如询问终止批处理，选择 Y。数据保存在电脑数据库中，不需要删除。

下一次启动后端和模拟器后，先检查设备连接、系统是否完全开机以及 fport ls，再决定是否创建转发。

遇到 TCP Port listen failed 时：

1. 转发表已有正确映射：复用它，不重复创建。
2. 存在失效映射：删除本项目对应规则，再重建。
3. 转发表为空但设备 netstat 仍显示该端口 LISTEN：可能是残留监听，先断开重连指定调试设备。
4. 残留不能清理时，可重启该模拟器内部系统，而不是仅关闭窗口后恢复快照：

```powershell
hdc -t $deviceId target boot
```

等待完全开机和调试连接稳定后再建转发。重启会中断目标设备中的应用和调试连接。不要因设备端口冲突而结束电脑上正常运行的后端。反向映射也使用 fport ls / fport rm 管理。

## 管理员密钥：生成、查看和使用

默认没有管理员密钥时，管理员接口不可用。密钥只用于后端，不放进手机应用。

先停止后端，在其 PowerShell 终端生成密钥：

```powershell
$env:ADMIN_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

密钥保存在这个 PowerShell 进程的环境变量中，没有自动写入文件。在**同一个窗口**输入以下命令查看，并复制结果供管理员操作使用：

```powershell
$env:ADMIN_KEY
npm start
```

如果后端已经在运行，先按 Ctrl+C 才能在同一窗口输入命令。其他 PowerShell 窗口不会自动获得这个变量；关闭原窗口后，需要重新生成并使用新密钥启动后端。不要把输出的真实密钥提交到仓库。

在另一个 PowerShell 窗口输入完整服务基址和刚复制的密钥：

```powershell
$serviceBase = Read-Host '完整后端基址（http://主机:端口）'
$reviewKey = Read-Host '管理员密钥'
$reviewHeaders = @{ 'X-Admin-Key' = $reviewKey }
Invoke-RestMethod "$serviceBase/admin/reports" -Headers $reviewHeaders
```

举报结果中的 sender_id 是被举报消息的发送者。确认后，输入实际待禁用的账号编号：

```powershell
$targetUserId = [int](Read-Host '确认要禁用的账号编号')
$banBody = @{ userId = $targetUserId } | ConvertTo-Json
Invoke-RestMethod "$serviceBase/admin/ban" -Method Post -Headers $reviewHeaders -ContentType 'application/json' -Body $banBody
```

禁用会撤销该账号全部登录令牌、关闭接聊并阻止继续向其发消息。第一版没有管理员网页、解封入口或举报处理状态。

## 数据与当前限制

数据库在 server/data/chat.db，聊天记录保存在服务端。停止后端后，可以复制整个 server/data 文件夹备份；运行期间不要只复制主数据库而遗漏 WAL 文件。

当前没有邮箱验证、密码找回、消息删除、账号注销、图片、自动匹配或系统推送。重启应用后需重新登录；前台更新不等于锁屏通知。请保存测试账号凭据。

消息限制为 1–2000 字符。对话 / AI 列表最多返回 100 条，消息按 100 条分批增量获取。网络中断后手动重试可能重复发送；限流状态随后端进程重启而重置。

## 代码和检查

- entry/src/main/ets/pages/Index.ets：登录、身份大厅、聊天和举报界面。
- entry/src/main/ets/common/Api.ets：HTTP 请求及数据类型。
- server/index.mjs：账号、消息、SQLite、权限和管理员接口。
- server/test/chat.test.mjs：隔离数据库下的 HTTP 回归测试。
- [接口文档](API.md)。

后端检查在 server 目录运行 npm test。鸿蒙编译使用 DevEco Studio 的 Build / Run；签名和设备网络需要按实际环境配置。
