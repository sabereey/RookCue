# RookCue 快速上手

这份文档面向第一次使用 `growth-memory` 的人。正式命令是
`growth-memory`，推荐日常短命令是 `gmem`；两者指向同一个 CLI。它分成三段：

- 3 分钟最小体验：看到项目记忆开始工作。
- 完整复盘闭环：理解 deep review 怎样把 AI 协作变成主动学习。
- 个人知识晋升：把复盘后的经验写入个人知识库。

真实使用时，很多命令会由 AI agent 自动调用。这里把命令完整写出来，是为了让你知道系统到底记录了什么、为什么需要人类确认。

更详细的设计和模块说明见：

- [README.md](README.md)
- [docs/project-documentation.md](docs/project-documentation.md)

## 1. 安装

在项目根目录执行：

```bash
npm ci
npm run build
npm link
```

确认命令可用：

```bash
growth-memory --help
gmem --help
```

如果你本机没有其它 `gm` 命令，可以自行设置 `alias gm=gmem`。`gm`
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
growth-memory init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

初始化后会得到两套文件系统：

```text
$PROJECT_ROOT/.growth-memory/
$PERSONAL_ROOT/
```

可以用一条命令确认当前状态：

```bash
growth-memory status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

## 3. 3 分钟最小体验

这一步只验证一件事：`growth-memory` 可以开始记录项目现场。

### 3.1 开始任务

```bash
TASK_JSON="$(growth-memory task start \
  --project "$PROJECT_ROOT" \
  --title "Try the memory workflow" \
  --goal "Understand the smallest useful path" \
  --json)"

TASK_ID="$(gm_id "$TASK_JSON")"
```

### 3.2 记录一个事件

```bash
EVENT_JSON="$(growth-memory task event \
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
growth-memory context show --project "$PROJECT_ROOT" --json
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
CHECKPOINT_JSON="$(growth-memory task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason manual \
  --snapshot '{"note":"first checkpoint","nextStep":"complete the task"}' \
  --json)"

CHECKPOINT_ID="$(gm_id "$CHECKPOINT_JSON")"
```

### 4.2 完成任务

```bash
growth-memory task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Finished the first demo task." \
  --json
```

### 4.3 请求复盘建议

```bash
growth-memory review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal transferable-learning ai-heavy \
  --json
```

`transferable-learning` 和 `ai-heavy` 的总分会推荐 `deep`。下一步不再重复传 `--signal`，而是使用刚刚缓存下来的推荐。

### 4.4 开启 deep review

```bash
REVIEW_JSON="$(growth-memory review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --json)"

REVIEW_ID="$(gm_id "$REVIEW_JSON")"
```

### 4.5 人类确认复盘等级

```bash
growth-memory review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "I accept the deep review level." \
  --json

growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.6 人类主动重建

deep review 的关键不是让 AI 总结，而是让人先从记忆里重建一遍。

```bash
growth-memory review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase reconstruct \
  --text "The flow was: start task, record event, checkpoint, then complete." \
  --evidence "task:$TASK_ID" "event:$EVENT_ID" \
  --json

growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.7 AI 提问，人类回答

演示里你手动写入 AI question；真实使用时通常由 agent 调用这个命令。

```bash
growth-memory review question \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template five-whys \
  --text "Why is the checkpoint useful here?" \
  --json

growth-memory review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase challenge \
  --text "It preserves recovery context and current progress." \
  --evidence "checkpoint:$CHECKPOINT_ID" \
  --json

growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.8 AI 给出证据校正

```bash
growth-memory review correct \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --text "The important part is not just recovery, but preserving evidence-linked state." \
  --evidence "event:$EVENT_ID" \
  --json

growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.9 人类完成迁移回答

```bash
growth-memory review transfer \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template feynman \
  --text "In another project, I would checkpoint before risky changes or interruptions." \
  --evidence "test:transfer-exercise" \
  --json

growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

`--template` 是可选的。当前内置 `five-whys`、`aar`、`kpt`、`feynman`，只影响当前节点的问题/回答结构，不改变 deep review 主流程。

到这里，一次完整 deep review 就完成了。

## 5. 个人知识晋升

这一步把复盘结果变成个人知识。重点是：AI 可以提出候选，但必须由人类显式审批。

