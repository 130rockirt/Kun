<p align="center">
  <img src="src/asset/img/kun.png" width="104" alt="Kun icon">
</p>

<h1 align="center">Kun</h1>

<p align="center">
  <strong>One runtime, GUI + TUI, and AI agents that work inside a real delivery loop.</strong><br>
  Move from requirements, design, and planning to implementation and verification. Use Agent Graph for complex work while keeping execution visible, controlled, and traceable.
</p>

<p align="center">
  <a href="./README.md">简体中文</a>
  &nbsp;·&nbsp;
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/">Website</a>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/docs">Docs</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/KunAgent/Kun/releases">Download</a>
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases"><img src="https://img.shields.io/github/v/release/KunAgent/Kun?label=release" alt="GitHub release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="License: PolyForm Noncommercial 1.0.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/GUI%20%2B%20TUI-one%20runtime-41c8ff" alt="GUI and TUI share one runtime">
</p>

## What is Kun?

Kun is a local-first AI agent workbench with both a desktop GUI and a terminal TUI. Both clients connect to the same `kun serve` runtime and share threads, model connections, approvals, plans, subagents, usage, and background work. Use the desktop to see the whole process or stay keyboard-first in the terminal without splitting your work across two systems.

Kun is not another chat box. Its job is to move real work from an initial request to a result you can verify:

```text
requirements → design → plan → implementation / execution → review → verification
```

- **Requirement-first**: define the goal, boundaries, and acceptance criteria before execution.
- **One runtime, two interfaces**: use the GUI and TUI at the same time without losing threads or background tasks.
- **Agent Graph**: turn decomposable work into a dependency graph supervised by a Lead Agent.
- **Evidence-driven delivery**: keep diffs, commands, tests, browser checks, and review findings next to the task instead of treating “the agent says it is done” as proof.
- **Provider-flexible**: manage subscription sign-ins, Coding Plans, Token Plans, API keys, compatible endpoints, and self-hosted models in one place.

<p align="center">
  <a href="src/asset/img/code.mp4">
    <img src="src/asset/img/code.gif" width="410" alt="Kun Code mode demo">
  </a>
  <a href="src/asset/img/write.mp4">
    <img src="src/asset/img/write.gif" width="410" alt="Kun Write mode demo">
  </a>
</p>

## Start in five minutes

### Download the desktop app

