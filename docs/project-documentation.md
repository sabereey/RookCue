# RookCue 项目说明书

## 1. 项目定位

RookCue 是一个本地优先的 TypeScript/Node.js CLI。正式命令是
`rookcue`，官方短命令是 `gmem`，兼容别名是 `growth-memory`。它不是普通的“AI 会话记忆”工具，而是围绕个人成长设计的项目记忆协议：

- 在项目内记录任务、事件、checkpoint、当前知识和演进记录。
- 用可解释的规则推荐是否需要复盘。
- 强制深度复盘遵守“人先重建、AI 再校正”的阶段协议。
- 把完成复盘后的经验转化为个人知识候选。
- 只有经过明确的人类审批后，候选才能晋升为跨项目个人知识。
- 用能力证据区分“见过、理解、能解释、能独立应用”。

核心价值是避免 AI 代劳后的虚假成就感：AI 可以帮助完成工作，但系统要求使用者用复盘、追问、迁移题和审批动作把经历转化为自己的认知资产。

## 2. 设计目标

### 2.1 项目知识可恢复

每个项目维护独立的 `.growth-memory/` 文件系统。AI 或人类在重新进入项目时，可以先读取稳定记忆、工作记忆、任务状态和最新 checkpoint，恢复当前任务上下文。

### 2.2 证据链可追溯

系统把任务、事件、checkpoint、review、evolution、personal concept 之间用 evidence reference 串起来。重要结论不应只是一段总结，而应能回到具体任务、事件、checkpoint、review 或测试/提交引用。

### 2.3 人类保留知识主权

AI 可以推荐复盘等级、提出个人知识候选、给出校正意见，但不能自动替人类晋升个人知识。`knowledge decide` 要求显式 `--actor human` 和 `--source`，并写入不可变审批回执。

### 2.4 成长优先于记录堆积

项目资产可以保存完整操作事实，但个人知识库只保存经过验证的可迁移原则。候选可以为零，单次复盘最多三条，避免把泛泛总结塞进个人知识库。

### 2.5 Provider-neutral

系统不绑定任何模型供应商。CLI 通过稳定 JSON envelope 暴露协议，任何 agent 都可以驱动。

## 3. 核心概念

### 3.1 项目记忆

项目记忆回答：“这个项目现在是什么状态，为什么变成这样？”

它包含当前稳定事实、当前工作现场、任务记录、事件日志、checkpoint、review 和演进记录。它服务于上下文恢复、审计和问题追踪。

### 3.2 个人知识

个人知识回答：“我真正理解并能迁移什么？”

它跨项目维护，不复制具体实现细节，而保存原则、适用边界、证据、能力等级和修订历史。

### 3.3 证据引用

证据引用统一形态为：

```json
{"kind":"task","id":"task-1"}
```

当前支持的 `kind` 包括：

- `task`
- `event`
- `checkpoint`
- `commit`
- `test`
- `review`

项目内可解析的引用会通过 `EvidenceResolver` 验证存在性。`commit` 和 `test` 属于外部证据标记，当前只做结构校验。

### 3.4 Review

Review 是把 AI 参与开发的经历转成个人理解的关键流程。等级有：

- `skip`：跳过，不创建 review session。
- `quick`：快速确认事实和结论。
- `deep`：完整十分钟复盘协议。

深度复盘阶段固定为：

```text
context -> reconstruct -> challenge -> correct -> transfer -> complete
```

### 3.5 Knowledge Candidate

完成 review 后，AI 或 agent 可以提出零到三条个人知识候选。候选必须包含：

- `principle`：可迁移原则。
- `boundary`：适用条件和失效边界。
- `evidence`：项目证据。

候选默认不能进入正式概念库，必须先被人类 approve。

### 3.6 Capability

Capability 描述使用者对某个 concept 的掌握状态：

- `seen`：见过。
- `understood`：理解。
- `explainable`：能解释，需要通过解释或迁移证据。
- `independent`：能独立应用，需要不同任务上的独立证据。

## 4. 架构总览

系统由六层组成：

```text
CLI
  -> Services
      -> Domain schemas and evidence resolver
      -> Repositories
          -> Filesystem primitives
          -> Project root / Personal root assets
```

