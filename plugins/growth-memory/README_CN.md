# 面向本地 Agent 的 RookCue

[English](README.md) | 简体中文

通过对话记录工作、恢复进度、查找已有经验并复盘有价值的收获。
底层命令由 Agent 执行。

## 共享安装

对本地编程 Agent 说：

> 帮我从 https://github.com/sabereey/RookCue 安装 RookCue，接入这台电脑上已有的 Codex、Grok 和 Claude Code，共用个人知识库。

Agent 可以先阅读仓库的[安装入口](../../llms.txt)。

Agent 会取得完整技能目录，检查本机宿主并完成一次共享安装。
从仓库检出目录执行时，入口命令如下。

```bash
bash plugins/growth-memory/skills/growth-memory/scripts/rookcue.sh install --approve-install
```

自动检测依据是宿主的配置目录或 PATH 中的可执行文件。
使用 `--agents codex,grok,claude` 可以明确选择宿主。
共享技能副本保存在 `~/.local/share/rookcue/skills/`，各宿主的入口链接到当前版本。
Codex 使用 `~/.agents/skills/growth-memory`，Grok 使用
`~/.grok/skills/growth-memory`（兼容较旧版本），Claude Code 使用
`~/.claude/skills/growth-memory`。检测宿主配置时会读取 `CODEX_HOME`
和 `CLAUDE_CONFIG_DIR`。各宿主应使用同一个个人知识库目录，通常为
`~/.growth-memory`；继续同一任务时应进入同一个项目目录。

安装器支持 macOS/Linux，复用下文说明的运行环境安装流程。
可以让 Agent 接入新宿主、检查安装状态或更新 RookCue。
`connect` 处理本地接入，`agents` 提供只读检查。更新时，从新版本技能目录
运行 `install`。技能版本通过原子操作发布，新会话会加载更新后的技能。
旧版本会保留在磁盘上。

如果安装时选择了自定义运行环境目录，升级前应从当前已安装的共享技能中读取
`scripts/runtime-home`，将其值作为 `ROOKCUE_RUNTIME_HOME` 传给新版本安装器。
新源码包在没有该环境变量时会使用默认位置。从新源码更新或接入其他宿主时，
应沿用已有运行环境目录。

用户已有的技能会被保留，冲突结果会列出具体路径。
已启用的 Codex 插件标记为 `plugin-managed`，继续通过 Codex 更新。
若要完整迁移，先停用旧 RookCue 插件，再执行 `connect --agents codex`。
文件系统测试已覆盖这些流程，各宿主的实际技能加载和工作流执行仍需验收。
其他本地 Agent 需要接入适配。云端环境和其他电脑需要各自的安装与数据访问方式。

## 安装 Codex 插件

在 Codex 中对 Agent 说：

> 帮我从 https://github.com/sabereey/RookCue 安装 RookCue 插件。

Agent 可以通过 Codex CLI 使用源码市场。

```bash
codex plugin marketplace add sabereey/RookCue
codex plugin add growth-memory@growth-memory-local
```

在本地开发检出目录中，使用仓库根目录作为来源。

```bash
codex plugin marketplace add "$PWD"
codex plugin add growth-memory@growth-memory-local
```

市场名称和插件 ID 保留原有值以保持兼容，显示名称为 RookCue。
当前提供源码安装，公开插件目录上架情况另行确认。
插件源码包含脚本和参考资料，安装后可以独立于原始检出目录使用。

安装或更新后，开启新的 Codex 对话以加载新技能。
旧私有 Beta 副本与当前副本应择一启用。

## 第一次对话

说“用 RookCue 记录这次任务”。Agent 会检查兼容的本地运行环境。
如果环境缺失，会说明下载内容和安装位置并取得同意，随后准备私有运行环境并继续。
CLI 命令和 `npm link` 等操作由 Agent 处理。

安装器优先复用已有的 `rookcue`、`gmem` 或 `growth-memory` beta.8。
否则会校验固定版本的 GitHub 源码归档，安装锁定的依赖，
并在 `~/.local/share/rookcue` 下构建。
macOS arm64 和 Linux x64 在缺少 Node/npm 时，可以安装经过摘要校验的
独立 Node 24.12.0。其他平台需要已有 Node >=22.12.0 和 npm。
基础依赖包括 Bash、tar，以及下载 Node 时使用的 curl 和 shasum/sha256sum。
安装在用户目录内完成，保留现有数据、二进制文件和 shell 配置。

安装器的下载流量用于准备软件，任务内容保存在本地。
固定运行时版本和归档摘要可以在 [runtime.json](skills/growth-memory/scripts/runtime.json) 中查看。
PATH 中较旧或不兼容的命令会被保留，插件使用自己的兼容运行环境。
独立 CLI 用户仍可采用仓库根目录的安装指南。

## 自然语言使用

| 你的请求 | 执行方式 |
| --- | --- |
| 用 RookCue 记录这次任务 | 说明范围，在任务授权内记录本次工作 |
| 继续上次任务 | 读取上下文和检查点，必要时确认具体任务 |
| 找找以前有没有类似问题 | 检索已有知识，说明来源和适用条件 |
| 复盘一下，把这个经验记下来 | 引导复盘，再展示具体候选经验供你批准 |

明确的记录请求授权当前任务；由 Agent 推测出的记录建议需要确认。
普通编程任务默认保持原有工作流程。安装和个人知识晋升分别取得相应授权。
宿主根据 Skill 描述匹配意图，实际触发还取决于宿主行为。
必要时可以显式选择 RookCue，其技能兼容名称为 `growth-memory`。

## 开发验证

```bash
npm test -- tests/plugin
```

具体命令、错误处理和审批规则见 [Skill](skills/growth-memory/SKILL.md)
及其[安装参考](skills/growth-memory/references/setup.md)，两份操作参考目前使用英文。
插件更新保留已有记忆。修改运行时行为时，同步维护固定版本和兼容版本检查。

## 许可

采用仓库根目录 [LICENSE](../../LICENSE) 中的 GPL-3.0-only 许可。
