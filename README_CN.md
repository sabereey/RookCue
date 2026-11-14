# RookCue

[English](README.md) | 简体中文

RookCue 是面向 AI Agent 协作的本地优先个人经验库。当前 CLI 可以记录项目证据、支持复盘，并保存经批准的经验，供不同项目复用。

首次使用时，可让 Agent 按照[快速开始](QUICKSTART_CN.md)引导操作。
面向 Agent 的安装入口见 [`llms.txt`](llms.txt)。
Agent 接入说明见 [`AGENT_INTEGRATION.md`（英文）](AGENT_INTEGRATION.md)。
设计、架构、模块、功能及使用方式的详细说明见[项目说明书](docs/project-documentation.md)。
当前优先事项和后续里程碑见[路线图](docs/roadmap.md)。

核心及随附的 Codex 集成采用 [GPL-3.0-only](LICENSE) 许可。这是早期源码版本。日常使用时，让本地 Agent 为受支持的 Agent 一次性安装 RookCue，之后通过自然语言操作即可。开发者和脚本仍可直接使用 CLI。

## 为多个 Agent 安装

告诉你的 Agent：

> 帮我从 https://github.com/sabereey/RookCue 安装 RookCue，接入这台电脑上已有的 Codex、Grok 和 Claude Code，共用知识库。

共享安装程序会检测本机的 Codex、Grok 和 Claude Code，在 macOS/Linux 上将它们接入同一份 skill 和运行环境。更新时会原子切换共享 skill；后续新安装的宿主也可以再接入。已有 Codex 插件在迁移前仍由宿主管理。详见[安装指南](plugins/growth-memory/README_CN.md)。

## 对话使用与 Codex 插件

共享 skill 是受支持 Agent 的对话入口，也可以使用由宿主管理的 Codex 插件安装方式。完成配置后，可以说：

- “用 RookCue 记录这次任务。”
- “继续上次任务。”
- “找找以前有没有类似问题。”
- “复盘一下，把值得保留的经验给我确认。”

Agent 会检查运行环境，并在需要时请求授权，将其准备到 `~/.local/share/rookcue`。使用插件时，无需记忆 CLI 命令或运行 `npm link`。如果系统缺少 Node/npm，它可以在 macOS arm64 和 Linux x64 上准备私有 Node 运行环境。下载使用固定版本并执行校验。

任务记录需要主动授权：明确提出记录请求即可授权本次任务；Agent 根据上下文推测出的记录建议则需要确认。查找和恢复操作读取已有数据。保存个人知识始终需要用户批准拟保存经验的确切内容。Skill 能否启用取决于宿主的意图匹配；若未自动启用，请明确指定 RookCue。

详见[插件安装指南](plugins/growth-memory/README_CN.md)。此插件通过源码分发，不代表已经上架公开插件目录。

## 环境要求

- Node.js >=22.12.0
- npm

## 安装

以下是可选的独立 CLI／开发者安装方式。插件用户可以采用上面的 Agent 托管安装流程。

```bash
npm ci
npm run build
npm link
```

主命令为 `rookcue`。短命令 `gmem` 和兼容别名 `growth-memory` 均指向同一个 CLI：

```bash
rookcue --help
gmem --help
growth-memory --help
```

示例使用 `rookcue`。交互操作时可使用更简短的 `gmem`。已有脚本可继续使用 `growth-memory`。更新现有源码安装后，请重新运行 `npm link`，以注册新的 `rookcue` 命令。

## 根目录与资产

项目资产存放在 `<project>/.growth-memory/` 下：

```text
.growth-memory/
  current.md
  working.md
  state.json
  events/events.jsonl
  tasks/<task-id>.json
  checkpoints/<checkpoint-id>.json
  reviews/<review-id>.json
  review-recommendations/<task-id>.json
  evolution/<timestamp>-<slug>.md
```

个人资产存放在 `--personal <dir>` 指定的目录下。如果省略 `--personal`，CLI 会优先使用已设置的 `GROWTH_MEMORY_HOME`，否则使用 `~/.growth-memory`。