主要依赖方向：

```text
src/cli.ts
  -> ProjectService
  -> ReviewService
  -> KnowledgeService

ProjectService
  -> ProjectRepository
  -> EvidenceResolver

ReviewService
  -> ProjectRepository
  -> ProjectService
  -> EvidenceResolver

KnowledgeService
  -> PersonalRepository
  -> ProjectRepository
  -> EvidenceResolver
  -> candidateDigest / revisionDigest

Repositories
  -> paths / files / root-lock
  -> domain schemas
```

设计上，CLI 只负责参数解析、JSON envelope 和命令编排；业务规则尽量下沉到 service；文件路径、安全 ID、原子写入和锁由 storage 层处理。

## 5. 数据资产布局

### 5.1 项目资产

项目资产位于：

```text
<project-root>/.growth-memory/
```

结构：

```text
.growth-memory/
  current.md
  working.md
  state.json
  events/
    events.jsonl
  tasks/
    <task-id>.json
  checkpoints/
    <checkpoint-id>.json
  reviews/
    <review-id>.json
  review-recommendations/
    <task-id>.json
  evolution/
    <timestamp>-<slug>.md
```

职责：

- `current.md`：当前稳定事实、有效规则和架构边界。
- `working.md`：当前任务现场、未完成增量、最新 checkpoint 摘要。
- `state.json`：当前 active task、最新 checkpoint、最新 review 索引。
- `events/events.jsonl`：append-only 项目事件流。
- `tasks/*.json`：任务生命周期记录。
- `checkpoints/*.json`：恢复快照。
- `reviews/*.json`：复盘状态机和条目。
- `evolution/*.md`：会改变未来判断的重要变化。
- `review-recommendations/*.json`：按 task 缓存的复盘推荐结果。

### 5.2 个人资产

个人资产位于 `--personal <dir>` 指定目录；如果没有指定，则使用 `GROWTH_MEMORY_HOME`；再没有则使用 `~/.growth-memory`。

结构：

```text
<personal-root>/
  index.md
  reviews/
    <review-id>.json
    <review-id>.decisions.jsonl
  practice/
    <review-id>.md
  concepts/
    <concept-id>.json
    <concept-id>.md
  capabilities.json
```

职责：

- `index.md`：个人知识索引入口。
- `reviews/*.json`：review 对应的候选知识状态。
- `reviews/*.decisions.jsonl`：不可变人类审批回执。
- `practice/*.md`：迁移练习、问题和回答摘要。
- `concepts/*.json`：正式个人知识的机器状态。
- `concepts/*.md`：正式个人知识的人类可读版本。
- `capabilities.json`：concept 的能力等级和支撑证据。

## 6. 模块划分

### 6.1 `src/domain/schema.ts`

定义所有核心数据结构的 Zod schema 和 TypeScript 类型。

关键内容：

- 安全 ID：`restrictedIdSchema`
- Evidence：`evidenceRefSchema`
- Task/Event/Checkpoint：`taskRecordSchema`、`projectEventSchema`、`checkpointSchema`
- Review：`reviewRecommendationSchema`、`reviewEntrySchema`、`reviewSessionSchema`
- Knowledge：`knowledgeCandidateSchema`、`conceptRecordSchema`
- Decision receipt：`knowledgeDecisionReceiptSchema`
- Capability：`capabilityEvidenceSchema`、`capabilityRecordSchema`

该模块是系统合同层。service 和 repository 都通过它校验输入输出。

### 6.2 `src/domain/errors.ts`

定义 `DomainError`。业务错误通过稳定 `code`、人类可读 `message` 和可选 `details` 表达，CLI 再把它转换为 JSON error envelope。

### 6.3 `src/domain/evidence-resolver.ts`

负责解析和校验证据引用。

主要能力：

- `resolveAll(evidence)`：验证 task/event/checkpoint/review 等项目证据存在。
- `resolveCompletedReview(reviewId, taskId)`：验证 review 完成且属于目标 task。
- `resolveCapability(concept, evidence)`：验证能力升级证据是否与 concept 对应。

当前约束：

- `task`、`event`、`checkpoint`、`review` 会查项目资产。
- `commit`、`test` 作为外部证据暂不查真实 git/test 系统。
- `independent-task` 必须是已完成、不同于原始任务、且指向 concept 原始 task 的任务。

