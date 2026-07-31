# Kun v0.2.33

v0.2.33 修复 ChatGPT 订阅配置无法保存的问题。升级后，包含 Codex Fast / priority 能力元数据的模型配置可以正常通过主进程校验，不会再出现 `Unrecognized key: "serviceTiers"`。

### 设置保存修复

- `settings:set` 和静默设置保存现在接受模型 profile 中的 `serviceTiers` 字段。
- `serviceTiers` 仍只允许 `priority` 和 `flex`，无效或空的配置会继续被拒绝。
- Provider profile 与 Kun Runtime 的 model profile 使用同一套校验规则，避免相同模型元数据在不同设置入口表现不一致。
- 增加共享设置类型与 IPC schema 的编译期字段完整性检查。以后新增模型 profile 字段但遗漏主进程校验时，类型检查会直接失败。
- 增加 IPC schema 与 `settings:set` handler 回归测试，覆盖 ChatGPT 订阅生成 `serviceTiers: ["priority"]` 的真实保存路径。

### 升级说明

- 从 `v0.2.32` 升级无需迁移工作区、会话或 Provider 配置。
- 在 `v0.2.32` 中无法完成 ChatGPT 订阅设置的用户，升级后可直接重新点击保存或完成配置。
- 已保存的 API Key、模型连接和会话数据不受影响。

### 完整变更

https://github.com/KunAgent/Kun/compare/v0.2.32...v0.2.33
