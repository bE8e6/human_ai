# 人机？

原生 HarmonyOS 一对一文字聊天应用，使用 ArkTS / ArkUI 和 Node.js + SQLite。这里的“AI”身份由真人扮演，每条回复由另一位真人输入。

当前版本为 **2.0.0**。核心账号、可靠发消息、分页历史、实时同步、举报与网页管理已经实现，部署文件已准备；公网、真实邮件、系统推送、正式签名及真机验收仍待完成。逐项进度见 [第二版完成与待办清单](docs/V2_STATUS.md)。

## 第二版能力

- 设备安全存储登录凭据，重启恢复登录，记住上次身份；断网时可在本机退出和切换账号。
- 消息显示发送中、已发送、失败；原编号重试、服务端去重、每个会话按顺序发送，分别保存草稿。
- 最近消息首屏、较早历史分页、会话和 AI 列表分页、搜索、置顶、仅隐藏本人列表项。
- 前台 WebSocket、心跳重连、游标补齐、轮询回退；双身份未读、可见消息已读和多设备同步。
- 昵称、简介、AI 风格与话题、忙碌、接聊上限、通知偏好；开放接聊与当前在线分别显示。
- 修改密码撤销所有旧登录、设备管理、邮箱验证与找回流程、注销及数据保存规则。
- 黑名单、分类举报、自己的处理状态；电脑浏览器管理台支持账号搜索、警告、封禁、解封和操作日志。
- 数据库版本迁移、令牌摘要、持久限流、在线备份与恢复、Docker / Caddy 部署和监测脚本。

暂停接聊或忙碌只限制新对话，已有对话仍可回复。“移出会话列表”只隐藏自己的列表项；新消息到来时重新显示。前台实时连接不提供锁屏推送。

## 环境

- 后端：**Node.js 24 或更新版本**，npm；SQLite 随 Node 内置。
- 客户端：DevEco Studio 及工程要求的 HarmonyOS SDK，兼容设备；SDK 版本见 build-profile.json5。
- 容器部署：Docker 引擎和 Docker Compose v2；本机脚本还需要 Node.js 24。
- 真机安装：自己的应用签名。源码不包含证书、密码、云端密钥或设备编号。

## 本机启动

以下 PowerShell 命令从项目根目录执行：

```powershell
Set-Location .\server
npm ci
npm test
Set-Location ..
node .\server\scripts\init-env.mjs --environment test
```

按提示输入独立的管理员密码。配置写入被 Git 忽略的 deploy/.env.test；已有配置不会被覆盖。管理员用户名默认 operator，可在该文件修改。

```powershell
Set-Location .\server
$env:HOST = '127.0.0.1'
$env:PORT = '18787'
$env:NODE_ENV = 'test'
node --env-file=../deploy/.env.test index.mjs
```

保留这个终端。打开 [本机健康检查](http://127.0.0.1:18787/health) 和 [管理员页面](http://127.0.0.1:18787/admin)。普通账号在手机应用注册；管理员使用刚设置的独立用户名和密码登录网页。后台没有网页聊天端。

数据库默认位于 server/data/chat.db，启动时自动迁移旧版数据。Ctrl+C 正常关闭服务并释放连接；不要删除数据目录。正式环境和测试环境应使用各自的配置和数据库。

## 连接鸿蒙设备

开发版登录页可保存服务地址。直连本机后端时填写 http://127.0.0.1:18787；设备必须已经建立 USB / 模拟器反向转发：

```powershell
hdc list targets
$deviceId = Read-Host '实际设备标识'
hdc fport ls
hdc -t $deviceId rport tcp:18787 tcp:18787
```

已有同一条 Reverse 映射时直接复用。设备的 localhost 指设备自己，不能直接访问电脑。结束调试后，只清理本项目的映射：

```powershell
hdc -t $deviceId fport rm tcp:18787 tcp:18787
```

同一局域网直连时，停止后端，把 HOST 改为电脑实际局域网 IPv4 后重启；应用填写 http://电脑IPv4:18787。网络需要允许设备互通，防火墙应仅开放所需的开发访问。HTTP 用于开发，公开服务使用 HTTPS。

## 构建与安装

在 DevEco Studio 打开项目根目录，完成工程同步和 Signing Configs，选择兼容真机或模拟器运行。

也可使用构建脚本；安装目录按实际填写：

```powershell
.\build.ps1 -Mode debug -DevEcoHome '你的DevEco Studio安装目录'
```

脚本设置构建所需的 SDK / Java 路径，输出 artifacts 下的 HAP 和 SHA-256 清单。未配置签名时输出 unsigned HAP，须先配置签名再安装。

正式构建必须嵌入真实 HTTPS 地址，登录页不显示开发地址输入：

```powershell
.\build.ps1 -Mode release -DevEcoHome '你的DevEco Studio安装目录' -ServiceUrl https://你的实际域名
```

也可预填 entry/build-profile.json5 的 SERVICE_URL。当前字段为空，脚本会拒绝未配置地址的正式构建。参数临时写入构建字段并在结束后恢复源码。发布前还要设置正式 bundleName、vendor、签名和华为平台应用资料。

## 运维与验收

- [启动、停止、备份、恢复、部署、升级与回退](docs/DEPLOYMENT.md)
- [第二版逐项完成状态与验收记录](docs/V2_STATUS.md)
- [构建、发布和真机验收步骤](docs/RELEASE.md)
- [V2 API](API.md)
- 隐私政策与使用规则：服务的 /privacy、/rules；客户端也提供离线版本。

自动检查在 server 目录执行 npm test。测试使用隔离数据库，不修改本机已有账号和聊天。当前已覆盖旧库迁移、超时重试去重、消息与列表分页、越权、多设备实时同步、管理员权限、邮件流程、注销与实际备份恢复。

尚未配置真实邮件时，邮箱入口说明不可用，接口返回 MAIL_NOT_CONFIGURED。Huawei Push Kit 尚未开通，当前不会发送后台或锁屏系统通知。公开测试前须完成真实部署、支持联系方式、邮件配置、签名安装及 docs/RELEASE.md 中的验收。

## 主要代码

- entry/src/main/ets/components：登录、大厅、聊天、设置、找回与举报等界面组件。
- entry/src/main/ets/pages/Index.ets：页面状态、账号隔离、发送队列和消息同步。
- entry/src/main/ets/common：HTTP、安全存储、实时连接、列表数据源及离线政策。
- server/index.mjs：HTTP 入口、会话权限及消息确认。
- server/database.mjs：版本迁移；其余模块分别处理账号、实时连接、管理、隐私和备份。
- server/admin：浏览器管理页面；deploy 和 server/scripts：部署与运维工具。

仅支持一对一文字聊天。图片、群聊、自动匹配和大模型回复不在当前范围内。
