# Kun Hooks 体系

本文是 Kun agent runtime hook 体系的完整参考：设计动机、六个阶段的
载荷与能力、外部命令协议、匹配与链式语义、配置方法、嵌入方 API 与
安全注意事项。读完本文应当可以在不读源码的情况下写出一个可用的 hook。

对应实现于 2026-06 重构落地：在此之前 hook 引擎只有
PreToolUse/PostToolUse 两个阶段，且没有任何配置入口（等价于死代码）。
重构后 hook 成为 Kun 对外开放的第一类扩展机制，与 MCP、skills、
memory、subagents 并列。

## 设计目标

1. **配置即生效**：用户在 `config.json` 顶层写 `hooks` 数组即可，
   不需要重新编译，不需要 GUI 改动。
2. **协议熟悉**：外部命令协议对齐 Claude Code hooks（stdin JSON、
   退出码 2 阻断、stdout JSON 结构化结果），降低迁移成本。
3. **失败语义明确**：安全门失败要关闭（工具阶段），便利性注入失败
   要放行（prompt 阶段），观察者失败只告警。
4. **全运行时一致**：主循环、子代理（delegation）、CLI
   （`kun serve` / `kun exec`）共用同一套 hook。

## 模块与装配链

```text
kun/src/hooks/hook-engine.ts    # 阶段、载荷、结果类型；匹配器；执行器
kun/src/hooks/hook-config.ts    # config.json 的 zod schema + resolveConfiguredHooks
kun/src/hooks/index.ts          # 包导出（kun/hooks 子路径）

config.json (顶层 hooks 数组)
  → KunConfigSchema (kun/src/config/kun-config.ts)
  → ServeOptions (kun/src/cli/cli-options.ts, serve.ts)
  → KunServeRuntimeOptions (kun/src/server/runtime-factory.ts)
      → LocalToolHost(hooks)        # 主工具宿主：PreToolUse/PostToolUse
      → LocalToolHost(hooks)        # 子代理工具宿主：同上
      → AgentLoop(hooks)            # 生命周期阶段
```

GUI 通过 `--data-dir` 启动 Kun，`{dataDir}/config.json` 自动加载，
所以 GUI 用户的 hook 配置路径默认是：

```text
~/.kun/data/config.json
```

## 六个阶段

### PreToolUse（工具调用前，可干预）

每次工具调用前、审批与执行之前运行。stdin 载荷：

```json
{
  "phase": "PreToolUse",
  "call": {
    "callId": "c_…",
    "toolName": "bash",
    "providerId": "builtin",
    "toolKind": "command_execution",
    "arguments": { "command": "ls" }
  },
  "context": {
    "threadId": "th_…",
    "turnId": "turn_…",
    "workspace": "/path/to/workspace",
    "threadMode": "agent",
    "approvalPolicy": "on-request",
    "sandboxMode": "workspace-write"
  }
}
```

可返回的结果字段：

- `{"decision": "deny", "message": "…"}` — 拒绝本次调用。模型收到
  `hook_denied` 错误结果，回合继续。
- `{"decision": "allow"}` — 自动放行：跳过审批弹窗（等价于用户点了
  允许）。后续 hook 仍可改写参数或拒绝；任何 deny 覆盖 allow。
- `{"arguments": {…}}` — **整体替换**工具参数（不做合并）。后续
  hook 与最终执行看到的都是替换后的参数。

### PostToolUse（工具调用后，可干预）

工具执行完成后、结果写回模型之前运行。载荷在 PreToolUse 基础上多一个
`result`：

```json
{ "phase": "PostToolUse", "call": …, "context": …, "result": { "output": …, "isError": false } }
```

可返回：

- `{"output": …}` — 替换工具输出（模型看到的就是替换后的值）。
- `{"isError": true}` — 把结果标记为错误（可与 output 同时给）。

### UserPromptSubmit（回合开始前，可干预）

回合的第一次模型调用之前运行（在 TurnStart 之后）。载荷：

```json
{ "phase": "UserPromptSubmit", "threadId": "…", "turnId": "…", "prompt": "用户输入原文", "workspace": "/…" }
```

可返回：

- `{"decision": "deny", "message": "…"}` — 拒绝整个回合。回合以
  `failed` 结束，错误项 code 为 `hook_denied`，message 展示给用户。
- `{"additionalContext": "…"}` — 注入上下文。多个 hook 的注入合并为
  一条持久化的 `<hook-context>` 用户消息（与用户原始消息分开），
  模型在本回合即可看到。
- 退出码 0 时的**纯文本 stdout** 在本阶段直接当作 additionalContext
  （其他阶段当作 message），所以最简单的注入 hook 就是
  `echo "今天是部署冻结日"`。

### TurnStart / TurnEnd / PreCompact（只读通知）

只观察，不干预。任何返回值除 `message`（转为告警事件）外都被忽略，
hook 崩溃/超时只产生 `hook_warning` 运行时事件，绝不影响回合。

载荷：

```json
{ "phase": "TurnStart", "threadId": "…", "turnId": "…", "prompt": "…", "workspace": "/…" }
{ "phase": "TurnEnd",   "threadId": "…", "turnId": "…", "status": "completed|failed|aborted", "error": "…(仅失败时)" }
{ "phase": "PreCompact","threadId": "…", "turnId": "…", "reason": "(人类可读的触发描述)", "mode": "normal|aggressive|force" }
```

时序注意：TurnEnd 在回合状态落盘**之后**运行，慢 hook 不会拖慢 GUI
看到回合完成；PreCompact 在压缩计划生成之后、执行之前运行。

