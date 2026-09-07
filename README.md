# Engineering Governance

跨项目复用的工程治理工具包，用于在需求、架构、编码、评审、测试和发布阶段持续执行边界检查。

## 设计定位

这是一个独立的治理工具包，不是 MCP 服务。它通过版本化配置、可复用 CI workflow、ADR 模板和架构检查脚本接入项目。Codex 的操作说明单独位于 `F:/Skill/engineering-governance`。

`F:/Skill/engineering-governance` 是本机独立规范源。它不在当前默认 `C:/Users/Win/.codex/skills` 目录中，目录存在本身不能证明 Codex 会自动发现或隐式调用它。`templates/agents-governance.md` 使用绝对路径要求模型显式读取，因此在本机可使用；复制到其他机器或用户环境时必须调整 Skill 和工具包根路径，或通过该环境支持的安装机制注册。本文档不宣称已经完成全局安装。

## 组成

- `profiles/`: 按技术栈复用的默认策略。
- `policies/`: 依赖、契约、发布和 ADR 规则。
- `schemas/`: `.governance.yml` 的 JSON Schema。
- `workflows/`: GitHub Actions 可复用门禁。
- `scripts/`: 不依赖项目运行时的检查入口。
- `scripts/tool-gates.mjs`: 统一调用 TypeScript、Python 架构依赖和 OpenAPI 契约检查器。
- `profiles/tool-versions.yml`: 开源检查器的固定版本清单。
- `templates/`: 项目接入文件、ADR 和 GitHub 模板。
- `containers/`: 本地可构建的 CI 镜像配方；发布前不能当作远端可用镜像。

## 版本规则

本机规范源位于 `F:/EngineeringGovernance/store/engineering-governance`。GitHub-hosted runner 无法访问 F 盘，必须先把工具包发布到它能读取的仓库。远端 CI 使用完整 40 字符 commit SHA 固定工具包版本；不接受 branch、`latest` 或可移动 tag。策略变更通过独立评审、固定 revision 和变更记录发布。

远端有两条独立接入路线。源码 SHA 路线在 job 中按完整 SHA checkout 工具包并直接执行脚本，YO-vedio 选择这条路线，不依赖治理镜像。镜像可复用 workflow 路线必须把 workflow 发布到工具仓库的 `.github/workflows/`，调用不可变 ref，并提供已发布镜像 digest 和同一次 run 的依赖报告 artifact。通用模板只负责下载命名 artifact 并检查给定依赖图；caller 必须负责从目标 head 生成报告并验证逐根覆盖，模板本身不证明报告来源。仓库内的 `workflows/architecture-gates.yml` 只是源模板，不能直接作为 `owner/repo/workflows/...@SHA` 调用；镜像和正确发布路径未就绪前不能宣称该路线可用。

reusable workflow 要求 `image` 为 `@sha256:<64 hex>`，`base`/`head` 为完整 40 字符 SHA。可选 `dependency_artifact_name` 指向同一次 run 已上传的 artifact，`dependency_report` 是 artifact 内相对路径，默认 `dependency-cruiser-report.json`。提供 artifact 名但报告缺失或为空时失败；不提供时，依赖图门禁是否失败由 `.governance.yml` 的 `require_dependency_graph` 决定，否则明确 `SKIP`。

## Python 环境规则

治理检查不得修改项目 `.venv`、Conda 环境或全局 `site-packages`。可以跨项目共享下载缓存或只读、版本固定的工具 runtime；业务项目的可写运行环境保持隔离。`npx`、`uvx` 首次使用时可能下载包并写用户缓存，不应称为“零安装”。

## 本地验证

工具包本身不需要安装第三方包。使用 Node 22 或更高版本执行：

```powershell
node scripts/governance.mjs check --config path/to/.governance.yml
node scripts/dependency-gates.mjs --input path/to/dependency-graph.json
node scripts/tool-gates.mjs --tool typescript --path src --dry-run
node scripts/tool-gates.mjs --tool python --path . --dry-run
node scripts/tool-gates.mjs --tool contract --path openapi.yaml --dry-run
npm test
```

工具适配层只调用已经存在的检查器：`PATH` 中与 manifest 同名的 executable、`--executable`，或对应的 `GOVERNANCE_*_EXECUTABLE`。它不自动调用 `npx`、`uvx` 或项目 Python。需要下载时，在单独 provisioning 步骤中按 `profiles/tool-versions.yml` 的固定版本准备工具。

当前固定的开源工具版本为：`dependency-cruiser@16.10.4`、其同目录兼容解析器 `typescript@5.9.3`、`import-linter==2.2` 和 `@stoplight/spectral-cli@6.15.0`。TypeScript companion 也是直接运行要求；只装 dependency-cruiser 可能忽略 TS/TSX 并产生假通过。版本只在工具包的 profile 中维护，业务项目不需要重复安装治理工具。

适配器会报告 manifest 中的 expected version，但当前不会查询被注入 executable 的实际版本。CI 必须显式安装全部 manifest 直接版本并保留 provisioning 证据；对 TypeScript 检查，要把 dependency-cruiser 和 companion 安装到同一隔离目录。若要求传递依赖也完全可复现，还需要 lockfile 或固定 container digest。

依赖报告只在同一次 CI run 中从经核对的 head checkout 现场生成时，才是该 revision 的证据。本地旧 `grasp-report.json` 或 dependency report 只是快照。CI 必须拒绝零模块报告，并逐个核对每个声明为 TS/TSX 的源码根；全局总数、文件存在或 JSON 非空都不能证明逐根覆盖。其他类型的源码根需要自己的显式覆盖规则。

正式项目通过固定 commit SHA 获取工具包，不把脚本复制进业务仓库。`containers/Dockerfile` 使用固定 digest 的 Node 运行时并提供 `governance` 命令，但当前文档没有声明已发布镜像；在镜像版本、digest 和保留策略发布前，只能把它视为本地构建配方。YO-vedio 中的 workflow 当前也是待远端配置和真实运行验证的接入候选，不能把文件已写入等同于 CI 已启用或通过。

## AI 架构漂移

提示词不能提供永久全局记忆。每次任务需要重新读取架构上下文、accepted ADR、合同、实际 imports、模块 owner 和同域范例，并在实现后由源码生成的门禁和独立 Reviewer 验证。详见 `docs/context-drift-control.md`；可复制到项目 `AGENTS.md` 的片段位于 `templates/agents-governance.md`。

工具只证明已执行且输入可信的结构检查通过，不能自动证明架构决定优良、ADR 由有权人员批准或生产行为正确。每个 changed accepted ADR 必须包含非空白 Context/Decision，并各自用一行逗号分隔的 `Affected paths:` 声明覆盖；所有行的并集必须覆盖全部 changed protected paths。`policies/` 和 profile 中的声明只有接入对应脚本或业务项目 CI 后才成为执行门禁。

“同一 PR 不得削弱判断它的治理规则”目前由提示词和独立 Reviewer 执行；工具尚未自动和独立保护的可信基线比较。仓库未配置 required check 或等价 ruleset 时，workflow 通过只是证据，不能宣称不可绕过。
