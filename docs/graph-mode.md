# Kun Graph Mode 架构与运维指南

Graph Mode 是 Kun 的一种按回合选择的编排策略，不是第二套 Agent
运行时。普通聊天继续走 `direct`；选择 `graph` 后，Lead Agent 先把需求转成
轻量任务意图，宿主把它编译成经过校验的任务图，Kun 在后台调度受限子代理，Lead 只在重要事件发生时监督、
复核和统一交付。这里的 Lead 就是创建 Graph 的原主 Agent；它对过程和结果负责，
会主动查看子代理的实时会话、短暂等待后复查，并在偏离或漏交付时立即指导。

英文版见 [graph-mode.en.md](./graph-mode.en.md)。

## 1. 产品边界

Graph Mode 由三层组成：

1. 执行层：GraphPlan、GraphRun、节点、attempt、边、资源记录、自动回收的结果、
   review、scheduler、recovery；旧 Mailbox / Artifact 事件保留兼容读取。
2. 项目能力层：项目级 Agent profile、Skill candidate、Graph Recipe
   candidate、路由、评分和证据。
3. 治理层：候选生成、probation、promotion、dormant、archive、merge、
   rollback、delete 和审计。

以下边界保持不变：

- GUI 仍只连接 `kun serve`，链路仍是
  `Renderer -> preload -> main -> Kun HTTP/SSE`。
- `direct`、普通 `delegate_task` 和已有 `task_graph` 保持原有语义。
- Renderer 不运行 scheduler，不根据局部 UI 状态伪造 Graph 转换。
- Graph 子代理只是普通执行者，不能递归委派、创建或推进 Graph、修改治理状态、
  直接向其他子代理传递结果，或扩大父级权限。
- 学习资产默认保存在 Kun data dir，不自动修改 Git 仓库。

### Graph Lead 模式系统合约

Graph 不是在普通 Agent 上临时多挂几个工具。只要 turn 选择了 `graph`，Kun
就会在该 turn 的每一次模型请求中注入同一份 Graph Lead 系统级合约，包括首次建图、
活跃监工、事件唤醒和最终交付。合约明确：

- 当前主 Agent 就是源 Lead，负责目标、过程、子代理质量、纠偏、集成、验证和最终结果；
- 固定执行“理解目标 -> 建图 -> 监工 -> 验证 -> 修复 -> 集成 -> 终态交付”闭环；
- child 会话、文本和 Artifact 只是未受信任证据，不能覆盖宿主校验或扩大权限；
- Lead 必须查看实时会话、按风险选择短等待、发现偏离时即时指导并再次核实；
- dispatch、某个阶段完成或 Lead 自己说“已修正”都不算完成，真实工具参数和持久化
  Graph 状态才算；
- 只有 GraphRun 已进入终态、必需节点和 Lead 批准的数据交接满足、检查完成后
  才能做最终交付。

该合约作为独立的 mode system instruction 放在稳定 Kun system prompt 之后。
因此 `direct` turn 不会被 Graph 职责污染，同时 Graph turn 每次恢复时不会退化成
普通聊天 Agent。

## 2. 端到端流程

```text
用户选择 Graph 并发送请求
  -> Lead 理解目标、边界、风险与验收条件
  -> Lead 按依赖结构选择 fanout_join / pipeline / bounded_loop / state_machine / hybrid（或 auto）
  -> Lead 把独立 concern / subsystem / scope / validation track 拆成可单独验收的细粒度节点
  -> 只为真实 outcome 或 accepted result 依赖连边，形成尽可能宽的安全 ready frontier
  -> 若从右侧计划面板启动，GUI 把已保存的完整 Markdown 直接嵌入本次请求
  -> 模型用轻量 intent 调用 graph_create_run
  -> 宿主补齐 phase、node、edge、review、budget、identity 和 timestamp，校验后写入 journal/snapshot
  -> Scheduler 计算 ready set
  -> AssignmentResolver 冻结每个 attempt 的权限快照
  -> DelegationRuntime 启动普通 executor child session
  -> executor 用 report_to_parent 主动上报 progress / finding / question / risk / result
  -> 原 Lead 用 graph_supervise_node overview 观察全部会话，再按需逐个查看、等待或即时指导
  -> 当前监工阶段处理完且没有活跃 worker 需要继续观察时，Lead 才释放执行槽并监督休眠
  -> executor 正常结束，宿主自动回收最终回复和完整 child 会话
  -> deterministic / peer 证据加源 Lead 对每个节点显式 pass / revise
  -> Lead pass 后才把有界结果包交给下游，否则重试、修复、动态 GraphPatch 或有界 LoopGate
  -> material signal 唤醒同一个 Lead turn 检查、汇报、修复、重试、改图或换人
  -> 完成条件、阻塞消息、活跃 worker、写入集成和资源清理全部关闭
  -> GraphRun 进入 completed / failed / cancelled
  -> 同一个 Lead turn 最后一次醒来，生成统一交付并结束
  -> 异步生成已脱敏 Episode，按策略做项目能力沉淀
```

