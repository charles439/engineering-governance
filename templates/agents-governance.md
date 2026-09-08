## 工程治理与 AI 架构漂移控制

当任务涉及架构、跨模块、依赖、公共合同、持久化、部署、安全或发布时，必须显式读取 `F:/Skill/engineering-governance/SKILL.md`，并使用 `F:/EngineeringGovernance/store/engineering-governance` 工具包。F 盘位置是本机规范源，不代表 Skill 已被 Codex 自动注册；复制到其他机器时先把这两个绝对路径改为实际安装路径。纯文案、样式等不影响上述边界的局部修改可按项目常规流程处理。

每次新任务、新会话、上下文压缩、任务交接或范围实质变化时：

1. 记录当前完整 Git revision 和与任务相关的未提交文件。
2. 依次读取 `AGENTS.md`、`.governance.yml`、`docs/architecture-context.md`，再读取本范围相关的 accepted ADR 和合同。新项目缺少架构上下文入口时，先按治理模板建立最小索引。
3. 用 GRASP 或当前源码核对实际模块、imports 和 changed files；禁止维护第二份静态依赖图。
4. 找出模块 owner、适用不变量、带有效期的例外、同一范围的已验证范例路径和必跑检查。
5. 形成有边界的任务上下文包：revision、目标、受影响模块、变更分类、边界影响、决策、合同、不变量、范例、例外、验证命令和未解决冲突。revision、范围、ADR 状态或引用路径变化后必须重建，不能沿用旧结论。

编码前必须说明变更分类和边界影响。当前源码与运行证据描述“实际是什么”；accepted ADR 与合同描述“获准成为什么”。两者冲突时，必须同时报告并暂停受影响路径，先取得有明确范围的决定；禁止把已有漂移静默升级为目标架构，也禁止依据过期文档直接覆盖代码。

局部实现优先复用同一范围内经过验证的范例。不同范围可以有意采用不同模式。新共享模式，或模块边界、依赖方向、公共合同、持久化、部署、安全、发布行为的变化，必须在实现前由 Architect 审查并形成 accepted ADR；`proposed` 不能授权实现。ADR 的 `## Context` 和 `## Decision` 必须有实际内容，但结构通过不能代替语义和批准权限审查。

每个例外必须记录 owner、reason、scope、ADR 和 expiry/review date。authoritative base/head 范围必须保持可信的 toolkit repository/ref 与 scan pin 不变；同范围更换 source pin 会被拒绝。合法升级必须走独立受保护的 adoption 流程并记录初始 adoption 证据。不得在同一个变更中削弱将要判断该变更的治理配置、workflow 或门禁严重级别；仓库没有 required check 或等价 ruleset 时，不得宣称 workflow 不可绕过。同一问题路径连续失败三次后必须停止重复修补并升级给 Architect。

### 仓库产物卫生

产物卫生优先预防污染，再处理清理。把生成输出、缓存和临时导出放入指定的 ignored 外部目录或按任务隔离的目录；可按固定 revision、配置和工具版本重现的输出，要和需要保留的取证证据分开。ignored 只控制 Git 可见性，不代表删除、保密或保留策略；已跟踪文件必须进入正常 diff/PR，未知文件保持不动。保留此前被策略拒绝删除的旧报告。

按四类判断：生成输出/取证证据要有 provenance、owner、用途和 retention/review date；死代码或 deprecated 候选必须结合动态入口、合同、测试和 owner 审查，禁止因“无 import”自动删除；debug probe 要在任务结束由 owner 清点用途、证据保留和移除/提升决定，`console.log` 不作一律禁用，生产日志保留独立于本地清理；experiment 放入隔离的 `codex/*` worktree，记录 owner、问题、review date 和提升/退休路径，按评审提升或在维护批次中退休。单一 checkout 中的 branch 切换会遗留 ignored 文件，不能当作实验隔离。

分阶段检查：任务开始清点 revision、dirty status、相关路径、realpath/symlink 和 active process；任务结束复核本任务拥有的 probes 与证据；PR 前检查新增污染；发布前复核 expiry、兼容性和 retention；维护时使用 dry-run 计划和精确文件清单，先审计划，再按 rollback 与测试要求执行。治理工具只提供只读 `governance hygiene audit|plan|check`，支持 `--stage task-start|task-end|pr|release|maintenance`、`--format text|json` 以及需要时的完整 `--base`/`--head`；`audit` 默认 task-start/local，`plan` 默认 task-end/local。PR `check` 要求 strict ancestor immutable range 且 `HEAD == head`，CI 禁止 local evidence。`checks.repository_hygiene: true` 开启项目接入。工具没有 delete executor、自动定时删除或 scheduler；准确命令以 accepted design 为准，不得自造 flags 或使用 `git clean -fdx` 代替审查。维护 registry `.governance-hygiene.json` 仅列 version 1、exact path、`category`（deprecated/debug/experimental）、owner、`reviewBy` 和 evidence，不支持 globs、waivers 或 deletion 指令。

PR 和 release 阶段发现的新 committed contamination 必须阻断；历史发现只作为后续维护评审的 advisory 提示，工具不会自动合成 registry debt 条目。

每次派发子智能体前，重新枚举 `.codex/agents/*.toml`，读取当前选定的最新配置，应用其中的 model、reasoning effort、权限和路径范围。禁止缓存角色文件名、把角色配置固化复制到本提示词，也禁止在模型不可用时静默替换。

实现后先用本地模式检查当前 dirty worktree，再以已提交的明确 base/head revision 做基线检查；最终 CI 必须使用完整 SHA。依赖报告必须由同一次 CI run 从已核对的 head checkout 现场生成；旧 `grasp-report.json` 和 dependency report 只是快照。TypeScript 检查同时安装 manifest 固定的 dependency-cruiser 与 TypeScript companion，拒绝零模块报告，并逐个验证每个声明为 TS/TSX 的源码根；全局模块总数不能代替逐根覆盖。覆盖由新的 Accepted ADR，或 Proposed → Accepted 的 ADR 提供；每份提供覆盖的 ADR 用一行逗号分隔的 `Affected paths:` 声明，所有声明的并集覆盖每个 changed protected path。重新读取最终 diff 和实际 imports，运行本次风险适用的治理、测试、type、lint、contract、build 和 release 检查，并由独立 Reviewer 验收。报告准确命令、证据和局限。自动门禁通过不等于架构一定正确、ADR 语义一定合理或生产运行一定成功。
