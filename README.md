# Engineering Governance

跨项目复用的工程治理工具包，用于在需求、架构、编码、评审、测试和发布阶段持续执行边界检查。

## 设计定位

这是一个独立的治理工具包，不是 MCP 服务。它通过版本化配置、可复用 CI workflow、ADR 模板和架构检查脚本接入项目。Codex 的操作说明单独位于 `F:/Skill/engineering-governance`。

`F:/Skill/engineering-governance` 是本机独立规范源；已验证 `C:/Users/Win/.codex/skills/engineering-governance` 通过 junction 指向该目录，因此本机可按已注册 Skill 使用。复制到其他机器或用户环境时必须调整 Skill 和工具包根路径，并通过该环境支持的安装或注册机制接入；本机 junction 不能证明其他环境已安装。

## 组成

- `profiles/`: 按技术栈复用的默认策略。
- `policies/`: 依赖、契约、发布和 ADR 规则。
- `schemas/`: `.governance.yml` 的 JSON Schema。
- `workflows/`: GitHub Actions 可复用门禁。
- `scripts/`: 不依赖项目运行时的检查入口。
- `scripts/tool-gates.mjs`: 统一调用 TypeScript、Python 架构依赖和 OpenAPI 契约检查器。
- `scripts/governance-scan.mjs`: 从 Git revision 或本地工作树生成带范围、扫描器版本、配置哈希和逐根覆盖证据的新依赖报告。
- `scripts/git-custody.mjs`: 在 Git common directory 中提供共享的协作租约；它不执行提交、推送或部署。
- `profiles/tool-versions.yml`: 开源检查器的固定版本清单。
- `templates/`: 项目接入文件、ADR 和 GitHub 模板。
- `containers/`: 本地可构建的 CI 镜像配方；发布前不能当作远端可用镜像。

## 版本规则

本机规范源位于 `F:/EngineeringGovernance/store/engineering-governance`。GitHub-hosted runner 无法访问 F 盘，必须先把工具包发布到它能读取的仓库。远端 CI 使用完整 40 字符 commit SHA 固定工具包版本；不接受 branch、`latest` 或可移动 tag。策略变更通过独立评审、固定 revision 和变更记录发布。

远端接入采用源码 SHA 路线：job 按完整 SHA checkout 工具包并直接执行脚本，YO-vedio 选择这条路线，不依赖治理镜像。仓库内的 `workflows/architecture-gates.yml` 只是源模板，不能直接作为远程 reusable workflow 调用；该模板路线未发布和验证前不作为项目接入方式。

项目接入只记录源码 SHA、完整 `base/head` 和同一次运行生成的依赖证据；本版本不把 reusable workflow 或跨 job artifact 作为活动接入契约。

## Python 环境规则

治理检查不得修改项目 `.venv`、Conda 环境或全局 `site-packages`。可以跨项目共享下载缓存或只读、版本固定的工具 runtime；业务项目的可写运行环境保持隔离。`npx`、`uvx` 首次使用时可能下载包并写用户缓存，不应称为“零安装”。

## 本地验证

工具包本身不需要安装第三方包。使用 Node 22 或更高版本执行：

```powershell
node scripts/governance.mjs doctor --tool typescript --tool-dir <isolated-tool-dir>
node scripts/governance.mjs check --config path/to/.governance.yml --tool-dir <isolated-tool-dir> --base <base-sha> --head <head-sha>
node scripts/dependency-gates.mjs --input path/to/dependency-graph.json
node scripts/tool-gates.mjs --tool typescript --path src --dry-run
node scripts/tool-gates.mjs --tool python --path . --dry-run
node scripts/tool-gates.mjs --tool contract --path openapi.yaml --dry-run
npm test
```

`scripts/governance.mjs check` 是策略和证据评估入口。它会验证配置、ADR 和显式 `base/head` 范围；在项目提供有效的 `.governance-toolkit.json` 扫描 pin、或策略要求依赖图时，它会使用已有的隔离 runtime 调用 `governance-scan.mjs` 生成当前 checkout 的新报告，再在同一范围内评估报告。它不会在检查期间下载包。`--dependency-input` 和 `--dependency-base-input` 只接受本地 supplied evidence；路径、非空 JSON 或报告字段本身不能证明来源，authoritative check 会拒绝这两个手工输入并要求同一次运行的 fresh scan。

`governance-scan.mjs` 只使用已经存在的隔离 runtime；它要求 `GOVERNANCE_TOOL_DIR`、显式 `toolDir` 或 `GOVERNANCE_HOME` 中可解析的 runtime，不会在扫描期间下载包。工具适配层只调用已存在的检查器：`PATH` 中与 manifest 同名的 executable、`--executable`，或对应的 `GOVERNANCE_*_EXECUTABLE`。需要下载时，必须在单独的 provisioning 步骤中按 `profiles/tool-versions.yml` 的固定版本准备工具。

`governance.mjs doctor` 是只读的 runtime 诊断入口，会查询实际执行器版本和 TypeScript companion 版本；它不接受只打印 manifest 期望值作为验证。`governance.mjs provision --tool typescript|contract --target <显式目录>` 是唯一的 Node 检查器安装路径，目标目录必须在项目和工具包仓库之外。Python provisioning 不在本版本范围内，Python 检查只能使用显式指定的已有 executable 或专用治理环境。