GraphRun 独立于单次模型请求和网络流，但不脱离创建它的源 Lead turn。等待节点期间，
宿主只暂停该 turn 的进程内执行并释放模型并发槽，持久化 turn 仍是 `running`；
重要事件到来时恢复同一个 `sourceTurnId`。只有 GraphRun 已进入终态且 Lead 完成最后
交付后，源 turn 才结束。原生 Graph Lead 不受普通 direct turn 的模型步数和墙钟上限
终止，而由 GraphRun 默认七天的墙钟和资源账本治理；显式 extension budget 仍然生效。
GUI 重连时先读取 HTTP snapshot，再从已确认的 sequence 继续 SSE replay。

从计划面板启动时，`.kunsdd/plan/*.md` 可能是未纳入 Git 的 GUI 文件，隔离 worktree
不会天然包含它。Graph 创建回合又必须先调用 `graph_create_run`，不能先用读取工具。
因此请求会携带保存后的完整计划正文；Lead 必须直接据此建图，并把每个 executor 的
目标写成自包含任务，不得创建一个只负责在 worktree 中重读该计划路径的 snapshot 节点。

## 3. 核心契约

所有 Graph 契约位于 `kun/src/contracts/graph.ts` 和
`kun/src/contracts/graph-agents.ts`，均带显式版本。

- `GraphPlanV1`：phase、逻辑 node、typed edge、非 Token 资源限制、completion nodes、
  revision、创建信息，以及已解析的执行策略。
- `GraphRunV1`：当前 revision、run/node/attempt 投影、review、message、
  artifact、cleanup、资源 ledger 和最终 summary。
- `GraphNodeAttemptV1`：不可变 assignment snapshot、attempt number、
  loop iteration、child session、result、usage 和失败分类。
- `GraphEventEnvelopeV1`：run/thread、单调 `graphSeq`、revision、checksum
  保护的 domain event、command 和 idempotency key。
- `GraphPatchV1`：base revision、requester、reason 和有限操作集合。
- `GraphWorkerResultV1`：summary、Artifact refs、changed files、checks、
  evidence、risks 和显式消息。
- `GraphAgentProfileVersionV1`：项目 Agent 的不可变版本、能力、生命周期和
  provenance。

边类型：

- `control`：按前驱 outcome 控制调度。
- `data`：命名的结果交接通道；只有源 Lead 验收前驱后，下游才会收到结果包。
- `message`：旧持久化格式仍可读取；新 executor 没有点对点 Mailbox 工具，
  跨节点信息统一经过 Lead 批准的 data handoff。

Graph 事件是唯一运行时真相。模型文本、worker 自称完成、GUI 本地操作都不能直接
把节点置为 accepted。

## 4. 状态机

GraphRun 主状态：

```text
draft -> validating -> ready -> running
running -> pausing -> paused -> running
running -> awaiting_supervision / awaiting_human -> running
running -> completing -> completed
任一允许的非终态 -> failed / cancelled
```

Node 主状态：

```text
pending / blocked -> ready -> queued -> running -> submitted
submitted -> reviewing -> accepted
submitted / reviewing -> repair_required -> ready
可执行状态 -> failed / cancelled / superseded / skipped
```

Attempt 主状态：

```text
queued -> running -> waiting -> submitted -> reviewing -> accepted
queued/running/waiting -> interrupted / cancelled / orphaned
running/waiting/reviewing -> failed / repair_required
```

Reducer 会校验声明的 `from` 与持久化当前状态一致，并拒绝非法跳转。
accepted attempt 永不被 revision 重写；新需求只能创建 superseding revision/node。

## 5. GraphPlan 校验、动态 revision 与循环

宿主在创建和每次 patch 时检查：

