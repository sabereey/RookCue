# RookCue Quickstart

[English](QUICKSTART.md) | [简体中文](QUICKSTART_CN.md)

First, tell your local agent: “Install RookCue from https://github.com/sabereey/RookCue, connect the existing Codex, Grok, and Claude Code on this computer, and share one knowledge base.”
The agent will detect existing hosts and complete a shared installation. See the [installation guide](plugins/growth-memory/README.md).
After installation, tell any connected agent:

> Use RookCue to record this task.

If the runtime is missing on first use, the agent will explain the download source and installation location, then finish setup after your confirmation.
The agent handles subsequent task recording; you do not need to remember `rookcue`, `gmem`, or any flags.
When adding an agent, say “Connect the newly installed agent to RookCue.” When switching agents within the same project,
the agent first reads existing tasks and checkpoints. Existing Codex plugins remain managed by Codex; see the installation guide for the complete migration procedure.

| What you want to do | What you can say |
| --- | --- |
| Record current work | Use RookCue to record this task |
| Resume progress | Continue the previous task |
| Find past lessons | Look for similar problems we have encountered before |
| Review and save lessons | Review this task and show me the candidate lessons for approval |

Once you authorize recording for a task, the agent will not ask again for every command. Reviews require your actual responses. Before saving a lesson,
the agent shows the specific principle, applicability boundary, and evidence for your approval. Ordinary development requests do not enable recording by default.
If the host does not recognize your intent automatically, explicitly select the RookCue plugin or its `growth-memory` skill.

The following CLI demo lets developers inspect the underlying behavior. Plugin users do not need to run it manually.
The three commands `rookcue`, `gmem`, and `growth-memory` all invoke the same CLI.
The human answers and approval below are demo fixtures for the temporary roots only. In real work, use the user's actual responses, show the exact candidate principle, boundary, and evidence, and obtain explicit approval of that candidate before recording a human decision.

## 1. Install

Run from the project root:

```bash
npm ci
npm run build
npm link
```

Confirm that the commands are available:

```bash
rookcue --help
gmem --help
growth-memory --help
```

If your machine has no other `gm` command, you may set `alias gm=rookcue` yourself. `gm`
is not installed by default, to avoid conflicts with other tools or personal aliases.

## 2. Prepare demo directories

The system maintains two kinds of assets:

- Project assets: tasks, events, checkpoints, reviews, and evolutions for the current project
- Personal assets: knowledge, approval records, and capability levels across projects

Prepare temporary directories:

```bash
ROOT="$(mktemp -d /tmp/growth-memory-demo.XXXXXX)"
PROJECT_ROOT="$ROOT/project"
PERSONAL_ROOT="$ROOT/personal"
```

Later steps extract `id` from JSON output repeatedly. Define a small helper to avoid repeating commands:

```bash
gm_id() {
  node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$1"
}
```

Initialize:

```bash
rookcue init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

Initialization creates two filesystem locations:

```text
$PROJECT_ROOT/.growth-memory/
$PERSONAL_ROOT/
```

Check the current status with one command:

```bash
rookcue status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

## 3. A minimal three-minute walkthrough

This step verifies one thing: `rookcue` can start recording project context.

### 3.1 Start a task

```bash
TASK_JSON="$(rookcue task start \
  --project "$PROJECT_ROOT" \
  --title "Try the memory workflow" \
  --goal "Understand the smallest useful path" \
  --json)"

TASK_ID="$(gm_id "$TASK_JSON")"
```

### 3.2 Record an event

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

### 3.3 View the current context

```bash
rookcue context show --project "$PROJECT_ROOT" --json
```

You can now see the project working context. You can also inspect the files directly:

```bash
find "$PROJECT_ROOT/.growth-memory" -maxdepth 3 -type f | sort
```

If you only want to confirm that the tool works, you can stop here.

## 4. Complete the review cycle

Continue with the same `TASK_ID` to take the task through a deep review.

### 4.1 Record a checkpoint

```bash
CHECKPOINT_JSON="$(rookcue task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason manual \
  --snapshot '{"note":"first checkpoint","nextStep":"complete the task"}' \
  --json)"

CHECKPOINT_ID="$(gm_id "$CHECKPOINT_JSON")"
```

### 4.2 Complete the task

```bash
rookcue task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Finished the first demo task." \
  --json
```

### 4.3 Request a review recommendation

```bash
rookcue review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal transferable-learning ai-heavy \
  --json
```

The combined score of `transferable-learning` and `ai-heavy` recommends `deep`. The next step uses the cached recommendation instead of passing `--signal` again.

### 4.4 Start a deep review

```bash
REVIEW_JSON="$(rookcue review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --json)"

REVIEW_ID="$(gm_id "$REVIEW_JSON")"
```

### 4.5 The human confirms the review level