### 6.4 `src/storage/files.ts`

封装底层文件操作：

- JSON 原子写入。
- Markdown/Text 原子写入。
- JSON 读取和 schema 校验。
- JSONL append 和读取。

文件替换型写入走临时文件加 rename，降低部分写入导致状态损坏的风险。

### 6.5 `src/storage/paths.ts`

负责解析 project/personal 根路径，并提供 `safeChildPath` 防止路径逃逸。

关键规则：

- 项目根固定落在 `<project>/.growth-memory`。
- 个人根优先使用 CLI `--personal`，其次 `GROWTH_MEMORY_HOME`，最后 `~/.growth-memory`。
- 持久化 ID 只能包含字母、数字、点、下划线和连字符，且不能以非字母数字开头。

### 6.6 `src/storage/root-lock.ts`

提供每个资产根的 mutation lock。

它同时处理：

- 同进程队列：避免同一 Node 进程内并发写入交错。
- 文件锁目录：避免跨进程同时修改同一个 root。
- stale lock 清理：锁目录超过阈值后可被视为陈旧。

### 6.7 `src/storage/project-repository.ts`

项目资产 repository，负责 `.growth-memory/` 下所有 project 文件读写。

主要职责：

- 保存/读取 task。
- 追加/读取 event。
- 保存/读取/删除 checkpoint。
- 保存/读取 review。
- 读写 `current.md`、`working.md`。
- 写入 evolution markdown。
- 维护 `state.json` 的 active task、latest checkpoint、latest review。
- 所有子路径通过安全 ID 和 `safeChildPath` 生成。

### 6.8 `src/storage/personal-repository.ts`

个人资产 repository，负责 personal root 下的知识资产。

主要职责：

- 保存/读取 review candidate state。
- 追加/读取 decision receipt。
- 保存/读取 concept JSON。
- 写 concept Markdown。
- 写 practice Markdown。
- 读写 capability state。

### 6.9 `src/project/project-service.ts`

项目记忆业务服务。

主要功能：

- `startTask`：创建 active task，写 task-started event，刷新 working memory。
- `recordEvent`：记录任务事件，并校验证据引用。
- `checkpoint`：记录恢复快照，更新 latest checkpoint 和 working memory。
- `completeTask`：完成 task，清空 active task，刷新 working memory。
- `updateCurrent`：替换稳定项目知识，并写 current-updated event。
- `recordEvolution`：写演进 markdown，并写 evolution-recorded event。
- `loadContext`：读取 current、working、active task 和 latest checkpoint。

增强机制：

- mutation 通过 project root lock 串行化。
- 对 start/complete/checkpoint/current/evolution 等复合写入提供补偿式回滚。
- evidence 先解析再写入重要状态，降低悬空证据进入资产的概率。

### 6.10 `src/review/recommendation.ts`

可解释复盘推荐规则。

信号权重：

```text
architecture-change     3
rule-change             3
failure-or-rework       3
unfamiliar-technology   2
transferable-learning   2
ai-heavy                1
```

推荐等级：

- score `0` -> `skip`
- score `1` -> `quick`
- score `>= 2` -> `deep`

### 6.11 `src/review/review-service.ts`

复盘协议状态机。

主要功能：

- `start`：创建 quick/deep review；`skip` 不允许创建 session。
- `addEntry`：按当前 phase 记录 human/AI 条目。
- `advance`：检查 gate 后进入下一阶段。
- `interrupt`：把 review 标记 interrupted，并创建 project checkpoint。
- `resume`：从 interrupted 状态恢复 active。

深度复盘强约束：

- `context`：必须有人类 decision。
- `reconstruct`：必须有人类 response；AI 不能代替初始重建。
- `challenge`：必须先 AI question，再 human response，顺序固定。
- `correct`：deep review 必须有带 evidence 的 AI correction。
- `transfer`：必须有人类 transfer-answer。

quick review 简化路径：

```text
context -> correct -> complete
```

### 6.12 `src/review/templates.ts`

复盘节点模板渲染器。

主要功能：