- ID 唯一性、edge 引用、phase、entry、reachability 和 completion path。
- node/edge/attempt/revision/并发/token/time/message/Artifact 硬限制。
- control/data/message edge 的合法性。
- assignment、read/write scope、review 和风险策略。
- 普通依赖必须是 DAG。
- 逻辑环必须位于包含显式 LoopGate 的强连通分量内。

`GraphPatch` 使用 compare-and-swap：

- 请求必须携带当前 `baseRevision`、`expectedRevision` 和 `expectedSeq`。
- stale patch 返回 conflict，不产生部分修改。
- 已完成事实保留，replace/remove 通过 supersession 表达。
- patch 后整张图重新校验，通过后一次性写入 `plan_revised`。

LoopGate 必须声明 condition source、continuation target、exit target、
exhaustion target 和最大 iteration。每次继续都会：

1. 写入 `loop_iteration_advanced`。
2. 只重置宿主计算出的 cycle nodes。
3. 保留旧 attempt history，并为新 attempt 写入新的 iteration。
4. 增加全局 loop ledger。

`pending`、`blocked`、`ready`、`queued`、`running`、`submitted` 和 `reviewing`
都不是失败 outcome。condition source 尚未形成真实结果时，LoopGate 不求值，
依赖 `failed` 的 control edge 也保持 blocked；不能提前启动 repair、quality-gate
或 final。

达到 gate 或 run 的非 Token 资源上限时只能走 exhaustion path，不允许再创建 attempt。
重复相同的 normalized failure 达到阈值时不会自动进入持久化 `paused`。
自动尝试仍受预算约束，run 保持在可监督状态，由 source Lead 改变策略（修补、
替换或重新绑定节点）或作出明确的终止决定；只有用户或授权 Lead 的显式控制
才使用 `paused`。

## 6. Scheduler 与资源限制

Scheduler 的派发、资源和状态记录由宿主驱动，但每个节点是否验收和向下游交接
必须由源 Lead 明确决定。Scheduler 负责：

- 解析 control/data dependency 和失败传播。
- 按 priority、node id 和 retry-not-before 选择 ready nodes。
- 全局 `maxConcurrentNodes`、单 run `maxConcurrentNodesPerRun` 和
  `maxConcurrentRuns` 准入。
- 跨 GraphRun 轮转，避免大型图长期占用全部容量。
- attempt、run wall time、node wall time、revision、loop、
  Artifact 和 message 限制。
- capped exponential retry backoff 和失败分类。
- 不可用 DelegationRuntime 时进入 `awaiting_supervision`，等待恢复或 Lead 改变策略，
  不自动写成持久化 `paused`。

默认 GraphRun 总 wall time 为 7 天；单个 node 的宿主硬超时仍为 24 小时，
安静运行 15 分钟只会触发监督检查，不会单独中止节点。这三个限制彼此独立。
模型创建 Graph 时可以省略整个 `budget` 或其中任意机械限制字段。宿主会从当前
Graph 配置补齐 node/edge、并发、attempt、revision、loop、run/node wall time、
message、Artifact 和 `warningRatio`。只有用户或项目明确要求更窄的限制时，计划
才显式提供对应字段；显式值仍必须通过宿主上限校验。

Token 只记录实际用量，用于成本归因和学习证据。GraphPlan、节点、循环和冻结后的
worker assignment 都没有 Token 上限；Scheduler 不会因 Token 数量告警、暂停、
失败或停止派发。

Graph 的并发上限只有在计划暴露多个 ready node 时才有意义。Lead 不能把整个多 concern
需求塞进一个首节点，再用普通依赖把其余工作全部串在后面。对非平凡任务，节点应以
“一个可独立验收的交付”为粒度，并按互不依赖的 concern、subsystem、repository scope
或 validation track 扇出；同属一个 phase 或最后需要统一集成，不构成提前串行的理由。
只有 successor 确实需要 predecessor outcome 时才使用 control edge，确实消费其已验收
结果包时才使用 data edge。工作天然串行时仍保留真实依赖，不为了并发伪造独立性。

`graph_create_run` 成功结果会返回 `executionShape`，包含
已解析的 `strategy`、`initialExecutableNodeIds`、`initialExecutableNodeCount`、
`effectivePerRunConcurrency` 和 `maximumImmediateDispatchCount`。非平凡图只有一个
立即可派发节点时还会附带 informational diagnostic；它不否决已创建的 GraphRun，
用于让 Lead 和排障人员直接看出当前计划没有吃满并发能力。

### 执行策略

Graph 不是只有一种固定拓扑。Lead 根据任务选择策略，宿主再把轻量 intent 编译成同一套
可持久化 GraphPlan：

