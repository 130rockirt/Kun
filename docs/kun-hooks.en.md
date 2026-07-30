# Kun Hooks

This is the full reference for the Kun agent runtime hook system:
design rationale, the six phases with their payloads and powers, the
external command protocol, matching and chaining semantics,
configuration, the embedder API, and security notes. After reading
this you should be able to write a working hook without reading the
source.

The implementation landed in the 2026-06 rework: before it, the hook
engine only had PreToolUse/PostToolUse and no configuration entry
point at all (effectively dead code). After the rework, hooks are a
first-class extension mechanism alongside MCP, skills, memory, and
subagents.

## Design goals

1. **Config-only activation**: users write a top-level `hooks` array
   in `config.json`. No rebuild, no GUI changes required.
2. **Familiar protocol**: the command protocol mirrors Claude Code
   hooks (JSON on stdin, exit 2 blocks, JSON result on stdout) to keep
   migration cheap.
3. **Explicit failure semantics**: security gates fail closed (tool
   phases), convenience injection fails open (prompt phase), observers
   only warn.
4. **One system everywhere**: the main loop, delegated subagents, and
   the CLI (`kun serve` / `kun exec`) share the same hooks.

## Modules and wiring

```text
kun/src/hooks/hook-engine.ts    # phases, payload/result types, matcher, executors
kun/src/hooks/hook-config.ts    # zod schema for config.json + resolveConfiguredHooks
kun/src/hooks/index.ts          # package export (kun/hooks subpath)

config.json (top-level hooks array)
  → KunConfigSchema (kun/src/config/kun-config.ts)
  → ServeOptions (kun/src/cli/cli-options.ts, serve.ts)
  → KunServeRuntimeOptions (kun/src/server/runtime-factory.ts)
      → LocalToolHost(hooks)        # main tool host: PreToolUse/PostToolUse
      → LocalToolHost(hooks)        # subagent tool host: same
      → AgentLoop(hooks)            # lifecycle phases
```

The GUI launches Kun with `--data-dir`, and `{dataDir}/config.json` is
loaded automatically, so for GUI users the hook config lives at:

```text
~/.kun/data/config.json
```

## The six phases

### PreToolUse (before every tool call, can intervene)

Runs before approval and execution. Stdin payload:

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

Result fields:

- `{"decision": "deny", "message": "…"}` — block this call. The model
  receives a `hook_denied` error result; the turn continues.
- `{"decision": "allow"}` — auto-approve: skip the approval prompt
  (as if the user clicked allow). Later hooks can still rewrite
  arguments or deny; any deny overrides an allow.
- `{"arguments": {…}}` — **replaces** the tool arguments wholesale
  (no merge). Later hooks and the execution see the rewritten value.

### PostToolUse (after every tool call, can intervene)

Runs after execution, before the result reaches the model. Payload is
PreToolUse plus `result`:

```json
{ "phase": "PostToolUse", "call": …, "context": …, "result": { "output": …, "isError": false } }
```

Result fields:

- `{"output": …}` — replace the tool output (the model sees the
  replacement).
- `{"isError": true}` — mark the result as an error (combinable with
  `output`).

### UserPromptSubmit (before the turn's first model step, can intervene)

Runs after TurnStart, before the first model call. Payload:

```json
{ "phase": "UserPromptSubmit", "threadId": "…", "turnId": "…", "prompt": "raw user input", "workspace": "/…" }
```

Result fields:

- `{"decision": "deny", "message": "…"}` — reject the whole turn. The
  turn finishes `failed` with a `hook_denied` error item; the message
  is shown to the user.