- 定义内置模板 ID：`five-whys`、`aar`、`kpt`、`feynman`。
- `renderChallengeQuestion`：把 challenge focus 渲染成结构化 AI question。
- `renderTransferAnswer`：把 human transfer principle 渲染成结构化 transfer-answer，并保留 `Principle:` 行用于后续 candidate 提炼。
- 模板只影响节点内容，不改变 review phase gate。

### 6.13 `src/personal/candidate-identity.ts`

生成候选和修订的 SHA-256 digest。

用途：

- decision receipt 绑定审批时的候选内容。
- promotion 时校验候选内容没有在审批后被悄悄改变。
- revision 使用 digest 去重，支持重试时不重复写历史。

### 6.14 `src/personal/knowledge-service.ts`

个人知识业务服务。

主要功能：

- `propose`：从已完成 review 创建零到三条候选，并写 practice。
- `decide`：人类 approve/reject 候选，追加不可变 decision receipt。
- `promote`：把已审批候选晋升为 concept。
- `show`：按 ID 读取已晋升 concept。
- `reviseEntry`：修订 concept，并保留历史版本。
- `updateCapability`：更新能力等级和证据。

核心门禁：

- review 必须 completed 且 phase 为 complete。
- 候选必须包含至少一个项目证据。
- 候选最多三条。
- approve/reject 必须 `actor=human` 且有 `source`。
- promote 必须有最新 approve receipt，且 receipt digest 与当前候选内容一致。
- explainable 需要通过 explanation 或 transfer 证据。
- independent 需要另一个已完成任务的独立证据。

### 6.15 `src/cli.ts`

Commander CLI 入口。

职责：

- 定义命令和参数。
- 创建 repository/service。
- 把 CLI 输入解析为 domain 输入。
- 输出稳定 JSON envelope。
- 把 `DomainError` 映射成 `{ok:false,error:{code,message,details}}`。

### 6.16 `src/index.ts`

公共库导出入口。导出 domain、service、repository、storage helper，方便未来被其他 agent 或工具直接作为库使用。

### 6.17 个人资产与分发

- `src/personal/personal-asset-service.ts`：导出、manifest 校验和导入预演；只处理
  知识资产白名单。
- `plugins/growth-memory/`：Codex 指令与 marketplace 层，依赖单独安装的 CLI。
- `scripts/release/`：原生 SEA 二进制构建、打包和无 Node 环境验证。

## 7. 详细功能点

### 7.1 初始化

命令：

```bash
rookcue init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

作用：

- materialize 项目根和个人根。
- 准备默认 Markdown/JSON 资产。
- 为后续任务和个人知识写入提供目录结构。

### 7.2 状态总览

命令：

```bash
rookcue status \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT"
```

作用：

- 检查 project/personal roots 是否已经存在。
- 显示 active task、最近 review、最近 concept。
- 汇总 concepts 和 capability records 数量。
- 默认输出面向人类阅读的 Markdown；追加 `--json` 时输出稳定 JSON envelope。

### 7.3 任务生命周期

开始任务：

```bash
rookcue task start \
  --project "$PROJECT_ROOT" \
  --title "Document agent workflow" \
  --goal "Verify the complete system" \
  --json
```

记录事件：

```bash
rookcue task event \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --type evidence-collected \
  --summary "Captured CLI output." \
  --evidence "task:$TASK_ID" \
  --json
```

记录 checkpoint：

```bash
rookcue task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason interrupt \
  --snapshot '{"nextStep":"resume review"}' \
  --json
```

完成任务：

```bash
rookcue task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Completed the workflow." \
  --json
```

约束：

- 同一项目同一时间只能有一个 active task。
- 事件和 evolution 使用 evidence 时会校验证据。
- checkpoint 会更新 working memory 和 latest checkpoint。
- complete 会把 working memory 置回 idle 状态。

### 7.4 上下文读取和更新

显示上下文：

```bash
rookcue context show --project "$PROJECT_ROOT" --json
```

更新稳定上下文：

```bash
rookcue context update \
  --project "$PROJECT_ROOT" \
  --markdown "# Current Knowledge\n\nThe project uses evidence-backed reviews before promoting personal knowledge." \
  --evidence "task:$TASK_ID" \
  --json