- `fanout_join`：多个互不依赖的节点并发执行，由后续集成或 Lead 汇总。
- `pipeline`：后一步确实消费前一步已验收结果；省略依赖时宿主按声明顺序串联。
- `bounded_loop`：显式 LoopGate 驱动的有限修复或质量循环。
- `state_machine`：用显式状态节点和转换依赖表达阶段切换；回环仍必须受 LoopGate 限制。
- `hybrid`：同一张图中同时包含并发分支、串行交接和最终集成。
- `auto`：只在 task 依赖已经足够明确时由宿主判断上述策略。

Scheduler 不需要为每种策略复制一套实现；所有模式最终都落实为 ready set 和显式依赖，
所以同一 GraphRun 可以先并发、再串行、之后重新扇出。

每个 node timeout 由宿主 `AbortController` 强制执行。用户 cancel 会先写入
terminal fence，再中止并等待活跃 worker；迟到结果不会进入已取消 GraphRun。

## 7. Assignment 和安全边界

每个 attempt 在派发前冻结 `GraphAssignmentSnapshotV1`：

- profile id/version/origin/name 和 system prompt。
- model、provider、reasoning effort。
- allowed/blocked tools、Skills 和 MCP servers。
- approval policy、sandbox mode、workspace root。
- read/write scope、network 和 time limit。

有效权限始终是父 turn、Graph policy、profile、node 和宿主硬限制的交集。
任何子层只能收窄，不能扩张。worker 还会被强制屏蔽：

- `delegate_task`、`generate_subagent`。
- `graph_create_run`、`graph_patch_run`、`graph_control_run`、
  `graph_review_node`、`graph_supervise_node`。
- 项目 Agent/候选治理工具。
- 父级未授权的网络、MCP、Skill、写路径和 provider。

Graph worker 模型策略默认是 `inherit`，即继承创建该 run 的源 Lead provider、model
和 reasoning effort。设置中也可以选择 `fixed` 的默认 worker provider/model；
该值只用于没有显式 assignment 且项目路由没有选中专用 profile 的隐式 executor。
显式节点/profile 优先，所有固定值仍必须位于冻结的父级模型权限集合内，否则 attempt
在启动前失败关闭。配置变化只影响后续 attempt，不改写历史 assignment snapshot。

Executor context 只包含 task objective、验收条件、授权 scope、上一 attempt 的
有限校验/修复反馈、前置状态，以及源 Lead 已明确批准给当前节点的数据结果包。
control edge 只传 ready 状态，不附带前驱结果；Lead/user private Artifact、点对点
Mailbox、无关 node result 和完整父对话都不会继承。宿主安全边界放在 context
开头，即使尾部被截断也保留。

子代理不需要理解 runId、nodeId、attemptId、edge、Mailbox 或 ArtifactStore。
它只使用 assignment 授权的普通工具完成任务，并可调用 `report_to_parent` 主动上报：
普通进度只持久化；finding、question、risk 和 result 会经过监督合并窗口唤醒 Lead。
run、node、attempt、sender 和唯一 Lead recipient 全由宿主从 child session 推断，
模型不能伪造这些字段。报告只是组织信号，不能验收节点、推进依赖或完成 GraphRun。
子代理最后仍用正常回复说明结果、改动文件、实际检查、证据和风险。宿主自动回收回复
并保留完整 child 会话给 Lead 查看。
重试只补充有界的宿主校验错误和 Lead 修复要求，不再要求子代理调用任何
`graph_worker_*` 工具。

## 8. Lead 工具与执行者边界

新 Graph attempt 只额外暴露宿主管理的 `report_to_parent`，不暴露
`graph_worker_progress`、
`graph_worker_publish_artifact`、`graph_worker_message`、
`graph_worker_receive_messages` 或 `graph_worker_submit_result`。这些旧事件仅用于
兼容读取历史 GraphRun，不参与新流程。

Lead 工具：

- `graph_create_run`
- `graph_control_run`
- `graph_patch_run`
- `graph_review_node`：模型只填写 `runId`、`nodeId`、`outcome`、`summary` 和可选
  evidence / artifact refs / repair instructions / explicit attempt id。Kun 从持久化状态
  解析最新 eligible attempt，并生成 review id、Lead provenance、timestamp、当前
  revision 和 sequence；模型不再手写完整 `GraphReviewResultV1`。
