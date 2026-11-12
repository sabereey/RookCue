# RookCue

RookCue is a local-first personal experience library for working with AI
agents. The current CLI records project evidence, supports reviews and saves
approved lessons for reuse across projects.

For an agent-guided first run, see [`QUICKSTART.md`](QUICKSTART.md).
For agent integration instructions, see [`AGENT_INTEGRATION.md`](AGENT_INTEGRATION.md).
For a detailed design, architecture, module, feature, and usage walkthrough, see [`docs/project-documentation.md`](docs/project-documentation.md).
For current priorities and future milestones, see the [roadmap](docs/roadmap.md).

The core and included Codex integration are available under [GPL-3.0-only](LICENSE).
This is an early source release. Use the source installation below to try the
CLI and Codex integration. The CLI exposes both `gmem` and `growth-memory`.

## Codex Plugin

This repository includes a local Codex plugin source at `plugins/growth-memory/`.

The plugin is the agent-native experience layer for `growth-memory`: it teaches Codex when to record task state, how to recommend lightweight reviews, and how to promote personal knowledge only after human approval.

The plugin does not replace CLI installation. Build and link the CLI first:

```bash
npm ci
npm run build
npm link
```

Then validate the plugin:

```bash
npm test -- tests/plugin/growth-memory-plugin.test.ts
```

## Requirements

- Node.js >=22.12.0
- npm

## Install

```bash
npm ci
npm run build
npm link
```

The linked command is `growth-memory`.

The official short command is `gmem`. Both commands point to the same CLI:

```bash
growth-memory --help
gmem --help
```

Use `growth-memory` in formal documentation and scripts where clarity matters.
Use `gmem` for day-to-day interactive work. If your machine has no existing
`gm` command, you can create a personal shell alias such as `alias gm=gmem`;
`gm` is not installed by this package to avoid command-name conflicts.

## Roots and assets

Project assets live under `<project>/.growth-memory/`:

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

Personal assets live under `--personal <dir>`. If you omit `--personal`, the CLI uses `GROWTH_MEMORY_HOME` when set and otherwise uses `~/.growth-memory`.

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

## JSON mode

Commands that advertise `--json` in CLI help emit one stable envelope:

```json
{"ok":true,"data":{}}
```

or

```json
{"ok":false,"error":{"code":"ERROR_CODE","message":"Human-readable message","details":{}}}
```

This is the contract to use for agent integrations.

## Common read commands

Check whether the project and personal roots are usable:

```bash
growth-memory status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

The same command can be written with the short alias:

```bash
gmem status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

List promoted personal knowledge:

```bash
growth-memory knowledge list --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

Show one promoted concept in a human-readable form:

```bash
growth-memory knowledge show \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

Add `--json` to these commands when an agent or script needs the stable envelope.
Human-readable `knowledge show` output is intentionally compact: principle,
boundary, confidence, local promoted time, and a short source label. Use
on-demand provenance when you need the full source chain:

```bash
growth-memory knowledge provenance \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID"
```

Personal Pro Foundation local commands:

```bash
growth-memory personal export --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --out "$OUT_DIR"
growth-memory personal verify --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$EXPORT_ROOT"
growth-memory personal import --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --bundle "$EXPORT_ROOT" --dry-run
growth-memory knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "provenance"
growth-memory knowledge timeline --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
growth-memory knowledge digest --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT"
```

`personal verify` recalculates manifest SHA-256 digests and reports missing,
changed, or extra files. `personal import --dry-run` previews which personal
files would be added or skipped; it does not overwrite data in this phase.
`knowledge search` explains which field matched and why the result is relevant.
`knowledge timeline` presents promoted knowledge newest-first with local time.
`knowledge digest` gives a deterministic local summary of recent knowledge,
recurring themes, and oldest concepts.

`gmem peer` syncs personal knowledge directly between paired devices on the same
LAN. Each sync is manually triggered. See the [LAN guide](docs/lan-direct-sync.md)
for pairing, preview, conflicts and recovery.

## Review recommendations

`growth-memory review recommend --signal <signal...>` is deterministic. The current signals and weights are:

| Signal | Weight |
| --- | ---: |
| `architecture-change` | 3 |
| `rule-change` | 3 |
| `failure-or-rework` | 3 |
| `unfamiliar-technology` | 2 |
| `transferable-learning` | 2 |
| `ai-heavy` | 1 |

The resulting review levels are:

- `skip`: score `0`
- `quick`: score `1`
- `deep`: score `>= 2`