```bash
rookcue review respond \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "I accept the deep review level." \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.6 The human reconstructs the task

The key to a deep review is for the human to reconstruct the task from memory first, rather than asking AI to summarize it.

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

### 4.7 AI asks a question; the human answers

In this demo, you enter the AI question manually. In actual use, the agent usually calls this command.

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

### 4.8 AI provides an evidence-based correction

```bash
rookcue review correct \
  --project "$PROJECT_ROOT" \
  --review "$REVIEW_ID" \
  --text "The important part is not just recovery, but preserving evidence-linked state." \
  --evidence "event:$EVENT_ID" \
  --json

rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

### 4.9 The human answers the transfer exercise

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

`--template` is optional. The built-in templates are `five-whys`, `aar`, `kpt`, and `feynman`. They only affect the question/answer structure at the current step and do not change the main deep review flow.

This completes a full deep review.

## 5. Promote personal knowledge

This step turns review results into personal knowledge. AI may propose candidates, but a human must explicitly approve them.

### 5.1 Propose a candidate

```bash
CANDIDATES_JSON="$(rookcue knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --json)"

CANDIDATE_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[0].id);' "$CANDIDATES_JSON")"
```

Without `--candidate`, the CLI automatically generates up to three candidates from the human `transfer-answer` in the completed review, using that review's task as project evidence. Numbered transfer answers such as `1. ... 2. ... 3. ...` are split into multiple candidates; an ordinary unnumbered answer still produces only one. Pass one or more `--candidate '{"principle":"...","boundary":"...","evidence":[...]}'` values only when you need to override the candidate content manually.

The JSON `data` is an array; this demo selects its first candidate. Inspect that candidate's exact content before approving it.

### 5.2 The human explicitly approves

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

### 5.3 Promote the candidate to established knowledge

```bash
CONCEPT_JSON="$(rookcue knowledge promote \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_ID" \
  --confidence 0.75 \
  --json)"

CONCEPT_ID="$(gm_id "$CONCEPT_JSON")"
```

During promotion, the CLI automatically records timestamps and provenance, so users do not need to fill them in manually:

- `candidateCreatedAt`: when the candidate was created
- `approvedAt`: when the human approved it
- `promotedAt`: when it became established knowledge
- `provenance`: candidate, review, task, approval receipt, source project, and evidence chain

### 5.4 View promoted knowledge

First, list existing knowledge:

```bash
rookcue knowledge list \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT"
```

Then view a single concept by ID:

```bash
rookcue knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

These commands only read promoted personal knowledge; they do not modify project memory or the personal knowledge base. Add `--json` when an agent needs to parse the output.
The default output is intended for people and shows compact knowledge cards, promotion timestamps, and source summaries. Query the full provenance chain when needed:

```bash
rookcue knowledge provenance \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

You can also export and verify personal knowledge locally, and view search results, timelines, and digests:

```bash
rookcue personal export --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --out "$ROOT/export"
rookcue personal verify --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>"
rookcue personal import --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$ROOT/export/<export-dir>" --dry-run
rookcue knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "checkpoint"
rookcue knowledge timeline --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
rookcue knowledge digest --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

`rookcue peer` supports explicit pairing, previews, and bidirectional synchronization between devices on a local network. See the [LAN guide](docs/lan-direct-sync.md).
`verify` checks the manifest, file sizes, and SHA-256 hashes; `import --dry-run` previews additions and skips without overwriting personal data.
`search` explains why results matched, `timeline` orders knowledge by promotion time, and `digest` summarizes recent knowledge, topics, and older knowledge.

### 5.5 Update a capability level

```bash
rookcue capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

View capability records:

```bash
rookcue capability list --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

## 6. Rules to remember

- `review start --level skip` does not create a review session.
- A deep review requires the human to reconstruct first; AI cannot answer the first round on their behalf.
- `knowledge decide` requires explicit `--actor human --source ...` flags.
- `knowledge promote` only accepts a candidate whose content matches the latest approval receipt.
- Capability upgrades require behavioral evidence; they cannot be assigned arbitrarily.

## 7. What to read next

Once you have completed the workflow above:

1. Read [README.md](README.md) for the complete command surface and rules.
2. Read [docs/project-documentation.md](docs/project-documentation.md) to understand the design rationale.
3. Replace `--project` and `--personal` with your actual project and personal storage directories to start using the system.

## Local personal growth (Phase 2 runtime)

With explicit selected roots, after the task is actually completed and its human
review has finished:

```bash
rookcue growth capture --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth quality --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth due --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth report --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --period week
```

Inspect capture's `captured`, `reused`, and `skipped`; `task-not-completed` means
no history was collected for that review. Querying quality/due/report is read-only.
When you actually choose to provide recall feedback, take `revision` from the
observed quality/due item and keep a stable operation ID for retries:

```bash
rookcue growth recall --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --concept "$CONCEPT_ID" --result recalled --revision "$REVISION" --operation "$OPERATION_ID" --actor human --source "Actual human recall response" --json
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