- `graph_supervise_node`：`inspect` 读取有界、脱敏、可续游标的 child 会话；
  `overview` 按节点游标返回全 run 的状态、最新 attempt、实时 activity、最新主动报告
  和少量会话尾部；完整内容仍通过 `inspect` 分页读取；
  `wait` 选择 1–60 秒可中止等待后重新检查；`guide` 先持久化 attempt 定向指导，
  再尽可能即时 steer 正在运行的 child turn，并确认该 attempt 已被回复的阻塞问题。

所有 Graph 流程动作都留在 Lead 和宿主：Lead 查看 executor 会话、即时指导、
验收或要求返工；宿主记录状态、执行校验，并在 Lead 通过后把有界结果投影给计划中
授权的 data-edge 下游。executor 之间不直接传消息，也不自行推进节点。

## 9. Review、监督和完成条件

Review 可以增加 deterministic、peer、human 等证据，但每个可执行节点都必须由
创建 Graph 的源 Lead 显式验收。宿主不会让 worker、peer reviewer 或 Scheduler
替 Lead 生成这张票。critical risk 还可强制 human review；worker 自评不能绕过。
宿主 `validation.valid === false` 时 Lead pass 会被拒绝，review 只能收紧校验，
不能覆盖真实的缺证据、检查失败或 scope 错误；但“没有调用 worker Graph 工具”
不再是错误。

GraphSupervisor 只响应 material signals：

- submitted、failure、stall、conflict、resource-limit、help、recovery、
  completion、user steering、worker report。

普通 progress heartbeat 只更新图，不触发模型轮询。相同信号按窗口合并；
宿主使用 `messageSource: graph_runtime` 恢复或 steer 原始 Lead turn，不再为新格式
GraphRun 创建独立的后台 Lead turn。Lead 每次创建或被唤醒后先读取持久化 Graph
truth，再主动查看有关 worker 的 child 会话；健康时可自行决定例如等待 30 秒后复查，
发现跑偏、漏证据或方案错误时则即时 `guide` 并验证纠正结果。worker 正常结束后，
Lead 必须查看回收的结果和会话，再对该节点调用 `graph_review_node` 做 pass/revise。
没有有效 Lead pass，节点和全部下游保持 blocked。Lead 向用户回报关键进展，并按
证据执行 retry、repair、GraphPatch 或 rebind；只有当前监工阶段已经处理完，且没有
活跃 worker 需要继续观察时，才再次进入监督休眠。

Lead pass 同时就是数据交接决定。宿主会用 data edge 的语义名称，把前驱的 summary、
changed files、checks、evidence、risks 和可选 Artifact 引用组成有界结果包，再注入
被授权的下游 executor。子代理不负责回传协议、同伴通信或流程传递。

必需节点或 completion node 耗尽自动 attempt 时，Scheduler 会保留下游为 blocked，
把 run 置为 `awaiting_supervision` 并唤醒原 Lead，不再先把下游全部 skipped 或直接
结束。Lead 查看会话和校验证据后，可指导并 retry、rebind、patch，或明确 cancel。
完成、失败和取消都会触发最后一次唤醒和交付。

GraphRun 只有同时满足以下条件才进入 completed：

- required 和 completion nodes 已 accepted/superseded。
- 不存在 pending/ready/queued/running/submitted/reviewing node。
- 所有 required review（包括每个节点的源 Lead review）已通过。
- 旧 GraphRun 中遗留的 blocking Mailbox 已解决。
- 写入已安全集成或有明确的人类处置。
- 资源记录已收敛。
- final synthesis 已持久化。
- lease/worktree/journal cleanup disposition 已持久化。

最终 summary 包含统一答案、evidence refs、changed files、checks、风险、
token/time 和 revision 信息，而不是简单拼接 worker 文本。

## 10. 写入隔离与冲突处理

每个 node 必须声明 repository-relative read/write scopes。路径遍历、绝对路径和
超出 scope 的变更会被拒绝。

三种策略：

- `serialize`：写节点串行。
- `lease`：不重叠 scope 可并发，重叠 scope 等待。
- `worktree`：配置允许且 workspace 为 Git repository 时，为并发写节点创建
  隔离 worktree。

Worktree capture 会 stage 全部新增、修改、删除和空文件，再生成相对 base
revision 的 binary patch。集成前检查 changed files 均在冻结 scope 内，并执行
stale/dirty/conflict 检查。安全 patch 幂等 apply；未知用户 dirty changes 或
冲突进入 needs-human。未 accepted、conflict、orphaned 或唯一含未合并变更的
worktree 永不自动删除。