```

加载逻辑：

1. 读取 `current.md` 作为稳定项目事实。
2. 读取 `working.md` 作为当前工作现场。
3. 如果有 active task，读取 task。
4. 如果该 task 有 latest checkpoint，一并返回。

### 7.5 演进记录

命令：

```bash
rookcue evolution add \
  --project "$PROJECT_ROOT" \
  --title "Promote only evidence-backed lessons" \
  --before "Review notes were disconnected from durable knowledge." \
  --after "The workflow now records evolution with linked evidence." \
  --reason "Deep review exposed a traceability gap." \
  --impact "Future agents can reuse the lesson with proof attached." \
  --evidence "task:$TASK_ID" "event:$EVENT_ID" \
  --json
```

使用边界：

- 只记录会改变未来判断的变化。
- 包括架构调整、模块调整、业务规则调整、算法调整、设计调整、漏洞修复等。
- 每条 evolution 必须带证据。

### 7.6 复盘推荐

命令：

```bash
rookcue review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal architecture-change transferable-learning ai-heavy \
  --json
```

输出包含：

- `level`
- `score`
- `signals`
- `reasons`

这个推荐只是建议，最终 review level 仍由人类选择。

### 7.7 Deep Review 协议

开始 review：

```bash
rookcue review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --signal architecture-change transferable-learning \
  --json
```

context 阶段，人类确认选择：

```bash
rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "I accept the deep review level." \
  --json

rookcue review advance \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --json
```

reconstruct 阶段，人类主动重建：

```bash
rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase reconstruct \
  --text "The reliable path is init, task evidence, checkpoint, complete, then deep review." \
  --evidence "task:$TASK_ID" \
  --json
```

challenge 阶段，AI 问、人类答：

```bash
rookcue review question \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template five-whys \
  --text "What breaks if evolution is not tied back to evidence?" \
  --json

rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase challenge \
  --text "The review loses traceability." \
  --evidence "review:$REVIEW_ID" \
  --json
```

correct 阶段，AI 提供带证据校正：

```bash
rookcue review correct \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --text "Promote the lesson only after the evidence chain is explicit." \
  --evidence "test:review-state-machine" \
  --json
```

transfer 阶段，人类做迁移回答：

```bash
rookcue review transfer \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --template feynman \
  --text "In another repo, I would require evidence before promoting reusable guidance." \
  --evidence "test:transfer-exercise" \
  --json
```

复盘模板是节点能力，不替换主流程。当前支持在 `challenge` 和 `transfer` 节点使用 `--template five-whys|aar|kpt|feynman`：

- `review question --template` 改变 AI challenge 的问题结构。
- `review transfer --template` 改变 human transfer-answer 的记录结构，并保留 `Principle:` 行供 `knowledge propose` 提炼。
- `context`、`reconstruct`、`correct`、`advance` 的状态机 gate 不受模板影响。

每个阶段写入对应 entry 后，通过 `review advance` 推进。所有 gate 满足后，review 进入 `complete` 且 status 为 `completed`。

### 7.8 Review 中断与恢复

中断：

```bash
rookcue review interrupt \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --json
```

恢复：

```bash
rookcue review resume \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --json
```

中断时会：

- 把 review status 标记为 `interrupted`。
- 写入 project checkpoint，记录 reviewId、phase 和 entryIds。
- 如果 checkpoint 写入失败，会尝试恢复 review 原始状态。

### 7.9 个人知识候选

命令：

```bash
rookcue knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --json
```

约束：

- review 必须完成。
- 默认不传 `--candidate` 时，会从最新 human `transfer-answer` 自动草拟最多三条候选，并附带 review task 证据；编号式回答如 `1. ... 2. ... 3. ...` 会拆成多条，普通未编号回答仍保持单条候选。
- 传入显式 `--candidate` JSON 时，使用调用者提供的候选，最多三条。
- 每条候选必须有 `principle`、`boundary`、`evidence`。
- 每条候选必须至少包含一个项目证据。

### 7.10 人类审批和晋升

审批：

```bash
rookcue knowledge decide \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_ID" \
  --decision approve \
  --actor human \
  --source "interactive review approval" \
  --json