```text
<personal-root>/
  index.md
  reviews/<review-id>.json
  reviews/<review-id>.decisions.jsonl
  practice/<review-id>.md
  concepts/<concept-id>.json
  concepts/<concept-id>.md
  capabilities.json
```

## JSON 模式

CLI 帮助中标明支持 `--json` 的命令，统一输出以下稳定封装格式：

```json
{"ok":true,"data":{}}
```

或

```json
{"ok":false,"error":{"code":"ERROR_CODE","message":"Human-readable message","details":{}}}
```

Agent 集成应使用这一接口约定。

## 常用读取命令

检查项目根目录和个人根目录是否可用：

```bash
rookcue status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

同一条命令也可以使用短别名：

```bash
gmem status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

列出已晋升的个人知识：

```bash
rookcue knowledge list --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

以便于阅读的形式展示一个已晋升的概念：

```bash
rookcue knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

当 Agent 或脚本需要稳定封装格式时，为这些命令加上 `--json`。面向人类阅读的 `knowledge show` 输出保持精简，仅包含原则、适用边界、置信度、本地时间表示的晋升时间和简短来源标签。需要完整来源链时，可按需查询：

```bash
rookcue knowledge provenance \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

Personal Pro Foundation 的本地命令：

```bash
rookcue personal export --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --out "$OUT_DIR"
rookcue personal verify --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$EXPORT_ROOT"
rookcue personal import --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$EXPORT_ROOT" --dry-run
rookcue knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "provenance"
rookcue knowledge timeline --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
rookcue knowledge digest --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

`personal verify` 会重新计算清单中的 SHA-256 摘要，并报告缺失、变更或多余的文件。`personal import --dry-run` 预览哪些个人文件会被新增或跳过；此阶段不会覆盖数据。`knowledge search` 解释匹配了哪个字段，以及结果为何相关。`knowledge timeline` 按从新到旧的顺序展示已晋升知识，并使用本地时间。`knowledge digest` 在本地生成确定性的摘要，涵盖近期知识、反复出现的主题以及最早的概念。

`rookcue peer` 可以在同一局域网内的已配对设备之间直接同步个人知识。每次同步都由用户手动触发。配对、预览、冲突处理和恢复方式见[局域网指南](docs/lan-direct-sync.md)。

## 复盘建议

`rookcue review recommend --signal <signal...>` 使用确定性规则。当前信号及权重如下：

| 信号 | 权重 |
| --- | ---: |
| `architecture-change` | 3 |
| `rule-change` | 3 |
| `failure-or-rework` | 3 |
| `unfamiliar-technology` | 2 |
| `transferable-learning` | 2 |
| `ai-heavy` | 1 |

对应的复盘级别为：

- `skip`：得分为 `0`
- `quick`：得分为 `1`
- `deep`：得分为 `>= 2`

建议分为三个级别，但 `review start --level skip` 会被有意拒绝，因为选择跳过意味着不应创建复盘会话。

## 深度复盘约定

深度复盘强制遵循阶段顺序：`context -> reconstruct -> challenge -> correct -> transfer -> complete`。

关键推进条件为：

- `context`：由人选择复盘级别。
- `reconstruct`：必须由人提供过程重建，AI 不能代写初始重建。
- `challenge`：AI 可以提问，但必须由人回答后才能推进。
- `correct`：深度复盘要求 AI 提供有证据支撑的校正。
- `transfer`：必须由人回答迁移练习后，复盘才能完成。

复盘流程保持稳定，但部分节点可以使用可选的方法模板。`review question --template <id>` 用于组织追问提示；`review transfer --template <id>` 用于组织人的迁移回答，同时保留一行 `Principle:`，供后续知识提案使用。内置模板 ID 为 `five-whys`、`aar`、`kpt` 和 `feynman`。

`review interrupt` 会为当前阶段保存检查点，`review resume` 则恢复会话，不会将其标记为已完成。CLI 不会虚构上下文决策：必须先记录人的 `context` 回答并显式推进，再提交过程重建。

## 知识晋升与能力规则

