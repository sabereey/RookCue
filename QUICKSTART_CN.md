# RookCue 快速上手

[English](QUICKSTART.md) | [简体中文](QUICKSTART_CN.md)

先对本地 Agent 说“帮我从 https://github.com/sabereey/RookCue 安装 RookCue，接入这台电脑已有的 Codex、Grok 和 Claude Code，共用知识库”。
Agent 会识别已有宿主并完成一次共享安装，具体见[安装指南](plugins/growth-memory/README_CN.md)。
安装后，直接对任意已接入的 Agent 说：

> 用 RookCue 记录这次任务。

首次缺少运行环境时，Agent 会说明下载来源和安装位置，得到你的确认后完成配置。
后续任务记录由 Agent 执行，不需要记住 `rookcue`、`gmem` 或任何参数。
新增 Agent 时可以说“把新装的 Agent 接入 RookCue”。换 Agent 继续同一项目时，
会先读取已有任务和检查点。已有 Codex 插件继续由 Codex 管理，完整迁移方式见安装指南。

| 你想做什么 | 可以这样说 |
| --- | --- |
| 记录当前工作 | 用 RookCue 记录这次任务 |
| 找回进度 | 继续上次任务 |
| 查询旧经验 | 找找以前有没有类似问题 |
| 复盘并保存经验 | 复盘一下，把候选经验给我确认 |

同一任务授权后，不会逐条命令重复询问。复盘需要你的真实回答，保存经验前会展示
具体原则、适用边界和证据，再由你批准。普通开发请求不会默认开启记录。
若宿主没有自动识别意图，可以显式选择 RookCue 插件或其 `growth-memory` Skill。

以下是供开发者检查底层行为的 CLI 演示。插件用户无需手动执行。
三个命令 `rookcue`、`gmem`、`growth-memory` 指向同一个 CLI。
下文的人类回答和审批仅是临时目录中的演示数据。实际工作必须使用用户的真实回答，展示候选的具体原则、适用边界和证据，并在记录人类决定前获得用户对该候选的明确批准。

## 1. 安装

在项目根目录执行：

```bash
npm ci
npm run build
npm link
```

确认命令可用：

```bash
rookcue --help
gmem --help
growth-memory --help
```

如果你本机没有其它 `gm` 命令，可以自行设置 `alias gm=rookcue`。`gm`
不是默认安装命令，避免和其它工具或个人 alias 冲突。

## 2. 准备演示目录

这个系统同时维护两类资产：

- 项目资产：当前项目的任务、事件、checkpoint、review、evolution
- 个人资产：跨项目的个人知识、审批记录、能力等级

先准备一组临时目录：

```bash
ROOT="$(mktemp -d /tmp/growth-memory-demo.XXXXXX)"
PROJECT_ROOT="$ROOT/project"
PERSONAL_ROOT="$ROOT/personal"
```

后面会多次从 JSON 输出里取 `id`。为了少写重复命令，可以先定义一个小 helper：

```bash
gm_id() {
  node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$1"
}
```

初始化：

```bash
rookcue init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

初始化后会得到两套文件系统：

```text
$PROJECT_ROOT/.growth-memory/
$PERSONAL_ROOT/
```

可以用一条命令确认当前状态：

```bash
rookcue status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

## 3. 3 分钟最小体验

这一步只验证一件事：`rookcue` 可以开始记录项目现场。

### 3.1 开始任务

```bash
TASK_JSON="$(rookcue task start \
  --project "$PROJECT_ROOT" \
  --title "Try the memory workflow" \
  --goal "Understand the smallest useful path" \
  --json)"

TASK_ID="$(gm_id "$TASK_JSON")"
```

### 3.2 记录一个事件

```bash
EVENT_JSON="$(rookcue task event \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --type evidence-collected \
  --summary "Captured the first workflow event." \
  --evidence "task:$TASK_ID" \
  --json)"

EVENT_ID="$(gm_id "$EVENT_JSON")"
```

### 3.3 查看当前上下文

```bash
rookcue context show --project "$PROJECT_ROOT" --json
```

