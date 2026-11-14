# Agent Integration Guide

This guide is for Codex, Claude Code, Cursor, Windsurf, and other coding agents that should use RookCue as a background protocol.

Use the bundled [Skill](plugins/growth-memory/skills/growth-memory/SKILL.md)
and its [setup protocol](plugins/growth-memory/skills/growth-memory/references/setup.md).
The plugin contains an installer and launcher; a source checkout and global
CLI installation are no longer prerequisites. Other hosts can use the same local
launcher where Bash and the supported runtime are available; host integration
must still be configured explicitly.

The agent runs commands and extracts IDs. Users express intent, confirm setup
when needed, supply review answers, and approve exact knowledge candidates.

## 1. Intent and authorization

- Recording: an explicit request authorizes that task. If merely inferred, ask once.
- Lookup: read-only search; no initialization or task creation.
- Recovery: inspect existing context and checkpoints, resolve ambiguity, reuse the
  identified task. Never complete an unrelated active task to clear the slot.
- Review: obtain the actual review-level decision and human answers.
- Promotion: show principle, boundary and evidence; require exact-content approval.

Ordinary coding does not automatically authorize recording. A previously stated
standing preference may do so, but silence does not. Never fabricate human answers
or knowledge approval. Installation consent and task recording are separate scopes.

## 2. Runtime setup

For a multi-agent installation, inspect `rookcue.sh agents`, then execute
`rookcue.sh install --approve-install` under the user's installation authorization.
Optional `--agents codex,grok,claude` selects hosts explicitly. The shared installer
supports macOS/Linux. `rookcue.sh connect` attaches newly detected hosts;
`rookcue.sh agents` inspects filesystem connections without writes.
Use `install` from a new release to upgrade runtime and shared skill together.
Existing Codex plugins are `plugin-managed`; disable the old plugin in Codex
before migrating that host to the shared skill. Verify actual skill loading
in a new host session separately from filesystem connection checks.

Resolve the installed Skill directory from the host. Run:

```bash
bash "$SKILL_DIR/scripts/rookcue.sh" check
```

If setup is needed, explain pinned source/dependency downloads, optional private
Node, and the install directory, then request consent. After approval:

```bash
bash "$SKILL_DIR/scripts/rookcue.sh" setup --approve-install
bash "$SKILL_DIR/scripts/rookcue.sh" check
```

A `ready` result is required before use. The script prefers a compatible
`rookcue`, `gmem`, or `growth-memory`, then its private runtime. It does not
modify global links or shell profiles. Setup failures do not authorize bypasses.

## 3. Roots and invocation

Use the current repository root for `--project` and `$HOME/.growth-memory` for
`--personal`, unless the user already chose another location. Pass both explicitly
where supported. In the examples below, `rookcue` abbreviates:

```bash
bash "$SKILL_DIR/scripts/rookcue.sh" run -- <CLI arguments>
```

Pass user text as literal arguments, use `--json`, and check `ok`. Only initialize
roots for authorized recording, never for a read-only lookup/recovery request.

## 4. Lookup and recovery before recording

Follow the [lookup/recovery reference](plugins/growth-memory/skills/growth-memory/references/lookup-and-recovery.md).
Search relevant approved experience at an authorized task's start and before a
related decision. Show at most one relevant principle with source and boundary.
No automatic match means no interruption; an explicit search gets an honest empty
result. Inspect context before starting a task so recovery does not create duplicates.

## 5. Background Task Lifecycle

When starting work, create or resume a task:

```bash
rookcue task start \
  --project "$PWD" \
  --title "<short task title>" \
  --goal "<task goal>" \
  --json
```

During work, record important events:

```bash
rookcue task event \
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
rookcue task checkpoint \
  --project "$PWD" \
  --task "$TASK_ID" \
  --reason manual \
  --snapshot '{"status":"in progress","nextStep":"continue from here"}' \
  --json
```

At completion:

```bash
rookcue task complete \
  --project "$PWD" \
  --task "$TASK_ID" \
  --summary "<final task outcome>" \
  --json
```

## 6. Review Recommendation

After completing a task, recommend a review level:

