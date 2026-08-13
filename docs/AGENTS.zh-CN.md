# 代理运行时说明

Kun 桌面应用当前只有一个可运行的本地 Agent 运行时：仓库自带的同名 **Kun** 运行时。

不要新增第二套运行时、运行时切换器、运行时诊断面板，或旧的 CodeWhale / Reasonix 进程路径。Code（含 Design 任务）、Work、连接手机都统一走同一个 Kun HTTP/SSE 边界。连接手机在代码内部仍沿用 `claw` 命名，Work 内部仍沿用 `write` 命名，作为兼容标识。

## 允许的扩展路径

1. 在 `kun/src/contracts/` 中新增协议字段。
2. 在 `kun/src/loop/`、`kun/src/services/` 或 `kun/src/ports/` / `kun/src/adapters/` 下新增端口与适配器来实现新行为。
3. 在 `kun/src/server/routes/` 下新增 HTTP 接口。
4. 在 `src/renderer/src/agent/kun-runtime.ts` 与 `src/renderer/src/agent/kun-mapper.ts` 中完成端点与事件映射。
5. 仅在 `agents.kun` 下新增设置项。

## 隔离计划构建边界

- 计划构建默认使用宿主托管的 Git worktree。Renderer 只负责用户选择与生命周期展示；
  Electron main 负责预检、持久运行记录、Git 协调、目标分支快进与有证明的清理。
- 必须捕获启动任务的精确 checkout、当前分支和 HEAD；不得替换成 `main`、`master`、
  远端默认分支或其他 worktree 的分支。
- Kun 仍是唯一执行运行时。构建使用绑定到外层 worktree 的关联 `side` 会话；Graph
  worker worktree 必须先把结果合入该外层执行分支，根 Graph 才能完成。
- 自动集成只接受结构化的回合、目标、gate 与 Graph 成功状态，不能解析助手文案猜测完成。
- 冲突必须留在隔离 worktree；禁止切换、stash、reset、clean 或强制更新源 checkout。
  清理前必须证明未变化或已合入，并先把执行会话重新绑定到源 checkout。

## 禁止路径

- 不要新增 `AgentSwitcher`。
- 不要新增 `ConnectionStatusBar`。
- 不要新增 `RuntimeDiagnosticsDialog` 或运行时自检 UI。
- 不要恢复 CodeWhale/Reasonix 的适配器、进程管理、RPC 桥、更新器或导入器。
- 不要恢复独立于当前 Design 模式之外的旧绘图/绘画启动卡片。
- 不要新增打开运行时控制面板的 `/usage` 或 `/runtime` 斜杠命令。

## 旧数据兼容规则

旧的持久化 key 仅在 settings 迁移时按只读路径使用：

- `agentProvider: codewhale | reasonix | deepseek-runtime` 映射为 `kun`。
- `agents.codewhale`、`agents.reasonix` 和旧 `deepseek` 的值会一次性写入 `agents.kun`。
- 保存后的 settings 仅保留 `agents.kun`。
- 旧连接手机（内部 Claw）的 `agentThreadIds.codewhale/reasonix` 会并入 `agentThreadIds.kun`。

## 验证清单

执行：

```bash
npm run typecheck
npm test
npm run build
```

手工冒烟检查：

- Code 可以创建 Kun 会话、流式回传回复、进行工具审批/拒绝、以及中断回合。
- CodeWhale 的等价能力应保持在 Kun 下可用：会话搜索/归档筛选、fork、会话恢复、`request_user_input` 提交与取消、usage 查询。
- 缓存指标使用 DeepSeek 原生 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；在稳定前缀热身后，热门对话的 hit rate 应长期保持在 90% 以上。
- 不可变前缀漂移与异常的 tool-call/tool-result 历史必须在请求下发 DeepSeek 前被拦截。
- Code 可在同一会话中切换下一回合的 Code / Design 意图；Design 在共享时间线中创建、
  迭代、预览与导出设计稿。
- Direct / Graph 计划构建可创建隔离 worktree、保留冲突恢复状态、快进捕获的目标分支、
  重绑执行会话，并且只删除已证明安全的临时状态。
- Work 可以打开工作区、发起 inline 补全、使用选中文本助手动作。
- 连接手机可以保存设置，并通过 Kun 会话执行手工任务。
- 设置 -> Agent 仅显示 Kun。

完整方案见 [`docs/kun-architecture.md`](./kun-architecture.md)。
