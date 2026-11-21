# 第二版部署与日常操作

本文件面向少量测试用户，继续使用 Node.js 24 + SQLite。当前已验证服务脚本、备份恢复和 Compose 配置；本次环境的 Docker 引擎未运行，容器构建、真实 HTTPS 和公网连通尚未验收。服务器与域名尚未准备，因此没有实际上线服务。

## 目录与环境

deploy/Dockerfile 构建非 root 后端镜像；compose.yaml 包含 server、backup、monitor 和可选 Caddy 网关。服务异常退出自动重启，正常停止释放 WebSocket、HTTP 和数据库连接。容器配置了健康检查、资源限制和日志轮换。

测试项目名 human-ai-test，正式项目名 human-ai-production。两者配置、数据卷、备份卷和网段独立，默认本机端口分别为 18787、8787。测试不要使用正式数据库或真实用户账号。

首次部署先安装 Docker Engine / Docker Desktop 并启动引擎，确认 docker info 成功；安装 Node.js 24、npm 和 Compose v2。命令从项目根目录执行。

## 初始化与本机容器测试

```powershell
node .\server\scripts\init-env.mjs --environment test
.\deploy\ops.ps1 validate -Environment test
.\deploy\ops.ps1 build -Environment test
.\deploy\ops.ps1 start -Environment test
.\deploy\ops.ps1 status -Environment test
```

初始化交互输入管理员密码，文件只保存 scrypt 摘要，同时生成监测密钥与邮件验证码密钥。deploy/.env.test 被 Git 忽略，不输出随机密钥，不覆盖已有文件。管理员用户名默认 operator。网页登录使用输入的密码原文，配置中的密码摘要不能代替登录密码。

访问 http://127.0.0.1:18787/health 和 /admin。测试容器只发布到电脑回环端口；鸿蒙设备可用 hdc 反向转发连接。初次启动必须先 build；普通 start 只启动已有镜像，避免改写升级前的回退镜像。

Linux 使用同一套工具，参数为英文 CLI 名称：

```sh
node server/scripts/init-env.mjs --environment test
sh deploy/ops.sh validate --environment test
sh deploy/ops.sh build --environment test
sh deploy/ops.sh start --environment test
```

## 公网 HTTPS 测试服务

准备一台有持久磁盘的服务器与真实域名，域名 A / AAAA 记录指向服务器；只设置实际可达的记录。开放入站 80、443 和所需的运维访问，应用 8787 不向公网直接开放。Caddy 自动申请并续期 TLS 证书，代理 HTTP 和 WebSocket。证书与数据分别使用持久卷。

```powershell
node .\server\scripts\init-env.mjs --environment production --domain 你的实际域名
.\deploy\ops.ps1 validate -Environment production
.\deploy\ops.ps1 build -Environment production
.\deploy\ops.ps1 start -Environment production
```

生成 deploy/.env.production，PUBLIC_ORIGIN 为 https://实际域名，DOMAIN 只填写域名。公网测试可先使用独立的 production 部署项目；如同时保留公开测试与正式站点，须分别使用主机或另行隔离网关和项目，不在同一台主机竞争 80/443。

正式配置拒绝 HTTP 或示例域名。启动后实际检查 HTTPS 证书、/health、管理员登录、两台设备收发与 WebSocket，再把地址嵌入正式客户端。填写隐私政策中的真实支持联系方式、邮件服务商信息和发布说明，然后运行 npm run sync:policy 同步客户端离线政策。

受信代理默认只有 Compose 网关的固定 PROXY_IP。外部 CDN / 代理需要按实际链路填写明确的 IP；服务从受信链路右侧解析 X-Forwarded-For，不信任任意客户端转发头。不在未确认来源时信任整个公网网段。

## 日常命令

```powershell
.\deploy\ops.ps1 status -Environment production
.\deploy\ops.ps1 logs -Environment production
.\deploy\ops.ps1 stats -Environment production
.\deploy\ops.ps1 stop -Environment production
.\deploy\ops.ps1 start -Environment production
.\deploy\ops.ps1 backup -Environment production
.\deploy\ops.ps1 list-backups -Environment production
```

stop 保留数据、备份和证书卷。不要运行 docker compose down -v：该选项会删除持久卷。日志只包含错误类别、状态和管理员操作信息，不输出密码、令牌或完整聊天。不要把 .env、数据库、注销日志、备份或签名文件提交到源码仓库。

网页 /admin 提供用户搜索、举报分页与处理、警告、临时/永久封禁、解封及日志。管理员身份独立于手机账号；网页登录最长 8 小时。封禁立即撤销旧登录并断开实时连接；解封后需重新登录，接聊意愿保持暂停，需要本人重新开放。旧 X-Admin-Key 管理接口默认关闭。

## 邮件接入

当前适配 Resend HTTPS 邮件接口。准备经过验证的发信域名，在对应 .env 文件设置 MAIL_API_KEY、MAIL_FROM，并保留固定 MAIL_CODE_SECRET（至少 32 位随机字符）。MAIL_FROM 例如 人机？ <support@你的实际域名>。密钥仅保存于受限配置中，不放入客户端。配置变化后重新 start，使容器采用新环境。