- `knowledge propose` 只接受已完成的复盘。
- 不传 `--candidate` 时，`knowledge propose` 会根据已完成复盘中最新的人的 `transfer-answer` 及任务证据，自动起草最多三个候选。类似 `1. ... 2. ... 3. ...` 的编号式迁移回答会被拆分成多个候选；未编号的回答仍生成单个候选。
- 传入一个或多个 `--candidate` JSON 值时，`knowledge propose` 使用这些明确指定的候选，不再自动起草。
- 一次复盘最多生成三个候选。
- `knowledge decide` 要求显式传入 `--actor human` 和 `--source <source>`。
- 每次决策都会追加一条不可变回执，记录操作主体、来源、时间戳、决策，以及候选确切内容的 SHA-256 摘要。
- 当前候选与其最新的人类批准回执匹配之前，`knowledge promote` 都会失败。
- 已晋升概念保存结构化时间戳（`candidateCreatedAt`、`approvedAt`、`promotedAt`，以及后续的 `updatedAt`／`supersededAt`）和来源信息（`candidateId`、`reviewId`、`taskId`、来源项目、来源摘要、批准回执及证据引用）。
- `capability update --level explainable` 要求提供通过验证的 `explanation` 或 `transfer` 证据。
- 依托项目的证据 ID 会在持久化前解析；独立能力证据必须指向一个真实、已完成、且不同于原始任务的任务。

持久化 ID 只能包含字母、数字、点、下划线和连字符，必须以字母或数字开头，长度不超过 160 个字符。仓储层还会验证生成的每个子路径都位于其所属资产根目录内。

项目和个人数据的修改使用按根目录划分的跨进程锁。任务、当前上下文及演进记录的修改在后续证据操作失败时执行补偿；概念晋升和修订重试则协调 JSON 与 Markdown 的一致性，避免重复记录修订历史。

## 与帮助信息对应的命令

以下列出常用的顶层命令及命令组。完整列表请运行 `rookcue --help` 查看：

- `init`
- `status`
- `growth`
- `peer`
- `task`
- `context`
- `personal`
- `evolution`
- `review`
- `knowledge`
- `capability`

下方工作流只使用各命令帮助文本中列出的选项。

## Shell 操作示例