## 11. 项目 Agent、路由与评级

项目身份按以下顺序稳定解析：

1. 规范化 Git remote identity hash。
2. Git common dir。
3. canonical workspace root。

因此同一 repository 的多个 worktree 可共享项目 Registry。资产默认保存在 data
dir，运行时 attempt 始终引用不可变 profile version。

Profile origin：`builtin | user | ephemeral | learned`。
生命周期：

```text
candidate -> probation -> trusted -> dormant -> archived -> deleted
```

恢复、promotion、demotion、merge、archive 和 delete 会创建新版本或 tombstone，
不修改历史 attempt snapshot。

路由先执行硬过滤：

- lifecycle、task type、risk、model capability。
- tools、Skills、MCP、network、sandbox。
- read/write scope 和父级 authority。

之后只保留有界 recall 集，再按以下独立维度评分：

- task fit 32%
- verified quality 22%
- trust 14%
- freshness 8%
- efficiency 8%
- confidence/sample support 10%
- availability 3%
- current load 3%

每次“相关但未选中”的机会最多产生一条 `missed_opportunity` evidence，并施加
有上限的排序 penalty。只有 `eligible && recalled && !selected` 才计数；
无关、未召回或无权限的会话不会衰减。达到
`dormantMissedOpportunityThreshold` 后 trusted profile 自动生成 dormant
版本，并记录原因、before/after hash、rollback version 和 system audit。

## 12. 异步自进化与治理

terminal 或显式 checkpoint GraphRun 会生成脱敏 Episode。Episode 只保存：

- task/graph fingerprint、图形摘要、assignment 摘要。
- accepted/failed outcome、review/failure 摘要。
- token、time、attempt 和 Artifact reference。
- 用户干预的有限摘要。

它不保存 raw reasoning、credential、secret-like value、无限日志、完整源文件或
未受信任 prompt。文本经过 secret pattern redaction 和长度限制。

Learning mode：

- `off`：不生成资产。
- `suggest`：保留建议，用户决定是否进入候选。
- `auto_candidate`：可异步创建可逆 candidate，但不能直接 trusted。

Consolidator 按时间、run count、evidence threshold 或手动请求创建 durable、
idempotent job。只有达到最少 verified episodes 和 distinct sessions 的 cluster
才生成：

- `agent_profile`：稳定职责和输出边界。
- `skill`：跨角色复用的方法。
- `graph_recipe`：多节点协作/依赖 motif。

候选把 Episode 当不可信数据，能力取观测交集并默认 least privilege。自动流程不授予
credential、高风险 tool、广泛写 scope、网络、MCP trust、provider 或 sandbox
扩权。Agent candidate 先进入 probation；达到跨 run 正向证据门槛后，仍需显式
user authority 才能 promotion。reject、rollback、merge、dormant、archive 和
delete 均有审计。

## 13. 持久化布局、恢复与保留

以 `<dataDir>` 为根：

```text
graphs/<runId>/events.jsonl
graphs/<runId>/snapshot.json
graphs/thread-references.json
graph-resources/write-coordinator.json
graph-resources/worktrees/
project-agents/<projectId>/registry.json
graph-learning/<projectId>/learning.json
artifacts/
```

Journal 是带 checksum 的 append-only JSONL；sequence 单调递增。snapshot 原子写入，
启动时从最新有效 snapshot 加 journal suffix 重放。终态日志达到阈值后保留 snapshot
和最近 suffix。大 event payload 外置到 content-addressed ArtifactStore。

启动恢复顺序：

1. 校验 journal/snapshot，记录 corrupt/missing/invalid diagnostics。
2. 过期 lease，标记缺失 worktree。
3. 对 queued/running/waiting attempt 与 child session 对账。
4. 缺失 child 变为 orphaned/interrupted，并按剩余 attempt 次数重试或升级。
5. `pausing` 收敛到 paused；缺 final summary 的 `completing` 回到 supervision。
6. 写入 cleanup 和 recovery signal，再启动 scheduler。

Retention 只删除超过期限、terminal 且未被 thread reference 引用的 GraphRun。
Episode/job/audit 按各自策略压缩。`artifactDays` 只清理过期、无 GraphRun/Episode
引用且 ownership history 完整并确认仅属于 Graph 的对象；内容曾被 Web、普通工具
等非 Graph origin 去重共享，或旧 metadata 无法证明完整 ownership 时，保守保留。