没有发信配置时界面和 /service/config 明确说明不可用。验证码 10 分钟有效、最多 5 次尝试、一次性使用；错误次数和发信限流写入数据库，重启不会绕过。真实配置后需验证收件、退信、限额、绑定更换、解绑与找回，测试邮箱与真实用户分开。当前测试使用注入的测试 mailer，没有向外部收件人发信。

## 备份与恢复

backup 容器启动后首次备份，之后默认每 24 小时一次。在线备份使用 SQLite 原生备份能力，包含 WAL 中已经确认的消息。每份备份有三件文件：chat-时间-随机值.db、同名 .db.json 清单、同名 .db.deletions.ndjson 注销日志副本；last-success.json 记录最近成功时间。清单保存 SHA-256、schema 版本和数量，保留 30 天。

**最新的 /data/chat.db.deletions.ndjson 必须独立保留和同步。** 它保存 35 天，恢复时与备份附带日志合并，重新应用备份之后的注销。只有旧备份中的日志不能覆盖后来发生的注销。文件为空也要保留；不能为了通过恢复检查人为创建空日志。

```powershell
.\deploy\ops.ps1 list-backups -Environment production
$backupName = Read-Host '列表中的完整备份文件名'
.\deploy\ops.ps1 restore -Environment production -Backup $backupName
```

工具先校验文件名、摘要和数据库完整性，再停止服务，用当前数据卷的最新注销日志恢复，保留原库为 .before-restore-随机值，然后启动。保留的原库也在 30 天后自动清理，只匹配本服务生成的副本文件名。只接受 30 天内的有效备份。恢复会回到备份时间：备份之后新增的普通账号和消息可能丢失，密码也恢复为备份时的摘要；全部普通和管理员登录失效，未用验证码作废，用户需重新登录，必要时用已验证邮箱重新找回。

先在独立测试环境实际恢复并检查账号、消息、编号、注销效果和重新登录，再用于正式环境。本次自动测试已实际完成在线备份、损坏备份拒绝、损坏原库恢复与旧备份注销重放；真实容器卷及异地恢复演练尚未完成。

非容器本机操作（项目根目录，恢复前在服务终端 Ctrl+C 并确认退出）：

```powershell
node .\server\scripts\backup.mjs create .\server\data\chat.db .\server\backups
node .\server\scripts\backup.mjs list .\server\backups
node .\server\scripts\backup.mjs verify .\server\backups\实际备份文件名.db
node .\server\scripts\backup.mjs restore .\server\backups\实际备份文件名.db .\server\data\chat.db --latest-journal .\server\data\chat.db.deletions.ndjson --stopped --replace
```

数据与备份同一主机只能处理误操作，不能抵御主机磁盘丢失。公开测试前配置加密异地副本、最新注销日志同步和访问控制，异地也遵守 30 / 35 天轮换规则。此项仍待选择存储服务并实际演练。

## 升级与回退

先在测试环境运行 npm ci、npm test 并验证新客户端。准备新版源码，每次使用新的镜像标签，不覆盖正在运行的标签：

```powershell
.\deploy\ops.ps1 upgrade -Environment test -Image human-ai:2.0.1
```

工具先构建新镜像，再停服务、备份升级前数据库，记录镜像与备份配对到受限的 .env.test.rollback.json。只有备份成功才切换镜像。新服务健康启动失败时尝试恢复配对备份及旧镜像；失败则按日志处理。验证通过后在正式环境重复流程：

```powershell
.\deploy\ops.ps1 upgrade -Environment production -Image human-ai:2.0.1
.\deploy\ops.ps1 rollback -Environment production
```

rollback 回到升级前数据库和镜像，会丢失升级后普通写入并强制重新登录。保留旧镜像、配对备份和最新注销日志；普通 start 不重新构建镜像。build 只用于明确的首次构建，升级使用 upgrade。若旧 schema 无法安全重放新发生的注销，工具拒绝回退，改用当前版本恢复后向前修复。当前库 schema 为 6，不能把升级后的库直接交给不兼容的旧程序。

## 健康、告警与费用

/health 检查服务和数据库；/internal/metrics 需要独立 X-Metrics-Key，返回运行时间、内存、库容量和版本，不包含聊天。monitor 每分钟检查，连续三次不可达、备份超期、磁盘不足或资源超过阈值会写结构化告警。配置 ALERT_WEBHOOK 后可发送通用 HTTPS JSON：level、code、summary、at。没有 webhook 时只写本地日志。

按实际容量配置 MIN_FREE_MB、MAX_DATA_MB、MAX_RSS_MB、BACKUP_INTERVAL_HOURS；阈值不代表账单上限。真实告警投递、主机宕机的外部探测、异地备份、云平台预算/余额/流量账单提醒尚未接入。选择服务器后在云控制台设置预算告警并验证一次异常通知。

## 当前上线前剩余项

真实服务器/域名及 TLS、Docker 容器运行与重启验收、邮件投递、支持联系方式、异地恢复、外部告警与费用提醒、正式应用签名、Huawei Push Kit 和双设备真机验收。详细项目见 V2_STATUS.md 与 RELEASE.md。
