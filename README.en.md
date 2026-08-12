<p align="center">
  <img src="src/asset/img/kun.png" width="88" alt="Kun blue K mark">
</p>

<h1 align="center">Kun — a local-first AI agent workbench</h1>

<p align="center">
  Plan, execute, verify, and deliver real work with AI.<br>
  The desktop GUI and terminal TUI share one local runtime, so tasks, approvals, plans, and evidence stay connected.
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases">Download desktop app</a>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/docs">Documentation</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/KunAgent/Kun">GitHub</a>
  &nbsp;·&nbsp;
  <a href="./README.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases"><img src="https://img.shields.io/github/v/release/KunAgent/Kun?label=release" alt="Latest Kun GitHub release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="Kun uses the PolyForm Noncommercial 1.0.0 license"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Supports macOS, Windows, and Linux">
  <img src="https://img.shields.io/badge/GUI%20%2B%20TUI-one%20shared%20runtime-6366f1" alt="Desktop GUI and terminal TUI share one Kun runtime">
</p>

<p align="center">
  <img src="./docs/assets/readme/code-workspace-empty-demo.webp" alt="Current Kun Code workspace in an isolated demo workspace with no personal conversations" width="100%">
</p>

## What is Kun?

Kun is a local-first workbench that moves AI from answering questions to finishing work. It brings Code, Design, Write, research, and automation to real workspaces: agents can read project context, make plans, use tools, change files, run checks, and keep the evidence next to the task.

The desktop GUI is for seeing, reviewing, and controlling the work. The terminal TUI is for staying in a keyboard-first flow. Both connect to the same local `kun serve` runtime and share threads, goals, plans, approvals, and background work instead of creating disconnected histories.

## At a glance

| Need | Kun provides |
| --- | --- |
| Deliver a code change | A Code workbench, project context, file editing, terminal, Git / Worktree, diffs, tests, and review. |
| Move from a brief to a design | Design tasks inside the same Code thread, with prototypes, design systems, canvases, and Design → Code context. |
| Work with documents and source material | A Write workspace for Markdown/TXT editing plus read-only preview, citation, and analysis of PDF, Word, Excel, and PowerPoint files. |
| Delegate a complex outcome | Direct mode for focused tasks; experimental Agent Graph for dependencies, subagents, supervision, and acceptance. |
| Automate repeated work | Scheduled tasks, Loops, Hooks, MCP, Skills, and installable extensions. |
| Choose how to connect a model | Subscriptions, plans, APIs, OpenAI / Anthropic-compatible services, and self-hosted models through Provider settings. |

## Current interface

Every screenshot below was recaptured with an ephemeral, isolated app profile and an empty demo workspace. No real project, account data, personal settings, or conversation history is shown.

<p align="center">
  <img src="./docs/assets/readme/code-workspace-empty-demo.webp" alt="Current Code workspace with a fresh demo workspace, Code and Design task entry points, and the task composer">
</p>

<p align="center">
  <img src="./docs/assets/readme/agent-graph-demo.webp" alt="Agent Graph visual workbench with demo task nodes, dependencies, execution state, and node details">
</p>

<p align="center">
  <img src="./docs/assets/readme/extensions-demo.webp" alt="Extension management center with built-in extensions, permission state, diagnostics, and installation entry points">
</p>

<p align="center">
  <img src="./docs/assets/readme/scheduled-tasks-demo.webp" alt="Scheduled tasks page with filters, task creation, and keep-awake controls">
</p>

## From goal to acceptance

```text
Clarify the goal → make a plan → execute and collaborate → inspect evidence → deliver or continue
```

1. **State the goal and constraints.** The agent uses project context to surface scope, risks, and acceptance criteria.
2. **Choose the right execution model.** Use Direct for focused tasks; use Agent Graph for cross-file, multi-stage work.
3. **Work in visible context.** Plans, Todos, tool calls, file changes, browser/terminal output, and approvals remain associated with the task.
4. **Deliver with evidence.** Review diffs, tests, reviews, and artifacts; continue, fork, archive, or replan when the requirement changes.

Requirements and plans can live in the project by default, which makes them versionable, reviewable, and easy to resume.

## Agent Graph: reliable delegation for complex work

