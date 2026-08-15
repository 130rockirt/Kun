# Kun v0.3.2

v0.3.2 是一个稳定性热修复版本，修复子代理新建请求被误判为恢复请求、macOS 更新后的旧版 Service Manager 残留，以及 Windows 首次设置无法进入凭据恢复流程的问题；本版本同时开始提供官方 Linux ARM64 安装包。

### 子代理委托修复

- 普通新建子代理时，模型或兼容供应商自动补出的空 `resumeChildId` 与默认 `expectedResumeCount: 0` 现在按未提供处理，不再误入恢复分支。
- `delegate_task` 的模型可见说明明确区分“新建”和“恢复”：新建时必须省略恢复字段，不能使用空字符串或 `"new"` 等占位值。
- 真实恢复请求仍保持严格校验：必须指向确切的中断 child，并继续复用已持久化的 profile、label、return format 与安全边界；恢复时不能重新覆盖创建参数。
- 增加真实失败载荷回归测试，覆盖完整的新建参数、空恢复占位、孤立的非零恢复计数和结构化恢复路径。

### macOS 更新启动恢复（#1169）

- 修复从旧版更新或重启后，ShipIt 临时应用目录中的旧 Service Manager 仍存活时，Kun 反复进入 `active_writer` 启动恢复页面的问题。
- 将“当前能力兼容检查”和“迁移交接认证”分离：普通运行仍要求完整的当前能力集；迁移交接允许识别缺少 `item-page-v1` 的同协议旧 manager。
- 交接前仍会严格核对 loopback discovery、PID、instance ID、启动时间、版本/build 身份，并用 discovery token 验证 `/v1/manager/status`；认证失败或身份不一致时不会关闭进程。
- 认证成功后复用现有的活动任务检查、双 runtime 停止、实例绑定 shutdown 和 PID 退出等待流程，使 `Retry Kun` 能安全替换残留 manager 并继续启动。
- 增加正常兼容、旧版已认证、认证失败和实例身份不一致的回归测试。

### Windows 首次设置凭据恢复

- 修复 Windows DPAPI 保护密钥已不可读时，“保存并继续”只显示 `Shared model connection request failed (HTTP 0)`、无法判断真实原因的问题。
- 修复“暂时跳过”显示原始 `settings:set` IPC 错误，却不提供恢复入口、导致首次设置页面无法关闭的问题。
- 保存和跳过现在统一识别 `credential_key_unreadable`，并进入现有的本地化恢复界面。
- 恢复仍必须由用户显式选择并通过系统确认；重置前会再次验证密钥状态，原密钥和加密凭据会先备份，失败时回滚，不会自动覆盖用户数据。

### Linux ARM64 官方发行（#1168）

- GitHub Release 现提供原生 Linux ARM64 AppImage 与 deb，并保留现有 Linux x64 产物。
- 新增 Linux ARM64 standalone TUI，与 GUI 及其他 TUI 平台共享相同版本、commit 和 runtime build identity。
- ARM64 包使用 GitHub 托管的原生 `ubuntu-24.04-arm` runner 构建，并在上传前校验 AppImage、deb、Electron、OfficeCLI、Whisper 和 Node 原生模块的实际架构。
- 增加独立的 `latest-linux-arm64.yml` 自动更新元数据；R2 归档与 latest promotion 同时要求 x64/ARM64 两套元数据和安装包，避免 ARM 客户端下载 x64 更新。
- 补入上游 OfficeCLI v1.0.141 官方 Linux ARM64 资源，并继续执行固定大小与 SHA-256 校验。
- `@computer-use/libnut-linux` 上游包目前仍只发布 x86-64 原生绑定；ARM64 安装包会明确排除该不兼容二进制，因此该平台暂不提供 Computer Use 桌面控制，其余功能和安装包均保持原生 ARM64。

### 影响与升级

- 子代理问题只影响新 child 的派发：红色错误卡片对应的子代理此前没有真正启动，已经完成的子代理和主任务数据不会受损。
- Service Manager 修复不删除 discovery 或强杀未认证进程，也不会改写会话和工作区数据。
- Windows 凭据恢复只让已有的安全恢复操作变得可达，不会因检测到错误就自动删除或替换凭据。
- Linux ARM64 用户可直接下载 `linux-arm64.AppImage` 或 `linux-arm64.deb`；x64 用户的文件名和更新路径保持不变。
- 从 v0.3.0 或 v0.3.1 升级无需迁移会话、子代理记录、工作区或 Provider 配置；受 #1169 影响的安装在升级后重新启动或点击 `Retry Kun` 即可恢复。

### 完整变更

https://github.com/KunAgent/Kun/compare/v0.3.1...v0.3.2
