# AI 架构漂移控制

单靠提示词无法保证 AI 永远记住全局架构。本方案把关键事实放进版本化仓库，通过“任务前重建上下文、实现前决策、实现后独立验证”降低无意识漂移。

## 三种事实

| 类型 | 载体 | 用途 |
| --- | --- | --- |
| 当前事实 | 当前源码、运行日志、GRASP/源码依赖分析 | 系统现在实际怎样工作 |
| 目标事实 | accepted ADR、合同、架构上下文入口 | 系统获准怎样工作 |
| 任务事实 | 需求、范围、base/head revision、验证证据 | 本次修改要完成什么 |

当前事实与目标事实冲突时，将差异列为待决项。不能因为代码已经这样写就把漂移自动升级为目标架构，也不能因为文档这样写就直接覆盖仍有兼容责任的代码。

## 每次任务必须重建的上下文

在新会话、上下文压缩、任务交接和范围变化后，按顺序读取：`AGENTS.md`、`.governance.yml`、架构上下文入口、相关合同、accepted ADR、实际 imports/changed files、模块 owner。形成一个有边界的任务上下文包：

```markdown
## Task Architecture Context
- Objective: <one sentence>
- Repository revision: <full SHA>
- Dirty paths: <relevant paths or none>
- Scope and owners: <modules/paths and owners>
- Change class / boundary impact: <local|boundary|contract|release + impact>
- Accepted decisions/contracts: <links and applicable sections>
- Invariants: <IDs/rules>
- Verified exemplars: <paths and why they apply>
- Exceptions: <owner/reason/scope/ADR/expiry or none>
- Actual topology evidence: <GRASP/source query>
- Required checks: <exact commands>
- Unresolved mismatches: <facts or none>
```

revision、范围、ADR 状态或引用路径变化后，旧上下文包失效，必须从当前仓库重建。它是证据索引，不是新的架构事实源。

## 模式一致性的正确范围

“所有模块使用同一种设计模式”不是合理目标。前端状态、数据库事务、媒体执行器和供应商适配有不同约束。accepted ADR 应明确模式适用范围，并为该范围给出已验证的范例路径。

局部修改沿用同一范围内范例的接口、错误模型、测试方式和命名。如果新做法会成为共享模式或改变边界，先由架构师决定并接受 ADR，再实施。

## 架构师介入点

- 项目启动时定义边界、职责、决策流程和不变量。
- 实现之前审查跨模块边界、依赖方向、公共合同、持久化、部署、安全和共享模式变更。
- 同一问题路径连续失败三次后停止重复修补，诊断根因。
- 发布前审查迁移、兼容、回滚、环境隔离和未解决漂移。

局部实现完全落在已接受边界内时，由模块负责人按范例执行。实现完成后，Reviewer 独立读取 diff 和实际依赖并执行检查。

## 防止治理规则被绕过

- 业务变更不能在同一 PR 中削弱将要判断它的 governance 配置、workflow 或严重级别。
- 例外必须记录 owner、reason、scope、ADR 和 expiry/review date。
- CI 用完整 commit SHA 固定工具包，以明确 base/head 比较；缺少工具、revision 或必需依赖报告时失败。
- 每次派发子智能体前重新枚举 `.codex/agents/*.toml` 并读取最新选定配置；不缓存角色文件名、不在提示词中冻结模型配置，也不静默替换不可用模型。

现有工具会把治理配置中已建模的 policy weakening 与可信 base 比较并拒绝，例如移除受保护路径、关闭已启用布尔门禁、放宽 baseline 或改变扫描配置。未建模的 workflow 语义、审批权限和其他治理含义仍需独立 Reviewer 判断；即使 workflow 运行通过，如果仓库没有把该 check 配成 required check 或等价 ruleset，它仍可被有合并权限的人绕过。

## 证据新鲜度与扫描覆盖

依赖报告只有在同一次 CI run 中从已经核对为目标 head SHA 的 checkout 现场生成，才能证明该 revision。工作区中的旧 `grasp-report.json`、dependency-cruiser JSON 或其他依赖报告只是历史快照，不能证明当前 head，也不能作为长期维护的架构图。

工具包的 `scripts/governance.mjs check` 负责验证治理配置、ADR 生命周期、显式 base/head 范围，并在项目 pin 或策略要求依赖图时由内部 `scanDependencies()` 在已核对的 checkout 中生成 fresh scan。权威调用会拒绝 `--dependency-input` 和 `--dependency-base-input`；这些参数只提供本地诊断 evidence，不能替代同一次运行的扫描来源或新鲜度。

TypeScript 检查必须把 manifest 中的 `dependency-cruiser` 和 `typescript_companion_package` 按各自固定版本安装在同一隔离工具目录。当前清单为 `dependency-cruiser@16.10.4` 与 `typescript@5.9.3`；缺少兼容解析器时，检查器可能忽略 TS/TSX，造成假通过。CI 除了检查报告文件存在，还必须拒绝零模块报告，并逐个确认每个声明需要扫描 TS/TSX 的源码根实际贡献了 TS/TSX 模块；全局模块总数不能代替逐根覆盖。只包含其他语言或产物类型的根需要单独声明并检查自己的覆盖规则。

`doctor` 只检查已经存在的 Node/Git、配置和 checker runtime，并验证实际版本；`provision` 才允许在项目外的显式目录安装固定版本的 Node 检查器。Python runtime 不由本版本自动创建。项目 launcher 模板可以显式执行 pinned-toolkit `bootstrap`，但 toolkit 的 `governance.mjs` 本身没有隐式下载或 bootstrap 行为。

如果启用了 `scripts/git-custody.mjs`，Git 协作租约位于 Git common directory，供 linked worktree 共享。`acquire`、`status`、`verify`、`release` 和 `recover-expired` 只协调本地授权 worker；过期回收需要先从 `status` 观察 identity，未知 mutex 或租约内容必须 fail closed。该机制是 advisory lease，不替代分支保护，也不自动提交、推送、打 tag 或触发部署。

架构影响变更由新的 Accepted ADR 或 Proposed → Accepted ADR 联合覆盖。每个提供覆盖的 ADR 必须有非空白的 `## Context` 和 `## Decision`，并用单行、逗号分隔的 `Affected paths: path/a, path/b` 声明范围；这些声明合并后必须覆盖每个 changed protected path。结构通过仍不能证明决定质量或批准权限。

## 自动化能保证到哪里

工具可以检查配置格式、受保护路径与 ADR 的结构关联、给定真实依赖图中的循环和禁止依赖，以及外部检查器退出结果。authoritative 检查会在同一 base/head 范围内生成 fresh scan，并比较治理策略；同范围更换 toolkit repository/ref 或 scan pin 会被拒绝。合法升级需通过独立受保护的 adoption 流程并保留初始 adoption 记录。工具仍无法判断架构决定是否优秀、`Accepted` 是否由有权人员批准、范例是否仍适合新业务，也无法仅凭报告文件存在来证明报告对应当前 revision、扫描覆盖完整或源码依赖正确。

提示词和 Skill 负责让 AI 每次重新取回事实；源码生成的 CI 门禁和 Reviewer 才负责执行约束。这个闭环能减少和暴露漂移，但不能承诺项目永远没有技术债或坏代码。