### 5.1 提出候选

```bash
CANDIDATES_JSON="$(growth-memory knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --json)"

CANDIDATE_ID="$(gm_id "$CANDIDATES_JSON")"
```

如果不传 `--candidate`，CLI 会从已完成 review 的 human `transfer-answer` 自动生成最多三条候选，并使用该 review 对应的 task 作为项目证据。像 `1. ... 2. ... 3. ...` 这样的编号式 transfer answer 会被拆成多条候选；普通未编号回答仍然只生成一条。只有需要人工覆盖候选内容时，才传一个或多个 `--candidate '{"principle":"...","boundary":"...","evidence":[...]}'`。

### 5.2 人类显式审批

```bash
growth-memory knowledge decide \
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
CONCEPT_JSON="$(growth-memory knowledge promote \
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
growth-memory knowledge list \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT"
```

再按 ID 查看单条知识：

```bash
growth-memory knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

这些命令只读取已经晋升的个人知识，不会修改项目记忆或个人知识库。需要给 agent 解析时再追加 `--json`。
默认输出面向人类阅读，会显示轻量知识卡片、沉淀时间和来源摘要；完整来源链路按需查询：

```bash
growth-memory knowledge provenance \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

第一阶段 Personal Pro Foundation 还提供本地备份、搜索和时间线能力：

```bash
growth-memory personal export --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --out "$ROOT/export"
growth-memory personal verify --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>"
growth-memory personal import --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>" --dry-run
growth-memory knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "checkpoint"
growth-memory knowledge timeline --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
growth-memory knowledge digest --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

`gmem peer` 支持局域网设备显式配对、预览和双向同步。参见 [局域网指南](docs/lan-direct-sync.md)。
`verify` 会检查 manifest、文件大小和 SHA-256；`import --dry-run` 只预览新增/跳过，不覆盖任何个人数据。
`search` 会解释命中原因，`timeline` 按沉淀时间展示，`digest` 会汇总最近知识、主题和较早知识。

Cloud MVP 第一版使用本地 filesystem remote 来验证加密备份语义：

```bash
REMOTE_ROOT="$ROOT/cloud-remote"
growth-memory cloud remote check --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT"
growth-memory cloud backup --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT" --passphrase "demo-passphrase" --dry-run
growth-memory cloud backup --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT" --passphrase "demo-passphrase"
growth-memory cloud restore --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT" --passphrase "demo-passphrase" --dry-run
growth-memory cloud sync --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT" --passphrase "demo-passphrase" --dry-run
growth-memory cloud sync --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "$REMOTE_ROOT" --passphrase "demo-passphrase" --apply
```

先运行 `cloud remote check`，它只检查 connector 配置与安全能力，不上传知识。
RookCue 不提供远端存储；你可以使用本地目录、挂载 NAS 或自己的 S3/R2
账户。

这一步会在 `REMOTE_ROOT` 下写入 encrypted objects 和 remote manifest；不会创建账号、不会访问外网。remote manifest 只保存 opaque object id、object key、encrypted digest、size 和加密元数据，不保存 `concepts/`、`reviews/`、`practice/` 这类明文路径，也不保存 plaintext source SHA-256。成功 backup 后，本地个人根目录会记录 cloud sync state；路径、明文 hash 和内容元数据只保留在本地 state 或加密 object envelope 中。后续用 `base`、`local`、解密后的 `remote` 三方 hash 判断一致性：单边本地变化可以上传，双边分叉会进入 conflicts，backup/sync 不会静默覆盖远端。`cloud sync --dry-run` 会计算同步计划，`cloud sync --apply` 会重新计算计划并且只在无冲突时执行；restore 当前仍只做 dry-run。

### Conflict recovery

当本地和远端都相对上次 sync base 发生变化时，`cloud sync --apply` 会停止。使用
`cloud conflict list` 查看冲突，`cloud conflict show` 查看本地/远端摘要，再用
`cloud conflict resolve --strategy local|remote|both|skip` 做显式选择。`remote`
表示用远端覆盖本地，`local` 表示用本地覆盖远端，`both` 会保留两份，`skip`
会暂时跳过。处理完成后重新执行 `cloud sync --apply`。

### Cleanup and key loss

`cloud cleanup --dry-run` reports encrypted remote objects no longer referenced
by the remote manifest. `cloud cleanup --apply` deletes eligible filesystem
remote orphans. `cloud sync --apply` can remove intentionally deleted paths from
the remote manifest, but payload deletion remains a separate cleanup step. The
passphrase is required to restore encrypted cloud content; if it is lost, use a
trusted local personal root or a `personal export` bundle.

S3-compatible BYO remote 使用同一套 encrypted object 和 opaque manifest 格式。通过环境变量配置凭证，不要把密钥放进 CLI 参数、项目文件、个人知识库、sync state 或 manifest：

```bash
GMEM_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
GMEM_S3_REGION="auto" \
GMEM_S3_ACCESS_KEY_ID="..." \
GMEM_S3_SECRET_ACCESS_KEY="..." \
growth-memory cloud backup --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --remote "s3://bucket/growth-memory" --passphrase "demo-passphrase"
```

S3 provider 必须实际执行 `PutObject` 的 `If-None-Match: *`（首次创建）和
`If-Match: <ETag>`（已有 manifest 更新）条件。并发修改返回
`CLOUD_MANIFEST_REVISION_CONFLICT` 时，重新读取远端并执行 dry-run，再决定 apply；
不要绕过条件写。缺少 ETag 返回 `CLOUD_MANIFEST_REVISION_REQUIRED`，provider 不支持
条件请求时返回 `CLOUD_MANIFEST_CONDITIONAL_WRITE_UNSUPPORTED`，不会退回无条件覆盖。
`cloud remote check` 仅报告配置和 connector 能力，不进行网络探测或认证 provider。
S3 cleanup 暂不支持。上面的 S3 命令会访问你配置的存储服务；前面的本地目录
示例不访问网络。

### 5.5 更新能力等级

```bash
growth-memory capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