```bash
rookcue review recommend \
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
rookcue review start \
  --project "$PWD" \
  --task "$TASK_ID" \
  --level deep \
  --json

rookcue review respond \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --phase context \
  --text "<human accepted/revised review level>" \
  --json

rookcue review advance --project "$PWD" --review "$REVIEW_ID" --json
```

Record the user's reconstruction:

```bash
rookcue review respond \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --phase reconstruct \
  --text "<human reconstruction>" \
  --evidence "task:$TASK_ID" \
  --json

rookcue review advance --project "$PWD" --review "$REVIEW_ID" --json
```

Challenge, correction, and transfer should stay grounded in the actual task. Avoid generic interview questions.

Optional review method templates can shape selected nodes without replacing the main flow:

```bash
rookcue review question \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --template five-whys \
  --text "<task-specific challenge focus>" \
  --json

rookcue review transfer \
  --project "$PWD" \
  --review "$REVIEW_ID" \
  --template feynman \
  --text "<human transfer principle>" \
  --evidence "test:transfer-exercise" \
  --json
```

Supported templates are `five-whys`, `aar`, `kpt`, and `feynman`. Use them only when they reduce user effort or improve the review quality; do not force every phase through a template.

## 8. Knowledge Promotion Flow

After a completed deep review, `knowledge propose` can auto-draft from the human transfer answer. A quick review has no transfer phase: draft an explicit, evidence-backed candidate if useful, then obtain separate exact-content approval. See the [review reference](plugins/growth-memory/skills/growth-memory/references/review-and-approval.md).

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
rookcue knowledge decide \
  --project "$PWD" \
  --personal "$HOME/.growth-memory" \
  --candidate "$CANDIDATE_ID" \
  --decision approve \
  --actor human \
  --source "<human approval source>" \
  --json

rookcue knowledge promote \
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
At a future authorized task involving <topic>, I can search for this principle and show it when its boundary fits.
```

The user should feel that review produced a durable asset, not that they filled
out a form.

These commands export and verify local personal knowledge, preview imports, and
show search results, timelines, and digests:

```bash
rookcue personal export --project "$PWD" --personal "$HOME/.growth-memory" --out "$OUT_DIR" --json
rookcue personal verify --project "$PWD" --personal "$HOME/.growth-memory" --bundle "$EXPORT_ROOT" --json
rookcue personal import --project "$PWD" --personal "$HOME/.growth-memory" --bundle "$EXPORT_ROOT" --dry-run --json
rookcue knowledge search --project "$PWD" --personal "$HOME/.growth-memory" --query "<text>" --json
rookcue knowledge timeline --project "$PWD" --personal "$HOME/.growth-memory" --json
rookcue knowledge digest --project "$PWD" --personal "$HOME/.growth-memory" --json
```

Agents must not run `personal import` without `--dry-run` in this phase.

## 9. Capability Updates

Only update capability level when there is behavior evidence.

Use `explainable` when the user passed an explanation or transfer exercise:

```bash
rookcue capability update \
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

- Resolve intent and authorization.
- Check the bundled launcher; install only after installation consent.
- Inspect context and search relevant experience.
- Initialize roots/start a task only for authorized recording.

During work:

- Record meaningful events.
- Checkpoint before risky or interruptible work.

After work:

- Complete task.
- Recommend review level.
- Run review only with user-facing prompts.
- Propose knowledge only after completed review.
- Promote knowledge only after explicit human approval.

This is the important line: `rookcue` is the agent's background protocol, not the user's manual checklist.

## Phase 2 source runtime

Check concrete `rookcue growth --help` support before growth commands; the old beta
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

When the user requests device-direct LAN transfer, use `rookcue peer` and the
[LAN operational guide](docs/lan-direct-sync.md). Use the same-version runtime
on both endpoints; keep invitation secrets outside chat, logs and task memory.
Start a bounded pairing-only listener, then a separate strict mTLS server;
receiver writes require `--allow-apply`. Preview/recompute before applying.

Retain process handles and close servers; never modify global network/security
settings automatically. Inspect pending sessions and resume their recorded
operations. Archive-current recovery is an explicit decision, not a merge.
For expired certificates, renew both with the same keys, refresh mutual trust,
restart normal serving, then resume without clearing baseline/journals.
Use two physical devices to verify LAN transfer. Sync never grants human knowledge approval or mastery.