```bash
ROOT="$(mktemp -d /tmp/growth-memory-demo.XXXXXX)"
PROJECT_ROOT="$ROOT/project"
PERSONAL_ROOT="$ROOT/personal"

rookcue init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json

TASK_JSON="$(rookcue task start \
  --project "$PROJECT_ROOT" \
  --title "Document agent workflow" \
  --goal "Verify the complete system" \
  --json)"
TASK_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$TASK_JSON")"

EVENT_JSON="$(rookcue task event \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --type evidence-collected \
  --summary "Captured CLI output for the workflow transcript." \
  --evidence "task:$TASK_ID" \
  --json)"
EVENT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$EVENT_JSON")"

CHECKPOINT_JSON="$(rookcue task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason interrupt \
  --snapshot '{"blocker":"quota pause","nextStep":"resume review after the transcript is stable"}' \
  --json)"
CHECKPOINT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$CHECKPOINT_JSON")"

rookcue task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Completed the evidence-backed workflow draft and queued it for deep review." \
  --json

rookcue review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal architecture-change transferable-learning ai-heavy \
  --json

REVIEW_JSON="$(rookcue review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --json)"
REVIEW_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$REVIEW_JSON")"

rookcue review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase context --text "I accept the deep review level for this task." --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase reconstruct --text "The reliable path is init, task evidence, checkpoint, complete, then deep review." --evidence "task:$TASK_ID" "event:$EVENT_ID" --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review question --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "What breaks if the evolution entry is not tied back to evidence?" --json
rookcue review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase challenge --text "The review loses traceability and future transfer stops being trustworthy." --evidence "review:$REVIEW_ID" --json
rookcue review interrupt --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review resume --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review correct --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "Record the promoted lesson only after the evidence chain is explicit." --evidence commit:docs-task-8 --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
rookcue review transfer --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "In another repo, I would demand evidence before promoting any reusable guidance." --evidence test:transfer-exercise --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json

rookcue evolution add \
  --project "$PROJECT_ROOT" \
  --title "Promote only evidence-backed lessons" \
  --before "Review notes were disconnected from durable knowledge." \
  --after "The workflow now records evolution only with linked evidence." \
  --reason "Deep review exposed the traceability gap." \
  --impact "Future agents can reuse the lesson with proof attached." \
  --evidence "task:$TASK_ID" "event:$EVENT_ID" "checkpoint:$CHECKPOINT_ID" \
  --json

CANDIDATES_JSON="$(rookcue knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --candidate \
  '{"principle":"Reject weak candidates before they become personal doctrine.","boundary":"Use rejection when a draft lacks enough project evidence.","evidence":[{"kind":"task","id":"'"$TASK_ID"'"}]}' \
  '{"principle":"Promote lessons only when project evidence remains attached.","boundary":"Applies after a completed deep review with task and event links.","evidence":[{"kind":"task","id":"'"$TASK_ID"'"},{"kind":"event","id":"'"$EVENT_ID"'"},{"kind":"checkpoint","id":"'"$CHECKPOINT_ID"'"}]}' \
  --json)"
CANDIDATE_1="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[0].id);' "$CANDIDATES_JSON")"
CANDIDATE_2="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[1].id);' "$CANDIDATES_JSON")"

rookcue knowledge decide --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_1" --decision reject --actor human --source "interactive review rejection" --json
# expected failure until a human approves the candidate
rookcue knowledge promote --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_2" --confidence 0.82 --json
rookcue knowledge decide --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_2" --decision approve --actor human --source "interactive review approval" --json

CONCEPT_JSON="$(rookcue knowledge promote \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_2" \
  --confidence 0.82 \
  --json)"
CONCEPT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$CONCEPT_JSON")"

rookcue capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

## 验收与冒烟检查

`npm test` 会通过 `pretest` 重新构建 `dist/`；`npm run test:full-workflow` 则显式执行构建，因为 npm 不会为该自定义脚本运行 `pretest`。

```bash
npm run test:full-workflow
npm test
npm run typecheck
npm run build
node dist/src/cli.js --help
SMOKE_ROOT="$(mktemp -d /tmp/growth-memory-smoke.XXXXXX)"
SMOKE_ROOT="$SMOKE_ROOT" npm run test:full-workflow
find "$SMOKE_ROOT" -maxdepth 4 -type f -print | sort
```

## 备份

两个根目录都由普通文件组成，可以分别使用 git、rsync 或文件系统快照备份。

## Phase 2 本地个人成长

源码 CLI 现已支持 `rookcue growth quality`、`recommend`、`capture`、`due`、`recall`、`defer`、`resume`、`history` 和 `report`。请显式指定 `--project DIR` 与 `--personal DIR`；使用 `--json` 可输出单行封装格式。报告默认采用确定性的 Markdown；`--format json` 等同于 `--json`。
项目的 `.growth-memory` 目录和个人根目录必须位于不同的物理位置。如果二者冲突，请选用不同目录后重试；CLI 不会自动移动或修复已有文件。

质量指标衡量的是文档和证据的覆盖程度，并呈现未知范围，不代表掌握程度。历史建议依据明确采集的既往已完成任务及人自愿进行的回忆，不会自行启动复盘或选择方法。只有在任务实际结束且人的复盘已完成后才进行采集；仍活跃或已放弃而被跳过的任务会被报告。读取操作不会执行采集或创建根目录。反馈方式见[快速开始](QUICKSTART_CN.md)。

观察记录、最小化的已采集复盘记录（不含回答文本），以及原子写入的 capability v2 历史均可通过导出、校验和导入预览迁移。报告、缓存、项目身份及凭据不包含在内。存在差异的文件仍会明确标记为冲突。升级到 v2 后，所有写入能力数据的程序都必须使用 Phase 2 运行环境。Beta7 的运行环境／插件元数据报告为 `0.1.0-beta.7`；历史 beta.5 报告为 `0.1.0`，因此旧构建仍需通过 `rookcue growth --help` 及来源检查确认。详见[升级指南（英文）](docs/phase-2-beta-upgrade.md)和[原生构建指南（英文）](docs/binary-build.md)。
