# 发布 RookCue

[English](releasing.md) | 简体中文

使用短期 `codex/*` 分支和 PR，保持 `main` 通过 CI。CLI、插件和共享技能统一产品版本；
数据格式版本单独管理。不移动已发布标签、不覆盖发布附件，修复后发布新版本。
预发布按 beta.9、beta.10 等递增；核心安装、升级、恢复及审批流程有稳定验收证据后发布
0.1.0。后续补丁版本用于兼容修复，次版本用于兼容功能，稳定 API 或数据契约的破坏性
变更需要主版本升级和明确迁移方案。

## 准备

```sh
npm run release:version -- 0.1.0-beta.9
npm run release:check
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=30000
```

版本工具同时更新 package、锁文件、插件清单、运行时清单及无 Node 启动器版本。
补充对应的中英更新日志和 `docs/releases/<version>.md`，先提交并推送运行时源码候选。

```sh
npm run release:pin -- FULL_RUNTIME_SOURCE_COMMIT
npm run release:verify-pin
npm run release:verify-install
```

绑定工具下载候选提交的 GitHub 归档，计算摘要并固定运行时地址、提交和校验值。
验证会拒绝源码、package/锁文件输入或版本不一致。最终发布提交包含绑定清单；运行时
输入提交在其之前，以避免自引用，同时保留两者的追溯关系。
安装检查使用临时 HOME、项目及个人目录，验证全新安装、beta.8 升级、数据字节不变
及旧运行时保留。`release:verify-install` 的可选参数可指定上一版技能提交；当前基线为
引入发布流程前的 beta.8 源码。

提交绑定清单，审查并合并到 main，等待 CI 和两个原生构建任务通过。
main 推送仅构建验证，不发布。给最终干净提交创建标签：

```sh
git tag -a v0.1.0-beta.9 -m "RookCue 0.1.0-beta.9"
git push origin v0.1.0-beta.9
```

Release 工作流检查标签、版本和源码绑定，使用 Node 24.12.0 在 Linux x64 与 macOS
arm64 上运行测试、验证原生程序、打包对应源码并检查安装；两个平台全部通过后才发布。
版本包含连字符时创建 GitHub 预发布，不发布到 npm。对外宣布前检查成功的运行记录、
附件和 `SHA256SUMS`。已有 Release 会导致发布失败，不会覆盖附件。
标签触发后如在发布前失败，先诊断，不悄悄移动标签；需要修改源码时使用新候选版本。

共享升级为已接入宿主切换同一技能版本。已有 Codex 插件仍需由应用管理更新，应明确
说明，不能声称所有宿主均已升级。发布验证不修改真实知识库。
