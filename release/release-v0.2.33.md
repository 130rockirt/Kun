# Kun v0.2.33

v0.2.33 修复 ChatGPT 订阅配置无法保存的问题。升级后，包含 Codex Fast / priority 能力元数据的模型配置可以正常通过主进程校验，不会再出现 `Unrecognized key: "serviceTiers"`。

### 设置保存修复

- `settings:set` 和静默设置保存现在接受模型 profile 中的 `serviceTiers` 字段。
- `serviceTiers` 仍只允许 `priority` 和 `flex`，无效或空的配置会继续被拒绝。
- Provider profile 与 Kun Runtime 的 model profile 使用同一套校验规则，避免相同模型元数据在不同设置入口表现不一致。
- 增加共享设置类型与 IPC schema 的编译期字段完整性检查。以后新增模型 profile 字段但遗漏主进程校验时，类型检查会直接失败。
- 增加 IPC schema 与 `settings:set` handler 回归测试，覆盖 ChatGPT 订阅生成 `serviceTiers: ["priority"]` 的真实保存路径。

### Runtime 稳定性修复

- 系统休眠唤醒或 Runtime 短暂繁忙时，健康检查超时不再清除仍存活进程的发现记录，也不会并行拉起第二个 Runtime。
- Runtime build 发生变化时，如果仍有 Turn 在执行，会延迟切换到新 build，待 Turn 空闲后再进行正常的优雅交接。
- 调整共享 Runtime 的关闭顺序，先暂停/结束活跃任务并关闭长连接，再释放 HTTP server 与发现记录，避免重启后出现 `orphaned_after_restart`。
- bash、MCP 和扩展工具的运行中进度改为有界实时事件：首个运行状态和最终结果会持久化，后续快照不再反复追加到 `messages.jsonl` 与 `events.jsonl`。
- 工具进度会抑制重复快照；线程更新时间改为元数据级更新，不再因一次进度变化重新解析完整会话历史。
- Runtime 启动时先从元数据筛选仍处于 queued/running 的 Turn，只加载确实需要恢复的少数线程，避免重启扫描放大内存占用。
- 对历史版本产生的超大 `messages.jsonl` 自动执行流式安全压缩：保留每个 item 的最终状态并原子替换原文件，无需删除 `~/.kun/data`。
- Thread、Session item 和实时事件缓存增加全局字节预算；超大对象仍可正常读取和发送，但不会长期驻留在可重建缓存中。
- 新增 512 MB V8 堆限制回归门禁，覆盖等效十分钟、每 100 ms 更新、累计至少 500 KB 输出的持续工具任务。

### 升级说明

- 从 `v0.2.32` 升级无需迁移工作区、会话或 Provider 配置。
- 在 `v0.2.32` 中无法完成 ChatGPT 订阅设置的用户，升级后可直接重新点击保存或完成配置。
- 旧版本因工具进度产生的膨胀会话会在后续加载或工具完成时自动压缩；原子替换失败时保留原始文件，不会删除会话。
- 已保存的 API Key、模型连接和会话数据不受影响。

### 完整变更

https://github.com/KunAgent/Kun/compare/v0.2.32...v0.2.33
