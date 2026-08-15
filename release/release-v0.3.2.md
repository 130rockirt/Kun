# Kun v0.3.2

v0.3.2 是一个稳定性热修复版本，修复子代理新建请求被误判为恢复请求，以及 macOS 更新后旧版 Service Manager 残留导致启动恢复循环的问题。

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

### 影响与升级

- 子代理问题只影响新 child 的派发：红色错误卡片对应的子代理此前没有真正启动，已经完成的子代理和主任务数据不会受损。
- Service Manager 修复不删除 discovery 或强杀未认证进程，也不会改写会话和工作区数据。
- 从 v0.3.0 或 v0.3.1 升级无需迁移会话、子代理记录、工作区或 Provider 配置；受 #1169 影响的安装在升级后重新启动或点击 `Retry Kun` 即可恢复。

### 完整变更

https://github.com/KunAgent/Kun/compare/v0.3.1...v0.3.2
