# Kun v0.2.37

v0.2.37 重点完善探索型子代理（explore_agent）的只读调查链路与展示体验，同时加固 Agent Graph 并发、Provider 凭据和模型目录的稳定性，并补充自动更新、工具取消与用量计时等运行时能力。

### 探索型子代理

- 新增 `explore_agent` 只读探索工具，支持并行多路调查、Lab 配置和 Codex 快速执行路径；探索任务只读运行，不会修改工作区文件。
- 探索结果在会话中呈现为可展开的 ExplorePeekBody 组件，SubagentCallCard 增加结论处理，消息时间线完整保留探索过程。
- 工具调度策略与消息时间线补齐对 `explore_agent` 的专门处理；强化工具描述后，探索被确立为仓库调查的第一步。
- `explore_agent` 会根据 Lab 设置动态决定是否对外暴露，未启用时不会增加无关的上下文与调用开销。

### Agent Graph 与并发稳定性

- Graph 增加线程所有权门禁，避免会话被错误跨线程接管；SSE 观察改为独立观察者，降低并发通知冲突。
- 主导（lead）结算时保留已完成就绪的运行，避免结算顺序问题导致子代理结果被误判为失败。
- 共享 Kun 运行时在发现进程 PID 失效后可以自动恢复，减少僵尸进程导致的连接异常。

### Provider、模型与凭据

- MiniMax 增加 OpenAI-compatible `/v1` endpoint 别名，兼容性模型接入更简单。
- Provider 凭据保存改为保留脱敏凭据，避免异步保存把已填写的 API key 回退为空；空 primary model 不再覆盖当前生效的设置。
- Token Plan 模型目录在注册表并发更新时保持稳定，不再因竞争而丢失。
- 语音转文字设置增加凭据就绪检查；OpenCode Go 的 Chromium Cookie 读取、解密与订阅诊断进一步完善。
- Cursor 集成重新暴露 Kun 独有工具，并排除重叠的 Cursor 内置工具；Codex responses URL 规范化，相关 endpoint 处理更一致。

### 工具、用量与可观测性

- 新增工具取消功能，长时间运行的工具可以主动中断。
- 用量追踪增加计时指标，telemetry 压力管理简化，模型请求处理更稳定。
- 线程快照增加缓存与状态管理，恢复会话时更快、更可靠。

### 更新、发布与 Office

- 自动更新支持原地安装处理与更新残留清理，升级过程更干净。
- Windows 下 `.cmd` 脚本改用 cmd.exe 执行，修复脚本类工具在 Windows 上的运行问题。
- Office/WPS 文档导入时 schema 校验改为软失败，个别文档兼容性问题不再阻断导入。

### 升级说明

- 从 v0.2.36 升级无需手动迁移会话、工作区、Graph 或 Provider 配置。
- 探索型子代理为新增能力，无需迁移历史数据；如未在 Lab 中启用，不会改变既有工作流。

### 完整变更

https://github.com/KunAgent/Kun/compare/v0.2.36...v0.2.37