这时你已经能看到项目工作现场。也可以直接看文件：

```bash
find "$PROJECT_ROOT/.growth-memory" -maxdepth 3 -type f | sort
```

如果你只想确认工具能不能工作，到这里就够了。

## 4. 完整复盘闭环

接下来继续用同一个 `TASK_ID`，把一次任务推进到 deep review。

### 4.1 记录 checkpoint

```bash
CHECKPOINT_JSON="$(rookcue task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason manual \
  --snapshot '{"note":"first checkpoint","nextStep":"complete the task"}' \
  --json)"

CHECKPOINT_ID="$(gm_id "$CHECKPOINT_JSON")"
```

### 4.2 完成任务

```bash
rookcue task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Finished the first demo task." \
  --json
```

### 4.3 请求复盘建议

```bash
rookcue review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal transferable-learning ai-heavy \
  --json
```

`transferable-learning` 和 `ai-heavy` 的总分会推荐 `deep`。下一步不再重复传 `--signal`，而是使用刚刚缓存下来的推荐。

### 4.4 开启 deep review

```bash
REVIEW_JSON="$(rookcue review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --json)"

REVIEW_ID="$(gm_id "$REVIEW_JSON")"
```

### 4.5 人类确认复盘等级

```bash
rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "I accept the deep review level." \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.6 人类主动重建

deep review 的关键不是让 AI 总结，而是让人先从记忆里重建一遍。

```bash
rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase reconstruct \
  --text "The flow was: start task, record event, checkpoint, then complete." \
  --evidence "task:$TASK_ID" "event:$EVENT_ID" \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.7 AI 提问，人类回答

演示里你手动写入 AI question；真实使用时通常由 agent 调用这个命令。

```bash
rookcue review question \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template five-whys \
  --text "Why is the checkpoint useful here?" \
  --json

rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase challenge \
  --text "It preserves recovery context and current progress." \
  --evidence "checkpoint:$CHECKPOINT_ID" \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.8 AI 给出证据校正

```bash
rookcue review correct \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --text "The important part is not just recovery, but preserving evidence-linked state." \
  --evidence "event:$EVENT_ID" \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.9 人类完成迁移回答

```bash
rookcue review transfer \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template feynman \
  --text "In another project, I would checkpoint before risky changes or interruptions." \
  --evidence "test:transfer-exercise" \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

`--template` 是可选的。当前内置 `five-whys`、`aar`、`kpt`、`feynman`，只影响当前节点的问题/回答结构，不改变 deep review 主流程。

到这里，一次完整 deep review 就完成了。

## 5. 个人知识晋升

这一步把复盘结果变成个人知识。重点是：AI 可以提出候选，但必须由人类显式审批。

### 5.1 提出候选

```bash
CANDIDATES_JSON="$(rookcue knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --json)"

CANDIDATE_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[0].id);' "$CANDIDATES_JSON")"
```

如果不传 `--candidate`，CLI 会从已完成 review 的 human `transfer-answer` 自动生成最多三条候选，并使用该 review 对应的 task 作为项目证据。像 `1. ... 2. ... 3. ...` 这样的编号式 transfer answer 会被拆成多条候选；普通未编号回答仍然只生成一条。只有需要人工覆盖候选内容时，才传一个或多个 `--candidate '{"principle":"...","boundary":"...","evidence":[...]}'`。

JSON 的 `data` 是数组；本演示取第一条候选。批准前应检查该候选的具体内容。

### 5.2 人类显式审批

```bash
rookcue knowledge decide \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_ID" \
  --decision approve \
  --actor human \
  --source "first quickstart approval" \
  --json
```

### 5.3 晋升为正式知识

```bash
CONCEPT_JSON="$(rookcue knowledge promote \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_ID" \
  --confidence 0.75 \
  --json)"