- `{"additionalContext": "…"}` — inject context. Contributions from
  all hooks merge into one persisted `<hook-context>` user message
  (separate from the user's original message), visible to the model in
  the same turn.
- On exit 0, **plain-text stdout** counts as additionalContext in this
  phase (elsewhere it counts as a message), so the simplest injection
  hook is `echo "deploy freeze today"`.

### TurnStart / TurnEnd / PreCompact (observe-only)

Observation only. Returned values are ignored except `message` (turned
into a warning event); crashes and timeouts produce `hook_warning`
runtime events and never affect the turn.

Payloads:

```json
{ "phase": "TurnStart", "threadId": "…", "turnId": "…", "prompt": "…", "workspace": "/…" }
{ "phase": "TurnEnd",   "threadId": "…", "turnId": "…", "status": "completed|failed|aborted", "error": "…(failures only)" }
{ "phase": "PreCompact","threadId": "…", "turnId": "…", "reason": "(human-readable trigger description)", "mode": "normal|aggressive|force" }
```

Timing notes: TurnEnd runs **after** the turn status is persisted, so
a slow hook never delays the GUI seeing the turn finish. PreCompact
runs after the compaction plan exists and before it executes.

## Matchers (tool phases only)

- `matcher`: a glob over the tool name — `*` matches any run of
  characters, `|` separates alternatives, everything else matches
  literally (regex specials are escaped). Examples: `bash|write_file`,
  `mcp__*`, `mcp__github__*`.
- `toolNames`: exact-name array.
- The hook runs when **either** matches; omit both to run on every
  tool. Lifecycle phases ignore matchers.

## Chaining

Hooks of the same phase run serially in **declaration order**:

- PreToolUse: hook N sees `call.arguments` as rewritten by hook N-1;
  a deny stops the chain (later hooks do not run).
- PostToolUse: hook N sees the `result` as rewritten by hook N-1.
- UserPromptSubmit: a deny stops the chain; additionalContext
  accumulates per hook.

## Command protocol

Each configured hook is a shell command (executed with `shell: true`;
`cwd` defaults to the active workspace, override with the `cwd`
field):

1. The invocation is written to **stdin** as a single JSON document.
2. **Exit 0**: stdout is parsed as a JSON `HookResult`. Unparseable
   plain text becomes additionalContext for UserPromptSubmit and a
   message elsewhere. Empty stdout means no-op.
3. **Exit 2**: blocks. PreToolUse / UserPromptSubmit → deny,
   PostToolUse → `isError: true`; stderr is the reason.
4. **Any other non-zero exit**: a non-blocking `hook_warning` (stderr
   attached). Note this means a hook script crashing (exit 1) does
   **not** block the action — to block, exit 2 explicitly or print
   `{"decision":"deny"}`.
5. **Timeout**: 60 000ms by default (`timeoutMs` overrides). A timeout
   kills the spawned process tree; tool phases treat it as fail-closed
   (`hook_failed` tool error), while UserPromptSubmit and observe-only
   phases degrade to warnings.

## Configuration example

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

A minimal bash-guard.js that rejects dangerous commands:

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

## Embedder API (function hooks)

Callers assembling the runtime as a library can skip the command
protocol and pass in-process functions:

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

`run` receives the full `HookInvocation` discriminated union — narrow
on `invocation.phase` before reading fields. Function and command
hooks can be mixed; chaining order is the same.

## Security

Command hooks execute arbitrary shell commands with the Kun runtime's
privileges. Treat `config.json` as trusted input: never write content
from untrusted sources into the `hooks` array. This matches the trust
model of the MCP `servers` config.

## Events and observability

- `hook_denied` — PreToolUse/UserPromptSubmit rejection (error item +
  event).
- `hook_failed` — a tool-phase hook crashed or timed out (fail
  closed).
- `hook_warning` — non-blocking diagnostics (error events with
  severity `warning`): observer crashes, non-zero command exits,
  prompt-gate crashes.

## Tests and source map

- Engine unit tests: `kun/tests/hooks.test.ts` (matchers, chaining,
  exit-code protocol, timeouts, auto-approve).
- Loop integration: `kun/tests/hooks-lifecycle.test.ts`
  (TurnStart/TurnEnd payloads, deny persistence, `<hook-context>`
  injection, PreCompact, observer fault tolerance).
- Tool host integration point:
  `kun/src/adapters/tool/local-tool-host.ts` (pre/post sections of
  `execute`).
- Loop integration points: `kun/src/loop/agent-loop.ts`
  (`runTurnStartLifecycleHooks` / `runTurnEndHooks` /
  `compactIfNeeded`).

## Known limits and future work

- No GUI settings editor for hooks yet; configuration is
  `config.json` only.
- Subagents reuse the same tool hooks but there is no dedicated
  `SubagentStop` phase.
- Non-blocking warnings from tool-phase hooks are not surfaced as
  runtime events yet (the tool host has no event recorder); only
  lifecycle-phase warnings emit `hook_warning` events.