Get the latest release from [GitHub Releases](https://github.com/KunAgent/Kun/releases):

| Platform | Package | Architecture |
| --- | --- | --- |
| macOS | `.dmg` / `.zip` | Apple Silicon / Intel |
| Windows | `.exe` | x64 |
| Linux | `.AppImage` / `.deb` | x64 |

On first launch:

1. Choose the interface language.
2. Sign in to a supported model subscription, or configure an API key, Token Plan, or custom provider.
3. Open a local project in Code and send a small task with a clear goal, limited scope, and verifiable outcome.

The desktop package includes the TUI. Open a new terminal in a project directory and run:

```bash
kun
```

The GUI and TUI automatically connect to the same local runtime. A standalone TUI archive is also available from the same Release for servers and headless environments. See the [Kun TUI documentation](docs/kun-tui.en.md).

## Choose how you work

| Surface | Best for | Main outputs |
| --- | --- | --- |
| **Code** | Understanding real repositories, editing files, running commands, managing plans, and reviewing changes | Code diffs, test results, implementation plans, review findings |
| **Design** | Exploring visual directions from requirements or existing UI and iterating interactive prototypes | HTML prototypes, design canvases, design flows, `DESIGN_SYSTEM.md` |
| **Write** | Drafting, editing, research, document export, and presentation generation | Markdown, HTML, PDF, DOCX, editable PPTX |
| **TUI** | Managing sessions, models, plans, approvals, Skills, MCP, and subagents from the terminal | The same shared threads, turns, and task results as the GUI |
| **Connect phone** | Starting or continuing work from Feishu / Lark / WeChat or a webhook | IM conversations, background tasks, notifications |

Code, Design, and Write are not isolated tools. Design can hand an approved prototype to Code for implementation, Write can hold requirements and delivery documents, and all three reuse the same runtime, providers, approvals, and thread mechanics.

## From requirements to verification

| Stage | What Kun does |
| --- | --- |
| **1. Clarify** | Create a requirement draft and let Requirement AI inspect the project, find missing questions, define boundaries, and write acceptance criteria |
| **2. Design** | Turn selected requirements into UI directions, interactive prototypes, or a shared design system |
| **3. Plan** | Use `/plan` to split the goal into executable steps aligned with requirements and todos |
| **4. Execute** | Let the agent search code, edit files, call tools, and run commands; long-running work can be resumed |
| **5. Verify** | Inspect diffs, tests, and `/review` findings against the original acceptance criteria |

Requirements and plans are stored in the project by default so they can be versioned, reviewed, and resumed. When a requirement changes, recheck the plan and completed steps instead of silently continuing with stale assumptions.

## Agent Graph: supervised multi-agent work

The experimental Graph mode is designed for complex work that spans files or phases and has explicit acceptance criteria. A Lead Agent builds a dependency graph, dispatches restricted workers as their prerequisites become ready, inspects execution, requests evidence or revision, and delivers only after the required nodes pass.

Graph is not a second runtime and does not grant extra permissions:

- The GUI and TUI read Graph state from the same Kun runtime.
- Workers stay inside the parent turn's file, tool, network, Skill, and MCP boundaries.
- A node can hand results downstream only after real validation and explicit Lead acceptance.
- Runs can be paused, resumed, retried, revised, or stopped without relabeling recorded work as successful.

Direct mode is faster for simple questions and small edits. See the [Graph Mode documentation](docs/graph-mode.en.md) for architecture, limits, and operations.

## Key capabilities

| Capability | What it includes |
| --- | --- |
| **Real-project workbench** | Local workspaces, file search and editing, Terminal, Browser, Git / Worktree, inline diffs, and a Changes panel |
| **Long-running work** | Plans, todos, persistent goals, compaction, forks, archives, side questions, background shells, and subagents |
| **Models and quota** | Subscription, API, and plan connections; provider, model, and reasoning selection; supported-provider quota views |
| **Agents and knowledge** | Agent Profiles, long-term memory, project `AGENTS.md`, Skills, MCP, and Extensions |
| **Automation** | One-time and recurring schedules, visual Loop workflows, hooks, and local run APIs |
| **Multimodal and media** | Image and PDF input, vision, speech-to-text, and image, speech, music, and video generation |
| **Extension platform** | Install or side-load `.kunx` packages for workbench UI, services, agents, tools, providers, and account integrations |
| **Permissions and review** | Workspace scopes, sandbox modes, tool approvals, Computer Use permissions, sensitive-action confirmation, and `/review` |

Availability depends on the Kun version, operating system, provider, model capabilities, and permissions you grant. A preset is a configuration starting point; it does not guarantee that an account has access to a model or quota.

## Subscriptions, providers, and models

Kun puts subscription sign-ins, plan credentials, and regular APIs in one provider entry point:

| Type | Currently supported |
| --- | --- |
| **Account subscriptions** | ChatGPT / Codex, Claude Pro / Max, Google Antigravity, Gemini CLI, Cursor, Ollama Cloud, and Grok |
| **Coding Plans** | Zhipu Coding Plan, Z.ai Coding Plan, Volcano Ark Agent Plan, Volcano Ark Coding Plan, and a Kimi coding subscription |
| **Token Plans** | Xiaomi MiMo, MiniMax, Aliyun, and Tencent Cloud Token Plan entries |
| **Compatible and self-hosted** | OpenCode Go, Vercel AI Gateway, LiteLLM, LongCat, OpenAI-compatible endpoints, and self-hosted models |

Sign-in methods, available models, regions, and quota depend on the current release and provider rules. A preset is a starting point, not a guarantee that an account has access to a model.

Sessions, preferences, logs, and runtime data stay on the local machine by default. Model requests use credentials that you configure. Closing the GUI does not stop work still running in the TUI or background, and closing the TUI does not shut down the desktop client. Local-first does not mean that every model runs locally: unless you connect a self-hosted model, prompts, attachments, and task context are sent to the selected provider.

Kun brings several connection types into one model registry:

- supported subscription sign-ins and Agent SDKs;
- Coding Plans, Token Plans, and pay-as-you-go APIs;
- compatible OpenAI Chat Completions, Responses, and Anthropic Messages protocols;
- custom Base URLs, model lists, capability declarations, and self-hosted services;
- different models for the default agent, a thread, Design, Write, schedules, or individual subagents; built-in presets also include DeepSeek, Xiaomi MiMo, MiniMax, Kimi, GLM, and Qwen.

## Run from source

Requirements:

| Dependency | Version |
| --- | --- |
| Node.js | 22.19+ |
| npm | Ships with Node.js |
| Model connection | At least one supported subscription, API, or custom provider |

```bash
git clone https://github.com/KunAgent/Kun.git
cd Kun
npm install
npm run dev
```

Start the development TUI by itself:

```bash
npm run dev:tui
```

For slower npm access in mainland China:

```bash
npm install --registry=https://registry.npmmirror.com
```

### Common development commands

| Command | Description |
| --- | --- |
| `npm run dev` | Build the Kun runtime and start the Electron development app |
| `npm run dev:tui` | Build the runtime and start the terminal TUI |
| `npm run typecheck` | Run TypeScript checks |
| `npm run lint` | Run ESLint |
| `npm run test` | Run tests |
| `npm run build` | Create a production build |
| `npm run dist:mac` | Build macOS packages |
| `npm run dist:win` | Build the Windows package |
| `npm run dist:linux` | Build Linux packages |

## Documentation

User documentation is available at [kun-agent.com/docs](https://www.kun-agent.com/docs). Repository documentation is aimed at developers and contributors:

| Document | Contents |
| --- | --- |
| [docs/kun-tui.en.md](docs/kun-tui.en.md) | TUI installation, startup, commands, keybindings, configuration, and runtime |
| [docs/graph-mode.en.md](docs/graph-mode.en.md) | Graph architecture, scheduling, supervision, permissions, and recovery |
| [docs/kun-architecture.en.md](docs/kun-architecture.en.md) | The shared runtime architecture for GUI and TUI |
| [docs/DESIGN_MODE.md](docs/DESIGN_MODE.md) | Design canvas, prototypes, design systems, and Design → Code |
| [docs/workflow-loop.en.md](docs/workflow-loop.en.md) | Visual Loop workflows |
| [docs/project-mcp-skills.md](docs/project-mcp-skills.md) | Project configuration, MCP, and Skill discovery |
| [docs/extensions/README.en.md](docs/extensions/README.en.md) | The Kun Extension platform |
| [kun/README.md](kun/README.md) | Runtime, CLI, environment variables, and HTTP API |
| [docs/DEVELOPMENT.en.md](docs/DEVELOPMENT.en.md) | Local development and release workflow |
| [docs/CONTRIBUTING.en.md](docs/CONTRIBUTING.en.md) | Contribution guide |
| [SECURITY.md](SECURITY.md) | Security disclosure |

## Contributing

Contributions are welcome across bug fixes, UI/UX, runtime capabilities, providers, extensions, documentation, and localization. Day-to-day integration happens on `develop`, and pull requests should target `develop` by default. Read the [contribution guide](docs/CONTRIBUTING.en.md) before starting. External contributions require acceptance of the [Contributor License Agreement](./CLA.md).

After **5 pull requests have been reviewed and merged normally**, you may apply to become a Kun Builder by emailing [zhongxingyuemail@gmail.com](mailto:zhongxingyuemail@gmail.com). Include your GitHub username, links to the merged pull requests, and the areas where you want to keep contributing.

## License

Kun is licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE) for learning, research, and noncommercial use. Commercial use, commercial distribution, SaaS / hosted services, resale, or integration into commercial products requires separate written authorization.

Companies using Kun solely to improve internal employee productivity may request free written internal-use authorization at [zhongxingyuemail@gmail.com](mailto:zhongxingyuemail@gmail.com). This authorization does not cover customer-facing SaaS, hosting, resale, or commercial distribution.

## Thanks

Thanks to [LobsterAI](https://github.com/netease-youdao/LobsterAI), DeepSeek, Xiaomi MiMo, MiniMax, and everyone who contributes issues, ideas, code, and documentation.

<a href="https://github.com/KunAgent/Kun/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=KunAgent/Kun" alt="Kun contributors">
</a>

## Star history

[![Star History Chart](https://api.star-history.com/chart?repos=KunAgent/Kun&type=date&legend=top-left)](https://www.star-history.com/?repos=KunAgent%2FKun&type=date&logscale=&legend=top-left)