## 匹配器（仅工具阶段）

- `matcher`：针对工具名的 glob——`*` 匹配任意字符段，`|` 分隔多个
  备选，其余字符精确匹配（正则特殊字符已转义）。例：
  `bash|write_file`、`mcp__*`、`mcp__github__*`。
- `toolNames`：精确名单数组。
- 两者**任一命中即运行**；都省略则匹配所有工具。
- 生命周期阶段忽略匹配器。

## 链式语义

同一阶段的多个 hook 按**声明顺序**串行执行：

- PreToolUse：hook N 看到的是 hook N-1 改写后的 `call.arguments`；
  deny 立即终止链（后续 hook 不再运行）。
- PostToolUse：hook N 看到的是 hook N-1 改写后的 `result`。
- UserPromptSubmit：deny 立即终止链；additionalContext 逐个累积。

## 外部命令协议

每个配置型 hook 是一条 shell 命令（`shell: true` 执行，`cwd` 默认为
当前 workspace，可用 `cwd` 字段覆盖）：

1. invocation 以单个 JSON 文档写入 **stdin**。
2. **退出码 0**：stdout 按 JSON `HookResult` 解析；解析失败的纯文本
   在 UserPromptSubmit 当 additionalContext，其余阶段当 message。
   stdout 为空表示无操作。
3. **退出码 2**：阻断。PreToolUse / UserPromptSubmit → deny，
   PostToolUse → `isError: true`；stderr 为原因。
4. **其他非零退出码**：非阻断 `hook_warning`（stderr 附带）。
   注意：这意味着 hook 脚本自身崩溃（exit 1）**不会**阻断动作——
   要阻断必须显式 exit 2 或输出 `{"decision":"deny"}`。
5. **超时**：默认 60 000ms（`timeoutMs` 覆盖）。超时杀整棵进程树；
   工具阶段超时按失败关闭处理（`hook_failed` 工具错误），
   UserPromptSubmit 与只读阶段超时降级为告警。

## 配置示例

```json
{
  "hooks": [
    {
      "phase": "PreToolUse",
      "matcher": "bash",
      "command": "node ~/.kun-hooks/bash-guard.js",
      "timeoutMs": 10000
    },
    {
      "phase": "PostToolUse",
      "toolNames": ["write_file", "edit_file"],
      "command": "~/.kun-hooks/format-after-write.sh"
    },
    { "phase": "UserPromptSubmit", "command": "cat ~/.kun-hooks/standing-context.txt" },
    { "phase": "TurnEnd", "command": "~/.kun-hooks/notify-done.sh" }
  ]
}
```

bash-guard.js 拒绝危险命令的最小实现：

```js
let raw = ''
process.stdin.on('data', (c) => (raw += c))
process.stdin.on('end', () => {
  const { call } = JSON.parse(raw)
  const cmd = String(call.arguments.command ?? '')
  if (/rm\s+-rf\s+\//.test(cmd)) {
    console.error('blocked: rm -rf on root path')
    process.exit(2)
  }
  process.exit(0)
})
```

## 嵌入方 API（函数 hook）

以库方式组装运行时的调用方可以绕过命令协议，直接传进程内函数：

```ts
import { LocalToolHost } from 'kun/adapters'
import type { ResolvedHook } from 'kun/hooks'

const hooks: ResolvedHook[] = [
  {
    phase: 'PreToolUse',
    matcher: 'mcp__*',
    run: (invocation) => {
      if (invocation.phase !== 'PreToolUse') return
      return { arguments: { ...invocation.call.arguments, audited: true } }
    }
  }
]
new LocalToolHost({ tools, hooks })
new AgentLoop({ …, hooks })
```

`run` 收到完整的判别联合 `HookInvocation`，先用 `invocation.phase`
收窄再取字段。函数 hook 与命令 hook 可以混用，链式顺序一致。

## 安全

命令 hook 以 Kun runtime 的权限执行任意 shell 命令。`config.json`
必须当作可信输入：不要把不可信来源的内容写进 `hooks` 数组。这与
MCP `servers` 配置的信任模型一致。

## 事件与可观测性

- `hook_denied` — PreToolUse/UserPromptSubmit 拒绝（错误项 + 事件）。
- `hook_failed` — 工具阶段 hook 崩溃或超时（fail closed）。
- `hook_warning` — 非阻断告警（severity `warning` 的 error 事件）：
  观察者崩溃、命令非零退出、prompt gate 崩溃等。

## 测试与源码

- 引擎单测：`kun/tests/hooks.test.ts`（匹配器、链式、退出码协议、
  超时、auto-approve）。
- 循环集成：`kun/tests/hooks-lifecycle.test.ts`（TurnStart/TurnEnd
  载荷、deny 落盘、`<hook-context>` 注入、PreCompact、观察者容错）。
- 工具宿主接入点：`kun/src/adapters/tool/local-tool-host.ts`
  （`execute` 的 pre/post 段）。
- 循环接入点：`kun/src/loop/agent-loop.ts`
  （`runTurnStartLifecycleHooks` / `runTurnEndHooks` / `compactIfNeeded`）。

## 已知边界与后续方向

- GUI 设置页暂无 hooks 编辑界面，配置走 `config.json`。
- 子代理复用同一套工具 hook，但没有独立的 `SubagentStop` 阶段。
- 工具阶段 hook 的非阻断告警目前不产生运行时事件（工具宿主没有事件
  记录器），只有生命周期阶段的告警会以 `hook_warning` 事件浮出。
