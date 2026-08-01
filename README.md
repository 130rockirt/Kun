<p align="center">
  <img src="src/asset/img/kun.png" width="88" alt="Kun 蓝色 K 标识">
</p>

<h1 align="center">Kun — 本地优先的 AI Agent 工作台（GUI + TUI）</h1>

<p align="center">
  在一个工作台中完成代码、写作、设计、研究与自动化。<br>
  一个共享运行时连接桌面 GUI 和终端 TUI，让任务从澄清、创作、执行到审查和交付始终可见、可控、可回溯。
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases">下载并体验</a>
  &nbsp;·&nbsp;
  <a href="https://www.kun-agent.com/docs">阅读文档</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/KunAgent/Kun">在 GitHub 上 Star</a>
  &nbsp;·&nbsp;
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/KunAgent/Kun/releases"><img src="https://img.shields.io/github/v/release/KunAgent/Kun?label=release" alt="Kun 最新 GitHub Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue" alt="Kun 使用 PolyForm Noncommercial 1.0.0 许可证"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="支持 macOS、Windows 和 Linux">
  <img src="https://img.shields.io/badge/GUI%20%2B%20TUI-one%20shared%20runtime-41c8ff" alt="桌面 GUI 与终端 TUI 共用一个 Kun 运行时">
</p>

<p align="center">
  <img src="./docs/assets/readme/kun-hero.jpg" alt="Kun 品牌首图：AI Agent 工作台的 Code 界面与共享 GUI、TUI 运行时" width="100%">
</p>

## Kun 是什么

Kun 是一款本地优先的 AI Agent 工作台，面向需要把想法真正推进到可验收结果的人。它把 Code、Write、Design、研究和自动化放到同一个产品中，并让桌面 GUI、终端 TUI、后台任务和连接手机通过同一个 `kun serve` 运行时共享线程、计划、审批、模型连接和任务记录。

它不是另一个只会生成回答的聊天框：Kun 帮你把需求、上下文、计划、文件改动、测试、审查和最终交付放在一条连续工作流中。

## 1 分钟了解 Kun

| 你关心的问题 | Kun 的答案 |
| --- | --- |
| **适合谁** | 开发者、写作者、设计师、研究人员，以及需要把重复工作交给 AI 的个人和团队。 |
| **能做什么** | AI 编程与代码审查、AI 写作与文档导出、AI 设计与交互原型、PDF/图片研究、多 Agent 自动化。 |
| **如何使用** | 在桌面 GUI 中观察任务全过程；也可以在终端用 TUI 保持手不离键盘。两者共享同一运行时和任务。 |
| **如何处理复杂任务** | 简单任务使用 Direct 模式；跨文件、跨阶段的任务可使用实验性的 Agent Graph 分工、监督和验收。 |
| **模型是否受限** | 不绑定单一模型，支持多模型选择；可接入订阅登录、Coding Plan、Token Plan、API、OpenAI/Anthropic 兼容服务和自托管模型。 |
| **支持哪些系统** | macOS（Apple Silicon / Intel）、Windows x64 和 Linux x64。 |
| **数据在哪里** | 会话、偏好、日志和运行时数据默认保存在本机；若选择云端模型，提示、附件和任务上下文会发送给该 Provider。 |
| **许可证** | [PolyForm Noncommercial 1.0.0](./LICENSE)：学习、研究和非商业用途可用；商业使用需单独书面授权。 |

## 5 分钟开始

### 下载桌面版