查看能力记录：

```bash
growth-memory capability list --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

## 6. 最值得记住的规则

- `review start --level skip` 不会创建 review session。
- deep review 必须是人类先重建，AI 不能代答第一轮。
- `knowledge decide` 必须显式带 `--actor human --source ...`。
- `knowledge promote` 只会接受和最新 approval receipt 内容一致的候选。
- capability 升级不是随便标记，必须带行为证据。

## 7. 下一步怎么读

如果你已经跑通上面的流程，建议下一步这样看：

1. 看 [README.md](README.md)，理解完整命令面和规则
2. 看 [docs/project-documentation.md](docs/project-documentation.md)，理解为什么系统这样设计
3. 再把你的真实项目目录替换进 `--project` 和 `--personal`，开始实际使用

## Local personal growth (Phase 2 runtime)

With explicit selected roots, after the task is actually completed and its human
review has finished:

```bash
gmem growth capture --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
gmem growth quality --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
gmem growth due --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
gmem growth report --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --period week
```

Inspect capture's `captured`, `reused`, and `skipped`; `task-not-completed` means
no history was collected for that review. Querying quality/due/report is read-only.
When you actually choose to provide recall feedback, take `revision` from the
observed quality/due item and keep a stable operation ID for retries:

```bash
gmem growth recall --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --concept "$CONCEPT_ID" --result recalled --revision "$REVISION" --operation "$OPERATION_ID" --actor human --source "Actual human recall response" --json
```

Results are `recalled|partial|forgotten`. `growth defer --until ISO` and
`growth resume` use the same concept/revision/operation/actor/source flags.
Deferral is voluntary and does not count as recall. Capability updates accept
`--operation ID --rationale TEXT`; `growth history` preserves rises, downgrades,
assessments and known legacy baselines. Quality is evidence quality, dates are
practice suggestions, and neither is an automatic capability upgrade.

Report accepts `--period week|month` or `--from ISO --to ISO` (UTC half-open).
`--json` or `--format json` gives one-line envelopes, including errors; explicitly
combining `--format markdown --json` is input error 64. Domain errors use 2 and
unexpected errors 1. All writers need Phase 2 `growth --help` support after the
first v2 capability mutation. Beta7 reports `0.1.0-beta.7`; historical `0.1.0`
alone cannot identify runtime support. Follow [the upgrade guide](docs/phase-2-beta-upgrade.md)
before replacing a writer or mutating legacy capability state.