项目模板 `templates/project-config/governance.mjs` 提供可选的项目 launcher。复制到项目后，`bootstrap` 只按 `.governance-toolkit.json` 中的仓库和完整 SHA 获取工具包；`check` 和 `doctor` 不会自动 bootstrap。项目 launcher 或 CI caller 必须为 authoritative `check` 提供同一完整 `base/head` 范围和已有隔离 runtime；检查路径随后调用 fresh-scan API，并把生成的报告交给治理评估。`scripts/git-custody.mjs` 提供独立 lease 生命周期：共享工作前 `acquire`，变更前 `verify`，完成后 `release`；`status` 只读，过期 lease 仅可使用 `status` 观察到的 identity 执行 `recover-expired`。

当前固定的开源工具版本为：`dependency-cruiser@16.10.4`、其同目录兼容解析器 `typescript@5.9.3`、`import-linter==2.2` 和 `@stoplight/spectral-cli@6.15.0`。TypeScript companion 也是直接运行要求；只装 dependency-cruiser 可能忽略 TS/TSX 并产生假通过。版本只在工具包的 profile 中维护，业务项目不需要重复安装治理工具。

CI 必须显式安装全部 manifest 直接版本并保留 provisioning 证据；对 TypeScript 检查，要把 dependency-cruiser 和 companion 安装到同一隔离目录。若要求传递依赖也完全可复现，还需要 lockfile 或固定 container digest。

依赖报告只在同一次 CI run 中从经核对的 head checkout 现场生成时，才是该 revision 的证据。本地旧 `grasp-report.json` 或 dependency report 只是快照。CI 必须拒绝零模块报告，并逐个核对每个声明为 TS/TSX 的源码根；全局总数、文件存在或 JSON 非空都不能证明逐根覆盖。其他类型的源码根需要自己的显式覆盖规则。

正式项目通过固定 commit SHA 获取工具包，不把脚本复制进业务仓库。`containers/Dockerfile` 使用固定 digest 的 Node 运行时并提供 `governance` 命令，但当前文档没有声明已发布镜像；在镜像版本、digest 和保留策略发布前，只能把它视为本地构建配方。YO-vedio 中的 workflow 当前也是待远端配置和真实运行验证的接入候选，不能把文件已写入等同于 CI 已启用或通过。

## AI 架构漂移

提示词不能提供永久全局记忆。每次任务需要重新读取架构上下文、accepted ADR、合同、实际 imports、模块 owner 和同域范例，并在实现后由源码生成的门禁和独立 Reviewer 验证。详见 `docs/context-drift-control.md`；可复制到项目 `AGENTS.md` 的片段位于 `templates/agents-governance.md`。

工具只证明已执行且输入可信的结构检查通过，不能自动证明架构决定优良、ADR 由有权人员批准或生产行为正确。覆盖由新的 Accepted ADR，或 Proposed → Accepted 的 ADR 提供；每份提供覆盖的 ADR 必须包含非空白 Context/Decision，并用一行逗号分隔的 `Affected paths:` 声明；这些声明的并集必须覆盖全部 changed protected paths。`policies/` 和 profile 中的声明只有接入对应脚本或业务项目 CI 后才成为执行门禁。

## 仓库产物卫生

产物卫生按“预防污染优先于清理”执行，覆盖四类对象：生成输出/取证证据、死代码或 deprecated 候选、debug probe、experiment。生成输出应进入指定的 ignored 外部或按任务隔离目录；可复现输出与需要保留的取证证据分开，并为证据记录 revision、运行时、provenance、owner 和 retention/review date。ignored 只是 Git 可见性控制，不等于删除或安全边界；已跟踪项需要 diff/PR，未知项不自动处理，旧报告在策略拒绝删除后继续保留。

死代码只能由静态结果提出候选，必须再看动态入口、公共或持久化合同、测试和 owner，不能因无 import 自动删除。Debug probe 要登记用途、owner、证据保留和移除/提升节点；`console.log` 不作一律禁用，本地清理也不改变生产日志保留。Experiment 使用隔离的 `codex/*` worktree，记录 owner、问题、review date 和提升/退休路径；同一 checkout 的 branch 切换会留下 ignored 文件，不能代替隔离。

治理检查按阶段分批：任务开始清点 dirty status、realpath/symlink、active process 和相关路径；任务结束复核本任务拥有的 probe；PR 前检查新增污染；发布前复核 expiry、兼容性和 retention；维护批次用 dry-run 计划列出精确文件，审查 rollback 与测试后再执行。通过 `governance hygiene audit|plan|check` 提供只读检查，阶段为 `task-start`、`task-end`、`pr`、`release`、`maintenance`，输出可选 `--format text|json`，不可变范围按需使用完整 `--base`/`--head`。`audit` 默认 task-start/local，`plan` 默认 task-end/local；PR `check` 要求 strict ancestor immutable range 且 `HEAD == head`，CI 禁止 local evidence。项目以 `checks.repository_hygiene: true` 开启接入。工具不提供 delete executor、自动定时删除或 scheduler；准确命令和 flags 以 accepted design 为准，禁止用 `git clean -fdx` 代替审查。`.governance-hygiene.json` 固定为 version 1 的 exact-path registry，条目含 `category`（deprecated/debug/experimental）、owner、`reviewBy` 和 evidence，不支持 globs、waivers 或 deletion 指令。详见 `F:/Skill/engineering-governance/references/repository-hygiene.md`。

PR 和 release 阶段发现的新 committed contamination 必须阻断；历史发现只作为后续维护评审的 advisory 提示，工具不会自动合成 registry debt 条目。

`governance.mjs` 会在 authoritative base/head 范围内比较可信 base 与 head 的治理策略，并拒绝已识别的 policy weakening；独立 Reviewer 仍需核对规则语义、批准权限和未覆盖的变化。仓库未配置 required check 或等价 ruleset 时，workflow 通过只是证据，不能宣称不可绕过。