从 [GitHub Releases](https://github.com/KunAgent/Kun/releases) 下载最新版：

| 平台 | 安装包 | 架构 |
| --- | --- | --- |
| macOS | `.dmg` / `.zip` | Apple Silicon / Intel |
| Windows | `.exe` | x64 |
| Linux | `.AppImage` / `.deb` | x64 |

首次启动只需三步：

1. 选择界面语言。
2. 登录模型订阅，或配置 API Key、Token Plan 或自定义 Provider。
3. 打开本地项目或新建工作区，发送一个目标清楚、范围有限且可以验证的任务。

桌面安装包已内置 TUI。在项目目录中打开终端并运行：

```bash
kun
```

GUI 和 TUI 会自动连接同一个本地运行时。服务器或无桌面环境也可以从同一 Release 下载独立 TUI 压缩包；完整使用方法见 [Kun TUI 文档](docs/kun-tui.md)。

## 选择你的工作方式

| 场景 | 你带来什么 | Kun 如何协作 | 可交付结果 |
| --- | --- | --- | --- |
| **Code：AI 编程与审查** | 真实代码库、Bug、功能目标或 Review 任务 | 搜索代码、编辑文件、执行命令、管理 Plan/Todo、查看 Diff 和测试 | 代码改动、测试结果、实施计划、Review findings |
| **Write：AI 写作与文档交付** | 提纲、资料、草稿或选中文本 | 写作、润色、资料整理、内联补全和编辑 | Markdown、HTML、PDF、DOCX、可编辑 PPTX |
| **Design：AI 设计与原型** | 需求、参考图或现有界面 | 探索视觉方向、生成交互原型、沉淀设计系统，并交给 Code 实现 | HTML 原型、设计画布、设计流程、`DESIGN_SYSTEM.md` |
| **Research：多模态研究** | PDF、图片、网页线索或问题 | 阅读资料、提取证据、组织结论、形成可继续的工作上下文 | 研究笔记、结构化结论、方案和后续任务 |
| **Automate：任务与 Agent Graph** | 重复流程、定时任务或复杂目标 | 使用 Schedule、Loop、Hook、MCP、Skills 和受限子代理持续执行 | 自动化记录、任务状态、证据和可恢复的执行历史 |

<p align="center">
  <img src="./docs/assets/readme/create-workspaces.webp" alt="Kun 的 Code 与 Write 工作区：左侧为代码任务工作台，右侧为写作编辑与 AI 操作菜单">
</p>

<p align="center">
  <img src="./docs/assets/readme/research-prototype.webp" alt="Kun 从需求简报生成原型，以及在工作台中阅读 PDF 并进行研究">
</p>

<p align="center">
  <img src="./docs/assets/readme/shared-runtime.webp" alt="Kun 桌面 GUI 与终端 TUI 共用线程和 Graph 任务的示意">
</p>

<details>
  <summary>查看更多 Code 与 Write 实机演示</summary>
  <p align="center">
    <a href="src/asset/img/code.mp4"><img src="src/asset/img/code.gif" width="410" alt="Kun Code 模式的真实操作演示"></a>
    <a href="src/asset/img/write.mp4"><img src="src/asset/img/write.gif" width="410" alt="Kun Write 模式的真实操作演示"></a>
  </p>
</details>

## 从需求到验收

Kun 将“和 AI 对话”变成一条可以回到原始目标检查的工作流：

```text
需求澄清 → 设计 / 写作 / 编码 → 计划与执行 → 审查与测试 → 验收与交付
```

| 阶段 | Kun 如何参与 |
| --- | --- |
| **1. 澄清需求** | 建立需求草稿，结合项目内容补问题、整理边界和验收标准。 |
| **2. 探索方案** | 在 Design、Write 或 Research 中形成视觉方向、原型、资料与方案。 |
| **3. 形成计划** | 使用 `/plan` 将目标拆成可执行步骤，并与需求和 Todo 对齐。 |
| **4. 执行任务** | Agent 搜索、修改、调用工具、运行命令；长任务可以继续、恢复或交给子代理。 |
| **5. 回到验收** | 检查 Diff、测试、浏览器和 `/review` findings，对照原始验收标准确认结果。 |

需求和计划默认保存在项目内，便于版本化、复盘和继续工作。需求变化时，Kun 鼓励重新检查计划和已完成步骤，而不是让旧计划静默继续执行。

## Agent Graph：让复杂任务真正分工

实验性的 Agent Graph 适合跨文件、跨阶段、可以明确验收的复杂任务。Lead Agent 先建立任务依赖图，再按依赖派发受限子代理，持续查看进度、要求补充证据、触发返工，并在必要节点验证通过后交付结果。

Graph 不是第二套运行时，也不会扩大权限：

- GUI 和 TUI 通过同一个 Kun 运行时读取 Graph 状态。
- 子代理只能使用父任务授权范围内的文件、工具、网络、Skills 和 MCP。
- 节点只有经过真实校验和 Lead 明确验收后，才能向下游交接结果。
- 可暂停、恢复、重试、修改任务图或停止；历史执行记录不会被伪装成成功。

简单问答和单点修改使用 Direct 模式更快。详细工作方式和边界见 [Graph Mode 文档](docs/graph-mode.md)。

## 关键能力

| 能力 | 说明 |
| --- | --- |
| **真实项目工作台** | 本地工作区、文件搜索与编辑、Terminal、Browser、Git / Worktree、内联 Diff 和 Changes 面板。 |
| **长任务与上下文** | Plan、Todo、持久目标、会话压缩、分叉、归档、旁支问题、后台 Shell 和子代理。 |
| **模型与额度** | 在一个入口管理订阅、套餐与 API；按默认 Agent、线程、Design、Write、Schedule 或子代理选择模型。 |
| **Agent 与知识** | Agent Profile、长期记忆、项目级 `AGENTS.md`、Skills、MCP 和 Extensions。 |
| **自动化与开放扩展** | 一次性或周期性 Schedule、可视化 Loop、Hook、本地运行 API，以及可安装或侧载的 `.kunx` 扩展。 |
| **多模态与安全** | 图片和 PDF 输入、视觉理解、媒体生成、Sandbox、工具审批、Computer Use 权限和敏感操作确认。 |

## 为什么选择 Kun

| 真实工作中的问题 | 普通聊天框或分散工具 | Kun 的做法 |
| --- | --- | --- |
| 从想法推进到可交付结果 | 在聊天、编辑器、文档和终端之间手动搬运上下文 | Code、Write、Design、Research 和自动化在同一工作台衔接，任务记录可继续。 |
| 判断 Agent 是否真的完成 | 通常只看到最终回答 | 将计划、文件 Diff、工具结果、测试、浏览器操作和审查证据留在任务旁。 |
| 处理跨阶段复杂任务 | 依赖人工逐个拆分和跟进 | 用 Direct 处理轻量任务；用 Agent Graph 建立依赖、分工、监督和验收。 |
| 选择合适的模型与接入方式 | 受限于单一产品或需要分别配置 | 将订阅、Coding Plan、Token Plan、API、兼容服务和自托管模型统一到 Provider 入口。 |
| 在桌面与终端间切换 | 会话和任务状态容易断开 | GUI 和 TUI 共享一个 `kun serve` 运行时，可同时打开并继续同一线程。 |

## 订阅、Provider 与模型

Kun 不绑定某一家模型服务。你可以使用受支持的订阅登录和 Agent SDK，也可以接入 Coding Plan、Token Plan、按量 API、OpenAI Chat Completions / Responses、Anthropic Messages 兼容服务或自托管模型。

预设和接入方式覆盖 ChatGPT / Codex、Claude、Gemini、Cursor、Ollama、DeepSeek、Kimi、GLM、Qwen、MiniMax、Xiaomi MiMo 等生态；具体登录方式、可用模型、地区和额度以当前版本及服务商规则为准。完整 Provider 说明见 [模型 Provider 文档](docs/model-provider-presets.md)。

模型、媒体和高权限能力是否可用，取决于当前版本、操作系统、Provider、模型能力和你的授权。预设是配置起点，不代表账号天然拥有对应模型或额度。

## 常见问题

### Kun 是什么？

Kun 是本地优先的 AI Agent 工作台，用同一个运行时提供桌面 GUI、终端 TUI、代码、写作、设计、研究和自动化能力。

### Kun 适合哪些人？

适合需要把任务从想法推进到真实交付的人：开发者、写作者、设计师、研究人员，以及需要自动化重复工作的小团队。

### Kun 只能用于 AI 编程吗？

不是。Code 只是其中一个工作区；Kun 同时提供 Write、Design、PDF/图片研究、Schedule、Loop、MCP、Skills 和 Extension 能力。

### 必须使用 DeepSeek 吗？

不必。Kun 支持多种订阅、套餐、API、兼容协议和自托管模型；DeepSeek 是可选 Provider 之一。

### “本地优先”是否表示数据绝不会离开电脑？

会话、偏好、日志和运行时数据默认本地保存；但当你选择云端 Provider 时，提示、附件和任务上下文会发送给所选模型服务。使用前请确认对应 Provider 的数据政策。

### GUI 和 TUI 如何共享任务？

它们连接同一个本地 `kun serve` 运行时，因此可以同时打开，并共享线程、计划、审批、用量和后台任务。

### 什么时候使用 Direct，什么时候使用 Agent Graph？

单点修改、简单问答和短任务使用 Direct 更快；需要并行分工、依赖关系、持续监督和明确验收的复杂工作，适合使用实验性的 Agent Graph。

### Kun 支持哪些系统？

桌面版支持 macOS、Windows x64 和 Linux x64；也提供独立 TUI 以适配服务器或无桌面环境。

### Kun 是开源软件吗？可以商业使用吗？

Kun 的源代码可查看并接受贡献，但许可证是 PolyForm Noncommercial 1.0.0，并非 OSI 意义上的开源许可证。学习、研究和非商业用途可用；商业使用、商业分发、SaaS、托管、转售或集成到商业产品中需要单独书面授权。企业仅用于内部员工提效时，可邮件联系申请免费内部使用授权。

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
npm ci
npm run dev
```

单独启动开发版 TUI：

```bash
npm run dev:tui
```

中国大陆网络访问较慢时，可以使用 npm 镜像：

```bash
npm ci --registry=https://registry.npmmirror.com
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

完整的用户文档位于 [kun-agent.com/docs](https://www.kun-agent.com/docs)。仓库中的技术文档适合深入了解某一项能力：

| 文档 | 内容 |
| --- | --- |
| [docs/kun-tui.md](docs/kun-tui.md) | TUI 安装、启动、命令、快捷键、配置和运行时 |
| [docs/graph-mode.md](docs/graph-mode.md) | Agent Graph 的架构、调度、监督、权限和恢复 |
| [docs/DESIGN_MODE.md](docs/DESIGN_MODE.md) | Design 画布、原型、设计系统与 Design → Code |
| [docs/workflow-loop.md](docs/workflow-loop.md) | 可视化 Loop 工作流与自动化思路 |
| [docs/project-mcp-skills.md](docs/project-mcp-skills.md) | 项目级配置、MCP 与 Skill 发现 |
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

[在 GitHub 上关注 Kun 的 Star 与最新发布](https://github.com/KunAgent/Kun)