The recommendation scale has three levels, but `review start --level skip` is intentionally rejected because a skip decision means no review session should be created.

## Deep review contract

Deep reviews enforce the phase order `context -> reconstruct -> challenge -> correct -> transfer -> complete`.

The important gates are:

- `context`: a human chooses the review level.
- `reconstruct`: a human must provide the reconstruction. AI cannot supply the initial reconstruction.
- `challenge`: AI may ask questions, but a human must answer before advancing.
- `correct`: deep reviews require an evidence-backed AI correction.
- `transfer`: a human must answer the transfer exercise before the review can complete.

The review flow is stable, but selected nodes can use optional method templates.
`review question --template <id>` shapes the challenge prompt, and
`review transfer --template <id>` wraps the human transfer answer while preserving
a `Principle:` line for later knowledge proposal. Built-in template IDs are
`five-whys`, `aar`, `kpt`, and `feynman`.

`review interrupt` checkpoints the current phase and `review resume` restores the session without marking it complete.
The CLI never manufactures a context decision: record the human `context` response and advance it explicitly before submitting reconstruction.

## Promotion and capability rules

- `knowledge propose` only accepts completed reviews.
- Without `--candidate`, `knowledge propose` auto-drafts up to three candidates from the completed review's latest human `transfer-answer` and task evidence. Numbered transfer answers such as `1. ... 2. ... 3. ...` are split into separate candidates; unnumbered answers still produce a single candidate.
- With one or more `--candidate` JSON values, `knowledge propose` uses those explicit candidates instead of auto-drafting.
- A review may create up to three candidates.
- `knowledge decide` requires explicit `--actor human` and `--source <source>` arguments.
- Each decision appends an immutable receipt containing the actor, source, timestamp, decision, and SHA-256 digest of the exact candidate content.
- `knowledge promote` fails until the current candidate matches its latest human approval receipt.
- Promoted concepts store structured timestamps (`candidateCreatedAt`, `approvedAt`, `promotedAt`, and later `updatedAt`/`supersededAt`) plus provenance (`candidateId`, `reviewId`, `taskId`, source project, source summary, approval receipt, and evidence refs).
- `capability update --level explainable` requires passing `explanation` or `transfer` evidence.
- Project-backed evidence IDs are resolved before persistence; independent capability evidence must name a real completed task distinct from the originating task.

Persisted IDs may contain only letters, numbers, dot, underscore, and hyphen, must start with a letter or number, and are limited to 160 characters. Repositories also verify every generated child path remains inside its owning asset root.

Project and personal mutations use per-root cross-process locks. Task/current/evolution mutations compensate on downstream evidence failures, while concept promotion and revision retries reconcile JSON and Markdown without duplicating revision history.

## Help-verified command surface

These are the top-level command groups shown by `growth-memory --help`:

- `init`
- `task`
- `context`
- `personal`
- `evolution`
- `review`
- `knowledge`
- `capability`

The workflow below only uses options that are shown by the command-specific help text.

## Shell transcript