Fork 复制不可变 Graph reference/high-water snapshot，不共享 live execution。
Archive 会暂停 active run。Delete 会 fence 新派发、取消并等待 worker、写 terminal
和 cleanup，再删除 thread 引用。

## 14. HTTP、SSE 与工具接口

所有 `/v1` route 使用现有 runtime Bearer auth。主要 GraphRun route：

```text
POST /v1/graphs/validate
GET  /v1/graphs/diagnostics
GET  /v1/graphs
POST /v1/graphs
GET  /v1/graphs/:id
GET  /v1/graphs/:id/events?since_seq=N
GET  /v1/graphs/:id/artifacts/:artifactId?offset=N|start_line=N
POST /v1/graphs/:id/start|pause|resume|cleanup
POST /v1/graphs/:id/cancel
POST /v1/graphs/:id/retry
POST /v1/graphs/:id/steer
POST /v1/graphs/:id/patch
POST /v1/graphs/:id/reviews
```

项目能力 route：

```text
GET  /v1/graph-projects/identity?workspace=...
GET  /v1/graph-projects/:projectId/agents
POST /v1/graph-projects/:projectId/agents/route
POST /v1/graph-projects/:projectId/agents/import
POST /v1/graph-projects/:projectId/agents/merge
GET  /v1/graph-projects/:projectId/agents/:profileId/export
POST /v1/graph-projects/:projectId/agents/:profileId/lifecycle
GET  /v1/graph-projects/:projectId/evidence|scores|routing
GET  /v1/graph-projects/:projectId/candidates|episodes|jobs|audit
POST /v1/graph-projects/:projectId/candidates/:candidateId/action
POST /v1/graph-projects/:projectId/consolidate
POST /v1/graph-projects/:projectId/explore
```

Mutation 请求使用 portable `commandId`、`idempotencyKey` 和适用的
`expectedSeq`/`expectedRevision`。成功响应返回持久化后的 GraphRun，不返回乐观
预测状态。`graph_event` 同时写入 RuntimeEventRecorder；SSE 重连使用现有 thread
event cursor，Graph 专用 events route 可按 `graphSeq` 补齐。

## 15. Workbench 与可访问性

Composer 在 Graph 开启时显示 `Direct | Graph`，选择随 turn 请求发送。
源 Lead turn 在 GraphRun 非终态期间持续显示为 active。此时同一会话里提交的纯文本
不会创建另一个 turn，而是作为该 GraphRun 的 Lead steering 持久化，并唤醒原 Lead；
右侧 `Graph` tab 提供：

- phase 分组、typed edges、LoopGate/revision 标记。
- pan/zoom、minimap、progressive collapse 和大图 list fallback。
- 状态计数、资源使用、critical path、attempt 和当前 Agent。
- node objective、assignment version、tools/Skills、attempt history、
  child session、messages、分页 Artifact 预览、checks、review、writes、worktree 和 error。
- steer、pause/resume、cancel、retry、review、rebind、带 CAS 的通用 GraphPatch、
  candidate governance 和 cleanup。

Artifact 预览只通过带 Bearer auth 的 run-scoped bounded-read route 读取；服务端先
确认 Artifact reference 属于该 GraphRun，再按 byte/line cursor 分页，renderer
只保留当前页。所有 mutation 完成后使用 Kun 返回的持久化 truth，不做乐观拓扑
变更。状态不只靠颜色，节点和控件有 ARIA label、键盘焦点和 screen-reader
summary；系统启用 reduced motion 时关闭动态边。英文和中文 label 均由 locale
资源提供。

## 16. 配置与发布

配置位于 `agents.kun.graph`。默认：

- `enabled: false`
- `defaultStrategy: direct`
- `rolloutStage: stable`
- `learning.mode: off`
- `writeIsolation.mode: serialize`
- `allowWorktrees: false`

其余分组为 `scheduler`、`context`、`mailbox`、`supervision`、
`writeIsolation`、`routing`、`learning`、`retention`。Settings UI 会校验
Graph disabled 时不能把 default strategy 设为 graph，per-run 并发不能高于
全局并发，learning off 时不能启用自动探索。

产品始终按完整的稳定版 Graph 能力运行。旧的 `rolloutStage` 字段仅为降级兼容保留，
不再限制 LoopGate、自动监督或学习；这些能力只由各自的显式设置控制。候选 Agent 的
promotion 仍需要证据和用户授权。