Agent Graph is for work with clear dependencies and acceptance criteria. A Lead Agent builds the task graph, delegates bounded subagents, follows progress, requests evidence, and accepts important handoffs. It is not a second runtime and it does not expand permissions.

- Subagents can use only the files, tools, network access, Skills, and MCP granted by the parent task.
- A node hands work downstream only after real checks and explicit acceptance.
- You can pause, resume, retry, revise, or stop a graph; historical activity is never presented as success.

See the [Agent Graph guide](docs/graph-mode.en.md) for the model, boundaries, and recovery behavior.

## Local-first does not mean never connected

Sessions, preferences, logs, and runtime data are stored locally by default. When you use a cloud model, prompts, attachments, and task context are sent to the selected Provider; review that service's data policy before use. Tool permissions, sensitive actions, and extension permissions are made visible in the app, and you decide whether to authorize them.

Kun is not tied to one model vendor. Presets cover ecosystems including ChatGPT / Codex, Claude, Gemini, Cursor, Ollama, DeepSeek, Kimi, GLM, Qwen, MiniMax, and Xiaomi MiMo. Sign-in methods, available models, regions, and quotas depend on the current release and Provider rules; see [model provider presets](docs/model-provider-presets.md) for configuration details.

## Get started in 5 minutes

Download the current release from [GitHub Releases](https://github.com/KunAgent/Kun/releases):

| Platform | Installer | Architecture |
| --- | --- | --- |
| macOS | `.dmg` / `.zip` | Apple Silicon / Intel |
| Windows | `.exe` | x64 |
| Linux | `.AppImage` / `.deb` | x64 |

Then:

1. Pick a language and configure a model subscription, plan, API, or custom Provider.
2. Open a local project or create a workspace.
3. Send a clear, bounded task with a way to verify the result.

The desktop app and TUI can connect to the same runtime at the same time. Run this in a project directory:

```bash
kun
```

Standalone TUI archives are also available from Releases. See the [Kun TUI guide](docs/kun-tui.en.md) for commands and configuration.

## Run from source

Requirements: Node.js 22.19+, npm, and at least one usable model connection.

```bash
git clone https://github.com/KunAgent/Kun.git
cd Kun
npm ci
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build the runtime and start Electron development |
| `npm run dev:tui` | Build the runtime and start the terminal TUI |
| `npm run typecheck` | Run TypeScript type checks |
| `npm run lint` | Run ESLint and the file-size check |
| `npm run test` | Run tests |
| `npm run build` | Create a production build |
| `npm run dist:mac` / `dist:win` / `dist:linux` | Build platform installers |

For slower npm access in mainland China:

```bash
npm ci --registry=https://registry.npmmirror.com
```

## Documentation and contributing

| Topic | Guide |
| --- | --- |
| TUI, commands, and runtime | [docs/kun-tui.en.md](docs/kun-tui.en.md) / [kun/README.md](kun/README.md) |
| Agent Graph | [docs/graph-mode.en.md](docs/graph-mode.en.md) |
| Design workflow | [docs/DESIGN_MODE.md](docs/DESIGN_MODE.md) |
| Loops, MCP, and Skills | [docs/workflow-loop.en.md](docs/workflow-loop.en.md) / [docs/project-mcp-skills.md](docs/project-mcp-skills.md) |
| Extension platform | [docs/extensions/README.en.md](docs/extensions/README.en.md) |
| Local development | [docs/DEVELOPMENT.en.md](docs/DEVELOPMENT.en.md) |

Contributions to bug fixes, UI/UX, runtime behavior, Providers, extensions, and documentation are welcome. `develop` is the integration branch; target pull requests at `develop`. Read the [contribution guide](docs/CONTRIBUTING.en.md) first, and accept the [CLA](./CLA.md) for external contributions.

## License

Kun uses the [PolyForm Noncommercial License 1.0.0](./LICENSE) for learning, research, and noncommercial use. Commercial use, distribution, SaaS/hosting, resale, or integration into a commercial product requires separate written authorization from the author.

## Acknowledgements

Thanks to everyone who contributes issues, ideas, code, and documentation.

<a href="https://github.com/KunAgent/Kun/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=KunAgent/Kun" alt="Kun contributors">
</a>
