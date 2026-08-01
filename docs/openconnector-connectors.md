# 内置本地连接器（OpenConnector）

Kun 的“连接器中心”把 OpenConnector 作为随桌面应用安装的本地 sidecar 运行。它负责
provider catalog、OAuth 凭据、Action 执行和运行审计；Kun 负责模型工具、工作区文件
边界和用户审批。这个集成不要求安装 Node，也不会把 OpenConnector 的上千个 provider
实现复制到 Kun 中。

## 开始使用

1. 从工作台左侧边栏打开 **Connectors**。第一次打开会按需启动本地 sidecar，并加载目录。
2. 在页面顶部启用“Enable connector tools”，然后在推荐卡或全部目录中选择服务。
3. 选择认证方式，填写 API key、custom credential，或先保存自己的 OAuth App 配置，再创建
   一个具名账户连接。一个 provider 可以保留多个账户；名为 `default` 的连接是默认账户，也可
   用 **Make default** 将其他账户与当前默认账户安全交换。
4. 在 provider 详情中检查 Action、所需 scope 和权限提示；连接后可以在“Runs”按 service、
   Action、调用来源和成功/失败状态筛选脱敏执行记录。

启用开关控制 Kun agent 是否获得连接器工具；打开连接器中心本身可以启动 sidecar 来配置
账户。关闭开关不会删除已有账户或凭据。

### 本地端口与 OAuth 回调

sidecar 默认只监听 `127.0.0.1:18898`，不会监听局域网地址。若端口已经被其他进程占用，
Kun 不会终止该进程，而会在页面显示错误；在左侧的 Loopback port 中改成可用端口
后重新启动即可。

OAuth App 必须登记连接器中心显示的**精确**回调地址：

```text
http://127.0.0.1:18898/oauth/callback
```

端口改为 `19001` 时，回调地址也会变为：

```text
http://127.0.0.1:19001/oauth/callback
```

不要把它替换成 `localhost`、添加 provider 路径，或复用旧端口；OAuth provider 要求
redirect URI 完全匹配。飞书扫码创建应用时，OpenConnector 会通过飞书官方应用配置 API 自动
登记这个精确地址，成功后才保存应用凭据并进入账户授权；端口变更后需要重新扫码登记。高级
手动 OAuth 配置仍需用户在应用控制台登记页面显示的地址。

## OAuth 与账户

这是纯本地模式：Kun 不提供远程 OAuth broker，也不会代管 OAuth App。飞书和钉钉默认通过
官方扫码协议在本机获取并加密保存应用凭据；企业微信与邮箱使用官方页面引导。只有高级手动
配置才要求用户填写 client ID、client secret 等字段。点击授权后，Kun 使用系统浏览器打开
provider 的官方授权页面并轮询本地回调结果；取消、拒绝或超时不会创建连接。

Google Workspace（Gmail、Google Calendar、Google Drive）、Microsoft 365（Outlook
Email、Outlook Calendar、SharePoint、Teams）和 Atlassian（Jira、Confluence）提供配置
复用提示，便于把同一 OAuth client 的必要字段填入相关服务。复用的是应用配置，不是账户
token：每个服务和每个具名账户的授权、刷新 token 与权限仍彼此隔离。重新授权可替换失效
授权；断开连接只删除选定账户。

Teams 仅支持 Microsoft 工作/学校账户。组织租户可能要求管理员代表用户同意 Graph 权限；
如果授权页或连接器中心提示 admin consent，请让租户管理员完成同意后再重试。对所有服务，
请只请求工作流所需的最小 scopes，并先在 provider 详情预览权限。

## 首版推荐目录

连接器中心的推荐产品卡共 12 张：

| 产品卡 | 首版核心工作流 |
| --- | --- |
| Atlassian Rovo | 映射为 Jira + Confluence；不调用独立 Rovo 专有 API |
| Box | 账户、搜索、文件夹/文件详情、上传下载、建目录、移动、删除 |
| Figma | 文件、项目、组件和协作数据检查 |
| Gmail | 搜索/读取、草稿和发送邮件 |
| Google Calendar | 日历与事件查询、管理 |
| Google Drive | 查找、读取、上传和整理文件 |
| Notion | 页面、数据库和内容搜索/管理 |
| Outlook Calendar | calendar view、事件、free/busy、创建/更新/删除、RSVP；创建/更新返回 provider ID 与标准化日程 |
| Outlook Email | 读取、整理和发送 Outlook 邮件 |
| SharePoint | site、文档库、文件、list 和 list item 的查询及常用增删改/传输 |
| Slack | 频道、消息读取和协作消息发送 |
| Microsoft Teams | 已加入团队、频道、消息/回复查询，以及发送/回复消息 |

目录与 provider 本身是动态的：当前版本未随 sidecar 提供的服务会显示为不可用。已有的
MCP 连接器仍保持原样；内置 OpenConnector 不会向 `~/.kun/mcp.json` 写入、导入、迁移或
删除任何用户的 MCP 配置。对于新连接，推荐优先使用本地连接器中心，而非重复新增 Google
Workspace 直连 MCP。

## Agent 执行与审批

模型只获得一小组稳定工具，用于列出应用/账户、搜索和读取按需 Action schema、执行
Action，以及受控上传/保存文件；不会把整个 catalog 的 Action schema 放入模型上下文。

- 标为 `read` 的 Action 可通过只读路径执行。未标注的 Action 一律按 `unknown` 对待。
- `write`、`send`、`delete` 和 `unknown` 均必须经过 Kun 审批，即使当前 agent 是
  full-access；审批内容应与 provider 的 Action/权限预览一起核对。
