<p align="center">
  <img src="src/asset/img/kun.png" width="104" alt="Kun 图标">
</p>

<h1 align="center">Kun</h1>

<p align="center">
  <strong>一个运行时，GUI + TUI，把 AI Agent 真正放进工作流。</strong><br>
  从需求澄清、设计、计划、编码到验收；复杂任务交给 Agent Graph 分工执行，过程可见、可控、可回溯。
</p>

<p align="center">
  <strong>简体中文</strong>
  &nbsp;·&nbsp;
  <a href="./README.en.md">English</a>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/">官网</a>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/docs">文档</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/KunAgent/Kun/releases">下载</a>
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases"><img src="https://img.shields.io/github/v/release/KunAgent/Kun?label=release" alt="GitHub release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="License: PolyForm Noncommercial 1.0.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/GUI%20%2B%20TUI-one%20runtime-41c8ff" alt="GUI and TUI share one runtime">
</p>

## Kun 是什么

Kun 是一个本地优先的 AI Agent 工作台，同时提供桌面 GUI 和终端 TUI。两种界面连接同一个 `kun serve` 运行时，共享线程、模型连接、审批、计划、子代理、用量和后台任务；你可以在桌面里看清完整过程，也可以在终端里保持手不离键盘。

Kun 的重点不是再做一个聊天框，而是把一次真实工作从输入推进到可以验收的结果：

```text
需求澄清 → 设计 → 计划 → 编码 / 执行 → 审查 → 验收
```

- **需求先行**：先明确目标、边界和验收标准，再让 Agent 执行。
- **一个运行时，两种界面**：GUI 与 TUI 可以同时使用，切换界面不丢线程和后台任务。
- **Agent Graph**：把可拆分的复杂任务组织成依赖图，由 Lead Agent 派发、监督、返工和汇总。
- **证据化交付**：文件 Diff、命令结果、测试、浏览器和审查结果都留在任务旁边，不把“Agent 说完成了”当作完成。
- **不绑定单一模型**：统一管理订阅登录、Coding Plan、Token Plan、API Key、兼容服务和自托管模型。

<p align="center">
  <a href="src/asset/img/code.mp4">
    <img src="src/asset/img/code.gif" width="410" alt="Kun Code 模式演示">
  </a>
  <a href="src/asset/img/write.mp4">
    <img src="src/asset/img/write.gif" width="410" alt="Kun Write 模式演示">
  </a>
</p>

## 5 分钟开始

### 下载桌面版