```

晋升：

```bash
rookcue knowledge promote \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_ID" \
  --confidence 0.82 \
  --json
```

关键保护：

- 没有人类 approval 不能 promote。
- 最新 receipt 必须是 approve。
- receipt 的候选 digest 必须匹配当前候选内容。
- promote 会自动写入结构化时间戳：`candidateCreatedAt`、`approvedAt`、`promotedAt`；后续修订会维护 `updatedAt`，废弃知识会写入 `supersededAt`。
- promote 会自动写入 provenance：candidate、review、task、approval receipt、source project、source summary 和 evidence refs，用于从已沉淀知识回溯到形成链路。
- 重复 promote 同一等价内容会补齐 Markdown 并返回已有 concept；不等价则拒绝覆盖。

### 7.11 个人知识查看

列出已晋升知识：

```bash
rookcue knowledge list \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT"
```

按 ID 查看单条知识：

```bash
rookcue knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

用途：

- `knowledge list` 查询个人知识库中已经晋升的 concepts。
- `knowledge show` 默认返回单个 concept 的轻量知识卡片：principle、boundary、status、confidence、沉淀时间和来源摘要。
- `knowledge provenance` 按需返回单个 concept 的完整来源链路：candidate、review、task、decision receipt、source project、source summary 和 evidence refs。
- `knowledge search` 在个人知识库中搜索 principle、boundary、provenance summary 和 evidence id，并在人类输出中解释命中原因。
- `knowledge timeline` 按沉淀时间倒序展示个人知识沉淀历史，并使用本地时间提高可读性。
- `knowledge digest` 汇总近期沉淀、重复主题和较早知识，帮助用户快速回顾个人知识库状态。
- `personal export` 把个人知识库导出为本地 plain-file bundle，并生成 manifest 和 SHA-256 文件摘要。
- `personal verify` 重新计算导出包文件摘要，报告 missing、changed 和 extra 文件。
- `personal import --dry-run` 只预览导入结果，报告 wouldAdd、wouldSkip 和 unsupported，不覆盖现有个人数据。
- 默认输出面向人类阅读的 Markdown；追加 `--json` 时输出稳定 JSON envelope。
- 只读查询，不会修改项目记忆或个人知识库。

### 7.12 个人知识修订

命令：

```bash
rookcue knowledge revise \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --summary "Narrowed the boundary after a counterexample." \
  --boundary "Applies only when evidence remains linked to task artifacts." \
  --confidence 0.72 \
  --evidence "task:$TASK_ID" \
  --json
```

修订会：

- 保存新 concept 状态。
- 把旧 principle/boundary/status/confidence/reviewedAt 写入 history。
- 用 revision digest 去重，支持重试不重复写历史。

### 7.13 能力升级

命令：

```bash
rookcue capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

规则：

- `explainable` 需要通过 explanation 或 transfer。
- `independent` 需要另一个已完成任务，不能是原始任务。
- capability evidence 会回查项目 review/task，避免空洞升级。

### 7.14 Capability 查询

命令：

```bash
rookcue capability list \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --json
```

返回 `capabilities.json` 中的 records。

### 7.15 个人资产迁移与检索

`personal export/verify/import --dry-run` 提供资产迁移基础；
`knowledge search/timeline/digest/provenance` 支持跨项目知识检索和阅读。

## 8. CLI JSON 协议

支持 `--json` 的命令输出统一 envelope。

成功：

```json
{"ok":true,"data":{}}
```

失败：

```json
{"ok":false,"error":{"code":"ERROR_CODE","message":"Human-readable message","details":{}}}
```

这个 envelope 是 agent 集成的主要合同。agent 应读取 `ok` 判断成功与否，不应只依赖进程输出文本。

## 9. 典型端到端工作流

```text
init
  -> task start
  -> task event/checkpoint
  -> task complete
  -> review recommend
  -> review start
  -> context decision
  -> reconstruct
  -> challenge question/answer
  -> correction
  -> transfer answer
  -> review complete
  -> evolution add
  -> knowledge propose
  -> knowledge decide
  -> knowledge promote
  -> capability update