- Plan 模式只可浏览目录、搜索、查看详情和调用明确标为只读的 Action。所有外部写入、发送
  和删除都会被拒绝。
- 写操作会带由 Kun tool-call ID 派生的幂等键。网络中断且外部结果未知时，Kun 不会自动重放；
  请先到对应服务核实是否已执行，再决定是否重试。
- provider 的 allow/block policy 可以限制可执行 Action 或代理；它是额外限制，不能绕过 Kun
  的审批。

## 文件与数据边界

OpenConnector 不能任意读取桌面或工作区绝对路径。Kun 只会把已获授权的工作区文件上传为短期
transit file；下载结果也先以短期引用返回。若要把下载内容保存到工作区，仍会走 Kun 的文件
变更审批。大结果沿用 Kun 的截断和 artifact offload，而不是无限写入模型上下文。

首次启动生成的 sidecar admin token、runtime token、数据库加密密钥和实例证明密钥分别保存为
Kun 用户数据目录内加密的本地 bootstrap 数据。admin token 和数据库密钥只注入 sidecar；runtime
token 与实例证明密钥只注入 sidecar 和由桌面端托管的 Kun 子进程，Kun 会在创建其他工具子进程前
捕获并清除这两个环境变量。它们不会暴露给 renderer、公开设置、通用 IPC、模型或日志。运行记录
和错误详情会脱敏 callback URL、token、secret、下载链接等敏感字段。

## 排障

1. 在 Connectors 页刷新 Health，确认状态为 running，并记录显示的 runtime/protocol version。
2. 若提示端口冲突，选择未被占用的本地端口，重启 sidecar，并在 OAuth App 中同步更新精确
   redirect URI。
3. 若目录不可用，先确认安装包包含校验过的 OpenConnector runtime；开发模式只能通过显式
   `KUN_OPENCONNECTOR_RUNTIME_DIR` 指向本地构建，不能依赖相邻源码目录。
4. 若飞书出现 `20029`，说明该应用未登记当前精确回调。升级到包含自动登记修复的 runtime 后
   重新扫码；不要继续使用修复前创建的应用。其他 OAuth 失败则核对 client ID/secret、回调
   地址、scopes、账户类型和管理员同意。
5. 若 Action 被拒绝，检查 Kun approval、Plan 模式、provider policy 和账户已授予的 scopes。
   网络结果未知时先在外部系统确认，不要盲目重放。

sidecar 数据位于 Kun 用户数据目录的 `connectors/open-connector`，与 Kun runtime 数据分开，
其数据库迁移由 OpenConnector 执行。日志只应使用 Kun 的脱敏日志；排障报告不要附上 bootstrap
文件、OAuth secret、runtime/admin token 或未脱敏的回调 URL。

### 开发与打包输入

开发模式可以设置 `KUN_OPENCONNECTOR_RUNTIME_DIR`，指向已经解压且包含 `runtime.json` 的
runtime 根目录。正式打包不读取相邻源码仓库：向 electron-builder 提供
`KUN_OPENCONNECTOR_RUNTIME_ARCHIVE` 和 `KUN_OPENCONNECTOR_RUNTIME_MANIFEST`，或先运行：

```bash
node scripts/prepare-open-connector-runtime.cjs \
  --archive /absolute/path/to/open-connector-runtime-1.4.0.tar.gz \
  --manifest /absolute/path/to/manifest.json
```

准备脚本会按 `resources/open-connector/open-connector.lock.json` 校验版本、协议、文件大小和
SHA-256，再原子解压到被 git 忽略的 `resources/open-connector/current`。发布 CI 必须从受控
artifact 存储下载这两个输入；不得退回到本机 sibling checkout。仓库的三个桌面打包 workflow
会读取 repository variables `KUN_OPENCONNECTOR_RUNTIME_ARCHIVE_URL` 和
`KUN_OPENCONNECTOR_RUNTIME_MANIFEST_URL`，只接受无内嵌凭据的 HTTPS 地址，并在提取前按同一
lock 校验下载结果。两个变量必须一起配置。

## 发布前人工 smoke matrix

自动测试覆盖协议、隔离、审批和基础流程；发布前仍需使用用户自备测试 OAuth App 做一次人工
验证。每个平台验证从最终安装包中启动，而不是从源码目录启动。

| 平台/运行时 | 必验项 |
| --- | --- |
| macOS arm64、macOS x64 | runtime archive/manifest/校验和、sidecar health、OAuth callback、上传下载、正常退出 |
| Windows x64 | 同上，并验证端口冲突不杀进程、系统浏览器回调和路径/文件审批 |
| Linux x64 | 同上，并验证打包后的 Node 启动、权限和日志目录 |
| 所有平台 | OpenConnector 的 `node:sqlite` 兼容性、LICENSE/NOTICE、安装包体积和 sidecar 崩溃后的有限重启 |
| 每个推荐服务 | 用独立测试账户完成连接、刷新/权限不足、分页/限流和一个代表性 read 与需审批 write/send/delete；Google、Microsoft、Atlassian 同时验证共享 OAuth App 配置不会共享账户 token |
| Teams | 使用可授予管理员同意的 Microsoft 365 测试租户，验证工作/学校账户限制、admin consent、读消息与发送/回复 |

对 Box、SharePoint 和文件类操作，额外确认上传只接受被授权的工作区文件，下载写入工作区前有
文件变更审批；对所有写入类 smoke，验证审批记录、幂等键和“结果未知不自动重放”的提示。