从 [GitHub Releases](https://github.com/KunAgent/Kun/releases) 下载最新版：

| 平台 | 安装包 | 架构 |
| --- | --- | --- |
| macOS | `.dmg` / `.zip` | Apple Silicon / Intel |
| Windows | `.exe` | x64 |
| Linux | `.AppImage` / `.deb` | x64 |

首次启动只需：

1. 选择界面语言。
2. 登录模型订阅，或配置一个 API Key / Token Plan / 自定义 Provider。
3. 在 Code 中打开本地项目，然后发送一个目标清楚、范围有限、可以验证的任务。

桌面安装包已内置 TUI。打开新终端，在项目目录运行：

```bash
kun
```

GUI 和 TUI 会自动连接同一个本地运行时。服务器或无桌面环境也可以从同一 Release 下载独立 TUI 压缩包。完整说明见 [Kun TUI 文档](docs/kun-tui.md)。

## 选择你的工作方式

| 入口 | 适合做什么 | 主要产物 |
| --- | --- | --- |
| **Code** | 理解真实代码库、编辑文件、执行命令、管理计划和审查改动 | 代码 Diff、测试结果、实施计划、Review findings |
| **Design** | 从需求或现有界面探索视觉方向，生成并迭代交互原型 | HTML 原型、设计画布、设计流程、`DESIGN_SYSTEM.md` |
| **Write** | 写作、润色、研究资料、导出文档或生成演示文稿 | Markdown、HTML、PDF、DOCX、可编辑 PPTX |
| **TUI** | 在终端里管理会话、模型、计划、审批、Skills、MCP 和子代理 | 与 GUI 共享的线程、回合和任务结果 |
| **连接手机** | 从飞书 / Lark / 微信或 webhook 触发和继续任务 | IM 会话、后台任务、通知 |

Code、Design 和 Write 不是三套孤立工具。Design 可以把确认后的设计交给 Code 实现，Write 可以沉淀需求和交付文档，它们都复用相同的运行时、Provider、审批和会话能力。

## 从需求到验收

| 阶段 | Kun 如何参与 |
| --- | --- |
| **1. 澄清需求** | 新建需求草稿，让需求 AI 结合项目内容补问题、整理边界和验收标准 |
| **2. 探索设计** | 在 Design 中把需求变成 UI 方向、交互原型或共享设计系统 |
| **3. 形成计划** | 使用 `/plan` 把目标拆成可执行步骤，并与需求和 Todo 对齐 |
| **4. 执行任务** | Agent 搜索代码、修改文件、调用工具、运行命令；长任务可持续恢复 |
| **5. 回到验收** | 检查 Diff、测试和 `/review` findings，对照原始验收标准确认结果 |

需求文档和计划默认保存在项目内，便于版本化、复盘和继续工作。需求变化时，应重新检查计划和已经完成的步骤，而不是让旧计划继续静默执行。

## Agent Graph：让复杂任务真正分工

实验性的 Graph 模式适合跨文件、跨阶段、可以明确验收的复杂任务。Lead Agent 会先建立任务依赖图，再按依赖派发受限子代理，持续查看执行过程、要求补充证据、触发返工，并在所有必要节点通过后统一交付。

Graph 不是第二套运行时，也不会扩大权限：

- GUI 和 TUI 都通过同一个 Kun 运行时读取 Graph 状态。
- 子代理只能使用父任务授权范围内的文件、工具、网络、Skills 和 MCP。
- 节点只有经过真实校验和 Lead 明确验收后，才能向下游交接结果。
- 可暂停、恢复、重试、修改任务图或停止；已发生的执行记录不会被伪装成成功。

简单问答和单点修改使用 Direct 模式更快。Graph 的使用和限制见 [Graph Mode 文档](docs/graph-mode.md)。

## 关键能力

| 能力 | 说明 |
| --- | --- |
| **真实项目工作台** | 本地工作区、文件搜索与编辑、Terminal、Browser、Git / Worktree、内联 Diff 和 Changes 面板 |
| **长任务与上下文** | Plan、Todo、持久目标、会话压缩、分叉、归档、旁支问题、后台 Shell 和子代理 |
| **模型与额度** | 统一管理订阅、API 和套餐连接；切换 Provider / 模型 / 推理强度，并查看支持供应商的额度信息 |
| **Agent 与知识** | Agent Profile、长期记忆、项目级 `AGENTS.md`、Skills、MCP 和 Extensions |
| **自动化** | 一次性或周期性 Schedule、可视化 Loop 工作流、Hook 和本地运行 API |
| **多模态与媒体** | 图片和 PDF 输入、视觉理解、语音转写、图片、语音、音乐和视频生成 |
| **开放扩展平台** | 安装或侧载 `.kunx`，扩展工作台 UI、后台服务、Agent、工具、Provider 和账号接入 |
| **权限与审查** | 工作区范围、Sandbox、工具审批、Computer Use 权限、敏感操作确认和 `/review` |

模型、媒体和高权限能力是否可用，取决于当前版本、操作系统、Provider、模型能力和你的授权。预设是配置起点，不代表账号天然拥有对应模型或额度。

## 订阅、Provider 与模型

Kun 把订阅登录、套餐 Key 和普通 API 放进同一个 Provider 入口：

| 类型 | 当前支持 |
| --- | --- |
| **账号订阅** | ChatGPT / Codex、Claude Pro / Max、Google Antigravity、Gemini CLI、Cursor、Ollama Cloud、Grok |
| **Coding Plan** | 智谱 Coding Plan、Z.ai Coding Plan、火山方舟 Agent Plan、火山方舟 Coding Plan、Kimi coding subscription |
| **Token Plan** | Xiaomi MiMo、MiniMax、阿里云、腾讯云的 Token Plan 入口 |
| **兼容与自托管** | OpenCode Go、Vercel AI Gateway、LiteLLM、LongCat、OpenAI-compatible 和自托管模型 |

具体登录方式、可用模型、地区和额度以当前版本及服务商规则为准；预设是配置起点，不保证账号已经开通对应权限。

会话、偏好、日志和运行时数据默认保存在本机；模型请求使用你配置的服务凭据。退出 GUI 不会终止仍在 TUI 或后台执行的任务，退出 TUI 也不会关闭桌面端。本地优先不等于模型一定在本机推理：除非连接自托管模型，否则提示、附件和任务上下文会发送给所选 Provider。

Kun 把不同接入方式放进同一个模型入口：

- 支持的订阅登录和 Agent SDK；
- Coding Plan、Token Plan 与按量 API；
- OpenAI Chat Completions、Responses、Anthropic Messages 等兼容协议；
- 自定义 Base URL、模型列表、能力声明和自托管服务；
- 为默认 Agent、特定线程、Design、Write、Schedule 或子代理选择不同模型；内置预设还包括 DeepSeek、Xiaomi MiMo、MiniMax、Kimi、GLM、Qwen 等服务。

## 从源码运行

环境要求：

| 依赖 | 版本 |
| --- | --- |
| Node.js | 22.19+ |
| npm | 随 Node.js 安装 |
| 模型连接 | 至少配置一个受支持的订阅、API 或自定义 Provider |

```bash
git clone https://github.com/KunAgent/Kun.git
cd Kun
npm install
npm run dev
```

单独启动开发版 TUI：

```bash
npm run dev:tui
```

中国大陆网络访问较慢时，可以使用 npm 镜像：

```bash
npm install --registry=https://registry.npmmirror.com
```

### 常用开发命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 构建 Kun 运行时并启动 Electron 开发环境 |
| `npm run dev:tui` | 构建运行时并启动终端 TUI |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint 检查 |
| `npm run test` | 运行测试 |
| `npm run build` | 生产构建 |
| `npm run dist:mac` | 构建 macOS 安装包 |
| `npm run dist:win` | 构建 Windows 安装包 |
| `npm run dist:linux` | 构建 Linux 安装包 |

## 文档

面向用户的完整文档位于 [kun-agent.com/docs](https://www.kun-agent.com/docs)。仓库中的技术文档适合开发者和贡献者：

| 文档 | 内容 |
| --- | --- |
| [docs/kun-tui.md](docs/kun-tui.md) | TUI 安装、启动、命令、快捷键、配置和运行时 |
| [docs/graph-mode.md](docs/graph-mode.md) | Graph 架构、调度、监督、权限和恢复 |
| [docs/kun-architecture.md](docs/kun-architecture.md) | GUI、TUI 与单运行时架构 |
| [docs/DESIGN_MODE.md](docs/DESIGN_MODE.md) | Design 画布、原型、设计系统与 Design → Code |
| [docs/workflow-loop.md](docs/workflow-loop.md) | 可视化 Loop 工作流 |
| [docs/project-mcp-skills.md](docs/project-mcp-skills.md) | 项目级配置、MCP 与 Skill 发现 |
| [docs/openconnector-connectors.md](docs/openconnector-connectors.md) | 内置本地 OpenConnector、OAuth、审批、文件边界与发布 smoke |
| [docs/extensions/README.md](docs/extensions/README.md) | Kun Extension 开放平台 |
| [kun/README.zh-CN.md](kun/README.zh-CN.md) | Kun 运行时、CLI、环境变量和 HTTP API |
| [docs/DEVELOPMENT.zh-CN.md](docs/DEVELOPMENT.zh-CN.md) | 本地开发和发布流程 |
| [docs/CONTRIBUTING.zh-CN.md](docs/CONTRIBUTING.zh-CN.md) | 贡献指南 |
| [SECURITY.zh-CN.md](SECURITY.zh-CN.md) | 安全漏洞披露 |

## 贡献

欢迎提交 bug 修复、UI/UX、运行时、Provider、扩展和文档改进。日常集成分支为 `develop`，PR 默认提交到 `develop`；开始前请阅读[贡献指南](docs/CONTRIBUTING.zh-CN.md)，外部贡献需要接受 [Contributor License Agreement](./CLA.md)。

累计有 **5 个 PR 被正常 review 并合入** 后，可以发送邮件到 [zhongxingyuemail@gmail.com](mailto:zhongxingyuemail@gmail.com) 申请成为 Kun Builder，并附上 GitHub 用户名和 PR 链接。

## 许可证

Kun 使用 [PolyForm Noncommercial License 1.0.0](./LICENSE)，仅供学习、研究和非商业用途。商业使用、商业分发、SaaS / 托管服务、转售或集成到商业产品中，需要获得作者的单独书面授权。

企业仅用于内部员工提效时，可发送邮件到 [zhongxingyuemail@gmail.com](mailto:zhongxingyuemail@gmail.com) 免费申请书面内部使用授权。该授权不包含面向外部客户的 SaaS、托管、转售或商业分发。

## 致谢

感谢 [LobsterAI](https://github.com/netease-youdao/LobsterAI)、DeepSeek、Xiaomi MiMo、MiniMax，以及所有提交 issue、建议、代码和文档的贡献者。

<a href="https://github.com/KunAgent/Kun/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=KunAgent/Kun" alt="Kun contributors">
</a>

## Star 历史

[![Star History Chart](https://api.star-history.com/chart?repos=KunAgent/Kun&type=date&legend=top-left)](https://www.star-history.com/?repos=KunAgent%2FKun&type=date&logscale=&legend=top-left)