CONCEPT_ID="$(gm_id "$CONCEPT_JSON")"
```

晋升时 CLI 会自动写入时间和来源链路，不需要用户手动补档案：

- `candidateCreatedAt`：候选生成时间
- `approvedAt`：人类审批时间
- `promotedAt`：正式沉淀时间
- `provenance`：candidate、review、task、审批 receipt、来源项目和证据链

### 5.4 查看已晋升知识

先列出已有知识：

```bash
rookcue knowledge list \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT"
```

再按 ID 查看单条知识：

```bash
rookcue knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

这些命令只读取已经晋升的个人知识，不会修改项目记忆或个人知识库。需要给 agent 解析时再追加 `--json`。
默认输出面向人类阅读，会显示轻量知识卡片、沉淀时间和来源摘要；完整来源链路按需查询：

```bash
rookcue knowledge provenance \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

也可以在本地导出和校验个人知识，并查看搜索结果、时间线和摘要：

```bash
rookcue personal export --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --out "$ROOT/export"
rookcue personal verify --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>"
rookcue personal import --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>" --dry-run
rookcue knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "checkpoint"
rookcue knowledge timeline --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
rookcue knowledge digest --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

`rookcue peer` 支持局域网设备显式配对、预览和双向同步。参见 [局域网指南](docs/lan-direct-sync.md)。
`verify` 会检查 manifest、文件大小和 SHA-256；`import --dry-run` 只预览新增/跳过，不覆盖任何个人数据。
`search` 会解释命中原因，`timeline` 按沉淀时间展示，`digest` 会汇总最近知识、主题和较早知识。

### 5.5 更新能力等级

```bash
rookcue capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

查看能力记录：

```bash
rookcue capability list --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

## 6. 最值得记住的规则

- `review start --level skip` 不会创建 review session。
- deep review 必须是人类先重建，AI 不能代答第一轮。
- `knowledge decide` 必须显式带 `--actor human --source ...`。
- `knowledge promote` 只会接受和最新 approval receipt 内容一致的候选。
- capability 升级不是随便标记，必须带行为证据。

## 7. 下一步怎么读

如果你已经跑通上面的流程，建议下一步这样看：

1. 看 [README_CN.md](README_CN.md)，理解完整命令面和规则
2. 看 [docs/project-documentation.md](docs/project-documentation.md)，理解为什么系统这样设计
3. 再把你的真实项目目录替换进 `--project` 和 `--personal`，开始实际使用

## 本地个人成长（Phase 2 运行时）

明确选择项目和个人目录，并在任务真正完成且人类复盘结束后执行：

```bash
rookcue growth capture --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth quality --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth due --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth report --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --period week
```

检查 capture 输出中的 `captured`、`reused` 和 `skipped`；`task-not-completed` 表示
没有为该复盘采集历史。查询 quality/due/report 是只读操作。
当你实际选择提供回忆反馈时，从已查看的 quality/due 条目中获取 `revision`，
并在重试时保持同一个操作 ID：

```bash
rookcue growth recall --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --concept "$CONCEPT_ID" --result recalled --revision "$REVISION" --operation "$OPERATION_ID" --actor human --source "Actual human recall response" --json
```

结果可选 `recalled|partial|forgotten`。`growth defer --until ISO` 和
`growth resume` 使用相同的 concept/revision/operation/actor/source 参数。
延期是自愿选择，不计为回忆。能力更新接受
`--operation ID --rationale TEXT`；`growth history` 保留升级、降级、
评估和已知的旧版基线。质量指证据质量，日期是练习建议，两者都不会自动升级能力。

报告接受 `--period week|month` 或 `--from ISO --to ISO`（UTC 左闭右开区间）。
`--json` 或 `--format json` 输出单行封装，包括错误；显式
组合 `--format markdown --json` 会返回输入错误码 64。领域错误使用 2，
意外错误使用 1。首次发生 v2 能力变更后，所有写入端都需要支持 Phase 2 的 `growth --help`。
Beta7 的版本号为 `0.1.0-beta.7`；仅凭历史版本号 `0.1.0` 无法判断运行时支持情况。
替换写入端或修改旧版能力状态前，请遵循[升级指南](docs/phase-2-beta-upgrade.md)。