```

这个流程体现了系统的核心观念：

1. 项目事实先进入项目记忆。
2. 人类通过复盘证明理解。
3. AI 只提出候选和校正。
4. 人类审批后才进入个人知识。
5. 能力等级需要行为证据。

## 10. 安装与开发

### 10.1 环境要求

- Node.js `>=22.12.0`
- npm

### 10.2 安装依赖

```bash
npm install
```

### 10.3 构建

```bash
npm run build
```

### 10.4 本地运行 CLI

开发期：

```bash
npm run dev -- --help
```

构建后：

```bash
node dist/src/cli.js --help
```

全局链接：

```bash
npm link
rookcue --help
```

### 10.5 测试

```bash
npm test
npm run test:full-workflow
npm run typecheck
```

脚本说明：

- `npm run build`：TypeScript 编译到 `dist/`。
- `npm test`：先执行 `pretest` 构建，再跑全部 Vitest。
- `npm run test:full-workflow`：构建后跑完整 CLI workflow 测试。
- `npm run typecheck`：只做类型检查，不输出构建文件。

## 11. 错误处理和一致性策略

### 11.1 输入校验

所有关键输入都通过 Zod schema 解析。无效输入会抛出 `DomainError`，CLI 输出稳定错误码。

### 11.2 安全路径

所有持久化 ID 经过 `restrictedIdSchema`。repository 在拼接子路径时使用 `safeChildPath`，防止 `../` 或绝对路径逃出资产根。

### 11.3 原子写入

替换型 JSON/Text 文件通过 atomic write 写入，避免中途失败留下半个文件。

### 11.4 Append-only 记录

事件日志和审批回执使用 JSONL append。审批回执不覆盖旧记录，用最新回执判断当前候选是否可晋升。

### 11.5 根锁

project root 和 personal root 的 mutation 通过 `withRootLock` 串行化，减少并发写入互相覆盖。

### 11.6 复合写入补偿

部分业务操作需要同时写多个文件，例如 task、event、state、working。service 会在下游失败时尝试恢复旧 task/state/working/evolution/current/review 状态，并写入 rollback event 或返回带 rollback detail 的错误。

## 12. 测试覆盖方向

当前测试按模块组织：

```text
tests/domain/schema.test.ts
tests/storage/files.test.ts
tests/storage/root-lock.test.ts
tests/project/project-service.test.ts
tests/review/recommendation.test.ts
tests/review/review-service.test.ts
tests/personal/knowledge-service.test.ts
tests/cli/e2e.test.ts
tests/cli/full-workflow.test.ts
```

覆盖重点：

- domain schema 和安全 ID。
- 原子文件写入、JSONL 读取。
- 根锁并发行为。
- task/event/checkpoint/current/evolution lifecycle。
- review 推荐权重。
- deep review 阶段、actor、kind、顺序 gate。
- review interrupt/resume。
- knowledge propose/decide/promote/revise。
- capability evidence gate。
- CLI 端到端 JSON workflow。

## 13. 当前边界

当前系统已经形成本地文件协议和 CLI 主流程，但仍有几个边界值得明确：

- `commit` 和 `test` evidence 目前不解析真实 git/test 状态，只作为外部证据标签。
- 没有模型 API 集成，AI 侧推荐和候选生成需要外部 agent 调用 CLI 完成。
- `index.md` 更偏个人知识入口，当前主要写入集中在 review/concepts/capabilities。
- 浏览器按钮交互与 chat 回传不是这个 CLI 自身解决的问题；CLI 解决的是 agent 能以命令和 JSON 方式写入明确的人类选择。

## 14. 给后续 agent 的使用建议

进入项目时建议按这个顺序恢复上下文：

1. 读取本文档理解系统结构。
2. 读取 `README.md` 获取命令速查。
3. 运行 `rookcue context show --project <project> --json` 获取项目现场。
4. 如果存在 active task，读取 latest checkpoint。
5. 对重要修改先写 task event 或 checkpoint。
6. 完成任务后，根据信号调用 `review recommend`。
7. 若进入 deep review，必须让人类先 reconstruct，再由 AI challenge/correct。
8. 只有用户明确 approve 后，才调用 `knowledge decide` 和 `knowledge promote`。

这个项目的精神不是“替人记住一切”，而是让 AI 协作变成可复盘、可追溯、可迁移的个人成长循环。
