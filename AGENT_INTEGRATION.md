# Agent Integration Guide

This guide is for Codex, Claude Code, Cursor, Windsurf, and other coding agents that should use RookCue as a background protocol.

`gmem` is the approved agent runtime command. Agents must detect `gmem` on
`PATH`; do not check for or fall back to `growth-memory` or `gm`.

Build and install `gmem` from source using [the installation guide](README.md#install)
before adding the plugin. Agents should detect the installed command on `PATH`.
Keep credentials and personal storage paths out of task output.

The user should not have to run `growth-memory` commands manually. Agents should call the CLI in the background and only interrupt the user for human judgment.

For the human-facing first run, see [QUICKSTART.md](QUICKSTART.md).
For detailed architecture and module behavior, see [docs/project-documentation.md](docs/project-documentation.md).

## 1. Integration Goal

Use RookCue automatically for non-trivial coding work so that AI-assisted tasks become recoverable project memory and, when useful, reviewed personal knowledge.

The ideal user experience is:

```text
User asks for a task.
Agent records task state in the background.
Agent completes the work.
Agent recommends skip/quick/deep review.
User confirms, reconstructs, or approves knowledge only when needed.
Agent writes project memory and personal knowledge in the background.
```

The user should see questions like:

```text
This task touched architecture and had heavy AI implementation. I recommend a deep review.
Before I show the summary, please reconstruct what changed and why.
```

The user should not see instructions like:

```text
Run gmem task start ...
Run gmem review advance ...
Run gmem knowledge promote ...
```

## 2. Global Codex Setup

On this machine, Codex can read global instructions from:

```text
~/.codex/AGENTS.md
```

A useful global rule is:

```md
# Global RookCue Protocol

For every non-trivial coding task, automatically use `gmem` when it is available on `PATH`.

Use:

- `--project` as the current repository root.
- `--personal` as `~/.growth-memory`.

Do not ask the user whether to enable RookCue every time.

Initialize `gmem` automatically when needed. Record task starts, important events, checkpoints, failures, decisions, and task completion in the background.

After completing a task, recommend `skip`, `quick`, or `deep` review based on task signals.

Only interrupt the user for human judgment:

- Review level confirmation.
- Reconstruction answers.
- Knowledge approval or rejection.

Never ask the user to manually run `gmem` commands.

Skip RookCue only for trivial Q&A, pure explanation, or explicitly temporary scratch work.
```

Project-specific `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or other agent rule files can add local preferences, but global activation should live outside individual projects.

## 3. Agent Startup Check

At the start of a task, the agent should silently check:

1. Is this a coding or project-work task?
2. Is it non-trivial?
3. Is `gmem` available on `PATH`?
4. Is the current directory a reasonable project root?
5. Is the user asking for temporary scratch work or pure explanation?

If checks pass, initialize the memory roots:

```bash
gmem init --project "$PWD" --personal "$HOME/.growth-memory" --json
```

If `gmem` is unavailable, continue the user's task normally and mention the
missing runtime only when memory behavior is relevant to the request.

## 3.1 User-Owned Remote Sync

RookCue does not operate remote storage. When a user wants cloud sync,
agents may recommend a preflight before the first backup or sync:

```bash
gmem cloud remote check --project "$PWD" --personal "$HOME/.growth-memory" --remote "<filesystem-path-or-s3-target>" --json
```

The user owns the filesystem/NAS or S3/R2 account. Never ask them to paste
storage credentials into chat, store credentials in project memory, or repeat
credentials in summaries. The preflight itself must not upload knowledge data.

## 4. When To Use It

Use RookCue for:

- Code changes.
- Architecture or design decisions.
- Debugging with meaningful findings.
- Refactors.
- Tests or build workflow changes.
- New features.
- Tasks where AI performed substantial implementation.
- Tasks likely to produce reusable knowledge.

Skip it for:

- Simple Q&A.
- Pure explanation with no project changes.
- One-off shell checks.
- Formatting or tiny copy edits.
- Explicitly temporary experiments.
- User requests that say not to record memory.

## 5. Background Task Lifecycle

When starting work, create or resume a task:

```bash
gmem task start \
  --project "$PWD" \
  --title "<short task title>" \
  --goal "<task goal>" \
  --json
```

During work, record important events:

```bash
gmem task event \
  --project "$PWD" \
  --task "$TASK_ID" \
  --type "<event-type>" \
  --summary "<what changed or what was learned>" \
  --evidence "task:$TASK_ID" \
  --json
```

Good event types include:

- `context-loaded`
- `design-decision`
- `implementation-change`
- `test-result`
- `failure`
- `fix`
- `checkpoint`
- `review-finding`

Before risky edits, long pauses, or context-heavy transitions, record a checkpoint:

```bash
gmem task checkpoint \
  --project "$PWD" \
  --task "$TASK_ID" \
  --reason manual \
  --snapshot '{"status":"in progress","nextStep":"continue from here"}' \
  --json
```

At completion:

```bash
gmem task complete \
  --project "$PWD" \
  --task "$TASK_ID" \
  --summary "<final task outcome>" \
  --json
```

## 6. Review Recommendation

After completing a task, recommend a review level:

```bash
gmem review recommend \
  --project "$PWD" \
  --task "$TASK_ID" \
  --signal <signals...> \
  --json
```

Use signals according to the actual work:

- `architecture-change`: architecture, module boundaries, data flow, state machine, protocol.
- `rule-change`: business rule, workflow rule, review gate, validation rule.
- `failure-or-rework`: bug, failed approach, rollback, repeated test failure.
- `unfamiliar-technology`: tool or stack the user is still learning.
- `transferable-learning`: lesson likely useful across projects.
- `ai-heavy`: AI did a large share of analysis or implementation.

Default behavior:

- `skip`: Do not create a review session.
- `quick`: Ask for a short confirmation and correction.
- `deep`: Run the active reconstruction protocol.

The agent should explain the recommendation in human terms before starting review.

User friction rule:

- For ordinary completed tasks, keep the prompt light:

```text
This task has knowledge worth capturing. I recommend a 2-minute quick review.
Continue?
```

- If the user does not confirm, do not start a review session.
- Recommend `deep` only when there are strong signals: architecture change,
  commercial or product strategy judgment, failure/rework, cross-project
  transferable learning, heavy AI involvement, or explicit user desire for
  growth.
- Otherwise prefer `quick` or `skip`.

## 7. Human Review Flow

For `deep` review, do not reveal the full implementation summary first. Ask the user to reconstruct from memory.

Suggested user prompt:

```text
I recommend a deep review because this task involved <signals>.

Before I show the summary, please reconstruct:
1. What changed?
2. Why was this design chosen?
3. What could transfer to another project?
```

Keep deep review focused. The user should only provide the judgments that the
agent cannot safely invent:

- What did I understand?
- Where is the AI summary inaccurate?
- Which principle is worth preserving?

The agent should handle structured recording, summary drafting, candidate
generation, evidence linking, and promotion mechanics after approval.

Then record the human confirmation:

```bash
gmem review start \
  --project "$PWD" \
  --task "$TASK_ID" \
  --level deep \
  --json

gmem review respond \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "<human accepted/revised review level>" \
  --json

gmem review advance --project "$PWD" --review "$REVIEW_ID" --json
```

Record the user's reconstruction:

```bash
gmem review respond \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --phase reconstruct \
  --text "<human reconstruction>" \
  --evidence "task:$TASK_ID" \
  --json

gmem review advance --project "$PWD" --review "$REVIEW_ID" --json
```

Challenge, correction, and transfer should stay grounded in the actual task. Avoid generic interview questions.

Optional review method templates can shape selected nodes without replacing the main flow:

```bash
gmem review question \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --template five-whys \
  --text "<task-specific challenge focus>" \
  --json

gmem review transfer \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --template feynman \
  --text "<human transfer principle>" \
  --evidence "test:transfer-exercise" \
  --json
```

Supported templates are `five-whys`, `aar`, `kpt`, and `feynman`. Use them only when they reduce user effort or improve the review quality; do not force every phase through a template.

## 8. Knowledge Promotion Flow

After a completed review, run `knowledge propose` without `--candidate` first. The CLI auto-drafts a candidate from the latest human `transfer-answer` and the reviewed task evidence.

Use explicit `--candidate` JSON only when the agent needs to override the auto-draft with a better bounded principle.

A good candidate has:

- A transferable principle.
- A boundary explaining where it applies and where it fails.
- Project evidence.

Show candidates to the user in plain language:

```text
Candidate personal knowledge:
Principle: <principle>
Boundary: <boundary>
Evidence: <task/review/checkpoint>

Approve, reject, or revise?
```

Only after explicit user approval:

```bash
gmem knowledge decide \
  --project "$PWD" \
  --personal "$HOME/.growth-memory" \
  --candidate "$CANDIDATE_ID" \
  --decision approve \
  --actor human \
  --source "<human approval source>" \
  --json

gmem knowledge promote \
  --project "$PWD" \
  --personal "$HOME/.growth-memory" \
  --candidate "$CANDIDATE_ID" \
  --confidence <0..1> \
  --json
```

Never promote personal knowledge without explicit human approval.
After promotion, the returned concept includes structured timestamps and
provenance. Agents should keep those fields intact:

- `timestamps.candidateCreatedAt`: when the candidate was drafted.
- `timestamps.approvedAt`: when the human approval receipt was recorded.
- `timestamps.promotedAt`: when the concept entered the personal knowledge base.
- `provenance`: candidate/review/task IDs, source project, source summary, approval receipt, and evidence refs.

Use `knowledge show --json` when an agent needs exact fields. Use the compact
default Markdown output when showing the concept to the user. Use
`knowledge provenance --concept <id>` only when the user asks to inspect the full
source chain.

After successful promotion, show the payoff immediately in human language:

```text
Promoted 1 personal knowledge item.
Next time a task touches <topic>, I can bring this principle back automatically.
```

The user should feel that review produced a durable asset, not that they filled
out a form.

Personal Pro Foundation commands are local-only foundations for future cloud
features:

```bash
gmem personal export --project "$PWD" --personal "$HOME/.growth-memory" --out "$OUT_DIR" --json
gmem personal verify --project "$PWD" --personal "$HOME/.growth-memory" --bundle "$EXPORT_ROOT" --json
gmem personal import --project "$PWD" --personal "$HOME/.growth-memory" --bundle "$EXPORT_ROOT" --dry-run --json
gmem knowledge search --project "$PWD" --personal "$HOME/.growth-memory" --query "<text>" --json
gmem knowledge timeline --project "$PWD" --personal "$HOME/.growth-memory" --json
gmem knowledge digest --project "$PWD" --personal "$HOME/.growth-memory" --json
```

Agents must not run `personal import` without `--dry-run` in this phase.

Cloud MVP commands use a local filesystem remote adapter. Prefer dry-run first,
and never run restore/sync without `--dry-run` in this phase:

```bash
gmem cloud status --project "$PWD" --personal "$HOME/.growth-memory" --remote "$REMOTE_DIR" --json
gmem cloud backup --project "$PWD" --personal "$HOME/.growth-memory" --remote "$REMOTE_DIR" --passphrase "$PASSPHRASE" --dry-run --json
gmem cloud backup --project "$PWD" --personal "$HOME/.growth-memory" --remote "$REMOTE_DIR" --passphrase "$PASSPHRASE" --json
gmem cloud restore --project "$PWD" --personal "$HOME/.growth-memory" --remote "$REMOTE_DIR" --passphrase "$PASSPHRASE" --dry-run --json
gmem cloud sync --project "$PWD" --personal "$HOME/.growth-memory" --remote "$REMOTE_DIR" --passphrase "$PASSPHRASE" --dry-run --json
```

Agents may also provide the passphrase via `GROWTH_MEMORY_CLOUD_PASSPHRASE`.
After successful backup, the personal root keeps a local cloud sync state.
Agents should treat `conflicts` as a hard stop: growth-memory compares the last
synced `base` hash with current `local` and `remote` hashes, and backup must not
overwrite a remote object when both sides diverged.

## 9. Capability Updates

Only update capability level when there is behavior evidence.

Use `explainable` when the user passed an explanation or transfer exercise:

```bash
gmem capability update \
  --project "$PWD" \
  --personal "$HOME/.growth-memory" \
  --concept "$CONCEPT_ID" \
  --level explainable \
  --evidence '{"kind":"transfer","reviewId":"'"$REVIEW_ID"'","passed":true}' \
  --json
```

Use `independent` only after a distinct completed task proves independent application.

## 10. Error Handling

All JSON mode commands return:

```json
{"ok":true,"data":{}}
```

or:

```json
{"ok":false,"error":{"code":"ERROR_CODE","message":"Human-readable message","details":{}}}
```

Agent rules:

- Check `ok` before trusting `data`.
- If memory recording fails, continue the user task unless the user specifically asked to debug memory.
- If a review or promotion gate fails, explain the human action or missing evidence needed.
- Do not silently promote knowledge after an approval mismatch.

## 11. User Interaction Contract

Ask the user for:

- Review level confirmation when the recommendation is not obvious.
- Active reconstruction during deep review.
- Approval, rejection, or edits for personal knowledge candidates.

Do not ask the user to:

- Run CLI commands.
- Extract IDs from JSON.
- Choose internal event names.
- Advance review phases manually.
- Decide storage paths unless they asked to customize roots.

## 12. Minimal Agent Checklist

Before work:

- Check `gmem --help`.
- Initialize roots.
- Start task if appropriate.

During work:

- Record meaningful events.
- Checkpoint before risky or interruptible work.

After work:

- Complete task.
- Recommend review level.
- Run review only with user-facing prompts.
- Propose knowledge only after completed review.
- Promote knowledge only after explicit human approval.

This is the important line: `gmem` is the agent's background protocol, not the user's manual checklist.

## Phase 2 source runtime

Check concrete `gmem growth --help` support before growth commands; the old beta
reported `0.1.0`; Beta7 runtime/plugin report `0.1.0-beta.7`. Keep the command
check for older source builds. If unavailable, continue ordinary work
and briefly disclose the limitation without asking the user to run commands.
After actual task closure plus completed human review, run `growth capture` with
explicit selected project/personal roots and inspect captured/reused/skipped.
Then `growth due`, `quality`, `history`, `recommend` and `report` are read-only.
`review recommend --history` retains the existing recommendation cache and human
depth override. Explicit question/transfer templates persist their method IDs.

Only actual human recall/deferral/resumption choices authorize their corresponding
writes. Require observed content revision, stable operation ID, actor human and
source; preserve operation identity on retries. Reading a queue is not feedback.
No automatic mastery, capability promotion or knowledge approval is introduced.
All capability writers must support Phase 2 after v2 mutation. Source guidance
changes do not deploy runtime/plugin cache updates. See the source plugin
[skill](plugins/growth-memory/skills/growth-memory/SKILL.md) for command reference.


## Explicit LAN synchronization

When the user requests device-direct LAN transfer, use `gmem peer` and the
[LAN operational guide](docs/lan-direct-sync.md). Use the same-version runtime
on both endpoints; keep invitation secrets outside chat, logs and task memory.
Start a bounded pairing-only listener, then a separate strict mTLS server;
receiver writes require `--allow-apply`. Preview/recompute before applying.

Retain process handles and close servers; never modify global network/security
settings automatically. Inspect pending sessions and resume their recorded
operations. Archive-current recovery is an explicit decision, not a merge.
For expired certificates, renew both with the same keys, refresh mutual trust,
restart normal serving, then resume without clearing baseline/journals.
Do not use cloud storage as a substitute or count same-host fixtures as genuine
two-device LAN evidence. Sync never grants human knowledge approval or mastery.