```bash
ROOT="$(mktemp -d /tmp/growth-memory-demo.XXXXXX)"
PROJECT_ROOT="$ROOT/project"
PERSONAL_ROOT="$ROOT/personal"

growth-memory init --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json

TASK_JSON="$(growth-memory task start \
  --project "$PROJECT_ROOT" \
  --title "Document agent workflow" \
  --goal "Verify the complete system" \
  --json)"
TASK_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$TASK_JSON")"

EVENT_JSON="$(growth-memory task event \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --type evidence-collected \
  --summary "Captured CLI output for the workflow transcript." \
  --evidence "task:$TASK_ID" \
  --json)"
EVENT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$EVENT_JSON")"

CHECKPOINT_JSON="$(growth-memory task checkpoint \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --reason interrupt \
  --snapshot '{"blocker":"quota pause","nextStep":"resume review after the transcript is stable"}' \
  --json)"
CHECKPOINT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$CHECKPOINT_JSON")"

growth-memory task complete \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --summary "Completed the evidence-backed workflow draft and queued it for deep review." \
  --json

growth-memory review recommend \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --signal architecture-change transferable-learning ai-heavy \
  --json

REVIEW_JSON="$(growth-memory review start \
  --project "$PROJECT_ROOT" \
  --task "$TASK_ID" \
  --level deep \
  --json)"
REVIEW_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$REVIEW_JSON")"

growth-memory review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase context --text "I accept the deep review level for this task." --json
growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase reconstruct --text "The reliable path is init, task evidence, checkpoint, complete, then deep review." --evidence "task:$TASK_ID" "event:$EVENT_ID" --json
growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review question --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "What breaks if the evolution entry is not tied back to evidence?" --json
growth-memory review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase challenge --text "The review loses traceability and future transfer stops being trustworthy." --evidence "review:$REVIEW_ID" --json
growth-memory review interrupt --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review resume --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review correct --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "Record the promoted lesson only after the evidence chain is explicit." --evidence commit:docs-task-8 --json
growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
growth-memory review transfer --project "$PROJECT_ROOT" --review "$REVIEW_ID" --text "In another repo, I would demand evidence before promoting any reusable guidance." --evidence test:transfer-exercise --json
growth-memory review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json

growth-memory evolution add \
  --project "$PROJECT_ROOT" \
  --title "Promote only evidence-backed lessons" \
  --before "Review notes were disconnected from durable knowledge." \
  --after "The workflow now records evolution only with linked evidence." \
  --reason "Deep review exposed the traceability gap." \
  --impact "Future agents can reuse the lesson with proof attached." \
  --evidence "task:$TASK_ID" "event:$EVENT_ID" "checkpoint:$CHECKPOINT_ID" \
  --json

CANDIDATES_JSON="$(growth-memory knowledge propose \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --review "$REVIEW_ID" \
  --candidate \
  '{"principle":"Reject weak candidates before they become personal doctrine.","boundary":"Use rejection when a draft lacks enough project evidence.","evidence":[{"kind":"task","id":"'"$TASK_ID"'"}]}' \
  '{"principle":"Promote lessons only when project evidence remains attached.","boundary":"Applies after a completed deep review with task and event links.","evidence":[{"kind":"task","id":"'"$TASK_ID"'"},{"kind":"event","id":"'"$EVENT_ID"'"},{"kind":"checkpoint","id":"'"$CHECKPOINT_ID"'"}]}' \
  --json)"
CANDIDATE_1="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[0].id);' "$CANDIDATES_JSON")"
CANDIDATE_2="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data[1].id);' "$CANDIDATES_JSON")"

growth-memory knowledge decide --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_1" --decision reject --actor human --source "interactive review rejection" --json
# expected failure until a human approves the candidate
growth-memory knowledge promote --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_2" --confidence 0.82 --json
growth-memory knowledge decide --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_2" --decision approve --actor human --source "interactive review approval" --json

CONCEPT_JSON="$(growth-memory knowledge promote \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --candidate "$CANDIDATE_2" \
  --confidence 0.82 \
  --json)"
CONCEPT_ID="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.data.id);' "$CONCEPT_JSON")"

growth-memory capability update \
  --project "$PROJECT_ROOT" \
  --personal "$PERSONAL_ROOT" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

## Acceptance and smoke checks

`npm test` rebuilds `dist/` through `pretest`, and `npm run test:full-workflow` rebuilds explicitly because npm does not run `pretest` for that custom script.

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

## Backups

Both roots are plain files. You can back them up independently with git, rsync, or filesystem snapshots.

## Phase 2 local personal growth

The source CLI now supports `gmem growth quality`, `recommend`, `capture`, `due`,
`recall`, `defer`, `resume`, `history`, and `report`. Supply `--project DIR` and
`--personal DIR` explicitly; use `--json` for a one-line envelope. Reports default
to deterministic Markdown; `--format json` is equivalent to `--json`.
The project's `.growth-memory` directory and personal root must have separate
physical locations. If they collide, select separate directories before retrying;
the CLI does not automatically move or repair existing files.

Quality measures documentation/evidence coverage with unknown ranges, not mastery.
History advice uses explicit captured prior completed tasks and voluntary human
recall. It never starts a review or selects a method. Capture only after actual
task closure and completed human review; skipped active/abandoned tasks are reported.
Reads do not capture or create roots. See [QUICKSTART](QUICKSTART.md) for feedback.

Observations, minimal captured review records (without response text), and atomic
capability v2 history are portable through export, verification and import preview.
Reports, caches, project identity and credentials are excluded. Divergent files
remain explicit conflicts. Every capability writer must use the Phase 2 runtime
after v2 upgrade. Beta7 runtime/plugin metadata reports
`0.1.0-beta.7`; historical beta.5 reported `0.1.0`, so older builds still need
`gmem growth --help` and provenance checks. See the [upgrade guide](docs/phase-2-beta-upgrade.md)
and [native build guide](docs/binary-build.md).