紧急关闭只需设置 `enabled: false` 和 `defaultStrategy: direct`。这会停止新 Graph
创建、自动监督和自动学习，fence 并暂停非终态 run、等待 active worker 收敛；
已有 journal、snapshot、Agent 和 Episode 保持可读。不要通过删除 data dir 做回滚。

## 17. 迁移、降级、备份与恢复

旧 settings 缺少 `graph` 时会补兼容默认值，不创建 GraphRun。旧 thread、普通
child session 和 task DAG 不迁移、不重写。新版 settings 写回时只保留
`agents.kun.graph` 的已知规范字段。

备份前：

1. 暂停 active GraphRuns 或退出 Kun。
2. 复制 `graphs/`、`graph-resources/`、`project-agents/`、
   `graph-learning/` 和被引用的 `artifacts/`。
3. 保留文件权限和目录相对关系。

恢复时先还原到同一 data dir，再启动 Kun；RecoveryService 会重放和对账。不要只
恢复 `snapshot.json` 而遗漏 journal suffix，也不要只恢复 registry 而遗漏它引用的
Episode/Artifact。

降级到不识别 Graph 的版本前先关闭 Graph。旧版本应忽略新增 settings 字段，但不会
维护 active GraphRun，因此必须确保没有 live worker。重新升级后 journal 仍可恢复。

## 18. 事故排查与 orphan cleanup

先调用 `GET /v1/graphs/diagnostics`，再检查对应 run snapshot/events。诊断输出只含
聚合计数和已脱敏错误，不返回 workspace path、prompt、secret 或原始 patch。

常见情况：

- Graph 不创建：检查 `enabled`、turn 的 `orchestration`、rollout settings 和
  `graph_create_run` validation error。`readScopes`/`writeScopes` 必须是仓库相对
  路径；机械 `budget` 字段可省略并交给宿主补齐，不应靠模型复写配置默认值。
- 计划面板 Graph 的首节点报计划文件 `ENOENT`：确认构建请求中包含
  `<implementation_plan>`；节点目标应自包含，不应在隔离 worktree 重读
  `.kunsdd/plan`。
- Node 永久 blocked：检查 required outcome、data Artifact、LoopGate back edge
  和前驱 terminal failure。
- Worker 不退出：cancel Graph；确认 child 收到 abort；查看 cleanup 中 worker/
  lease/worktree 是否 orphaned/preserved。
- Write conflict：不要手动删除 worktree；查看 changedFiles、base revision 和
  integration reason，由人类合并或保留。
- Journal corruption：保留原目录，使用 diagnostics 定位首个坏 record；从可信备份
  恢复 snapshot+journal，不截断唯一副本。
- 重启后 attempt orphaned：RecoveryService 会写入 orphaned 和 retry/supervision；
  确认没有同一 scope 的 live lease 后再手动 retry。
- 重启后源 Lead 仍为 running：启动恢复会读取其 lifecycle cursor，重投未交付的
  supervision/terminal 信号，或恢复崩溃时正在执行的同一个 turn，不创建替代 Lead。
- Learning 候选异常：reject/rollback candidate；检查 provenance Episode 和 audit；
  不要直接编辑 registry JSON。

Cleanup 是幂等操作。accepted worktree 可清理；unaccepted/conflict/orphaned worktree
只会标为 preserved。确认内容已备份或合并后，才可使用正常治理/人工文件操作处理。

## 19. 验证清单

自动检查：

```bash
npm run build:kun
npm run typecheck
npm run test
npm run lint
npm run build
```

发布前手动冒烟：

1. Direct turn 不创建 GraphRun，普通 delegation 不变。
2. Graph turn 创建 attached run；源 Lead 保持 running、休眠时释放执行槽，GUI 收到
   snapshot 和 SSE。
3. 独立节点并行，依赖节点等待；多 run 公平并发。
4. pause/resume/cancel/retry/steer/review/cleanup 均返回 durable truth。
5. cancel 中止 worker，重启可恢复 orphan，重复命令不重复副作用。
6. LoopGate 在上限退出，GraphPatch stale revision 被拒绝。
7. lease/worktree 冲突不覆盖用户改动，未合并 worktree 被 preserved。
8. final review、blocking message、cleanup 未关闭时不能完成；completed、failed、
   cancelled 都由原 Lead turn 做最终交付后才结束。
9. 多会话 Episode 达阈值后生成候选，promotion 需要用户，回滚和审计可见。
10. 关闭 Graph 后 Direct 可用，旧 Graph/Agent/Episode 仍可查看。
