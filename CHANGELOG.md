# Changelog

## Unreleased

- 建立跨项目治理工具包与 Codex Skill 的第一版目录和协议。
- 增加无第三方依赖的配置解析、配置校验、ADR 门禁和依赖循环/禁止边界检查。
- 增加通过、循环依赖、禁止依赖和非法配置 fixture 测试。
- 增加固定版本的 dependency-cruiser、TypeScript companion、import-linter 和 Spectral 适配入口及隔离 fixture；TypeScript 检查必须把 dependency-cruiser 与 companion 安装在同一隔离目录。
- 明确依赖报告必须由同一次 CI run 的已验证 head 现场生成，并逐个证明每个声明为 TS/TSX 的源码根扫描覆盖；旧报告只作为快照。
- 明确 changed accepted ADR 的单行 `Affected paths:` 联合覆盖规则，以及可信基线比较和 required check 尚未启用时的能力边界。
- ADR 结构门禁拒绝空白 Context/Decision；语义质量与批准权限继续由独立审查判断。
- 区分工具源码 SHA 接入与镜像 reusable-workflow 接入；记录后者的 digest、完整 base/head SHA、可选 `dependency_artifact_name`/`dependency_report` 接口及 caller 报告来源责任。
- 增加 AI 架构漂移控制、架构上下文入口和可复制 AGENTS.md 提示词。
- 区分已实现硬门禁、项目仍需接入的检查和 Architect/Reviewer 语义判断。
- GitHub 集成改为完整 commit SHA，并纠正 npx/uvx“零安装”和未发布容器的表述。
