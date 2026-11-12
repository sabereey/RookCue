---
name: growth-memory
description: Use when Codex is doing non-trivial coding or project work and should record task progress, recommend lightweight reviews, and promote personal knowledge only after human approval.
---

# RookCue

Use `growth-memory` as Codex's background protocol for non-trivial coding work.

## Activation

Use this skill for:

- Code changes.
- Architecture or design decisions.
- Debugging with meaningful findings.
- Refactors.
- Tests or build workflow changes.
- New features.
- Tasks where AI performed substantial implementation.
- Tasks likely to produce reusable knowledge.

Skip this skill for:

- Simple Q&A.
- Pure explanation with no project changes.
- One-off shell checks.
- Formatting or tiny copy edits.
- Explicitly temporary experiments.
- User requests that say not to record memory.

## Roots

Use `--project` as the current repository root.

Use `--personal` as `$HOME/.growth-memory`.

Prefer `gmem` when available on `PATH`. Fall back to `growth-memory` when `gmem` is missing.

## User Contract

Do not ask the user to run `growth-memory` commands manually.

Run CLI commands in the background and only interrupt the user for:

- Review level confirmation.
- Reconstruction answers.
- Correction or clarification.
- Knowledge approval or rejection.

Never promote personal knowledge without explicit human approval.

## Task Lifecycle

At the start of non-trivial work:

```bash
growth-memory task start --project "$PWD" --title "<short task title>" --goal "<task goal>" --json
```

During work, record important events:

```bash
growth-memory task event --project "$PWD" --task "$TASK_ID" --type "<event-type>" --summary "<summary>" --evidence "task:$TASK_ID" --json
```

At completion:

```bash
growth-memory task complete --project "$PWD" --task "$TASK_ID" --summary "<final outcome>" --json
```

## Review Recommendation

For ordinary completed tasks, keep the prompt light:

```text
This task has knowledge worth capturing. I recommend a 2-minute quick review.
Continue?
```

If the user does not confirm, do not start a review session.

Recommend `deep` only when there are strong signals:

- Architecture change.
- Commercial or product strategy judgment.
- Failure, rollback, or meaningful rework.
- Cross-project transferable learning.
- Heavy AI involvement.
- Explicit user desire for personal growth.

Otherwise prefer `quick` or `skip`.

## Deep Review

Do not reveal the full implementation summary before reconstruction.

Keep deep review focused. The user should only provide the judgments that the agent cannot safely invent:

- What did I understand?
- Where is the AI summary inaccurate?
- Which principle is worth preserving?

The agent handles structured recording, summary drafting, candidate generation, evidence linking, and promotion mechanics after approval.

## Knowledge Promotion

After a completed review, propose candidates in plain language.

Only after explicit approval:

```bash
growth-memory knowledge decide --project "$PWD" --personal "$HOME/.growth-memory" --candidate "$CANDIDATE_ID" --decision approve --actor human --source "<human approval source>" --json
growth-memory knowledge promote --project "$PWD" --personal "$HOME/.growth-memory" --candidate "$CANDIDATE_ID" --confidence <0..1> --json
```

After successful promotion, show the payoff immediately:

```text
Promoted 1 personal knowledge item.
Next time a task touches <topic>, I can bring this principle back automatically.
```

The user should feel that review produced a durable asset, not that they filled out a form.

## Phase 2 local growth reference

When the available runtime supports `gmem growth --help` (use `growth-memory`
if that is the available executable), use these additional commands. Phase 2 first shipped in Beta7. The current runtime
and plugin report `0.1.0-beta.8`. Historical beta.5 reported `0.1.0`; for older
builds that version alone is insufficient, so keep the command-support check.
When runtime or growth support is absent, continue ordinary work and briefly
state the limitation; the agent handles commands without asking the user to run them.

After the task is actually closed and its human review is completed, explicitly
capture the selected project's minimal review history for later reports:

```bash
gmem growth capture --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
gmem growth due --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

Capture can be retried; inspect `captured`, `reused`, and `skipped`. A skipped
active/abandoned task with reason `task-not-completed` was not captured. Complete
a task only when the actual work is done. Capture copies structured history,
without review response text. It does not approve knowledge or assess skill.

`growth quality [--concept ID]`, `growth due`, `growth history [--concept ID]`,
`growth recommend [--task ID]`, and `growth report --period week|month` are
read-only with the same explicit roots. Report defaults to Markdown;
`--format json` or `--json` gives the normal envelope. Quality describes
structure/evidence coverage and uncertainty, not truth or mastery. Due dates
are practice suggestions. Reports disclose observed sources and missing history.
`review recommend --history` opts into advice and the existing cache; the human
still chooses review depth and methods.

When the human actually supplies a recall result, record `growth recall
--concept ID --result recalled|partial|forgotten --revision HASH --operation ID
--actor human --source TEXT` with both roots and `--json`. Obtain HASH from the
observed quality/due result and retain the same operation ID for retries.
`growth defer --concept ID --until ISO` and `growth resume --concept ID` require
the same revision, operation, actor and source flags and actual human choice.
No recall test means no recall outcome; reading due/report does not record one.
Human capability assessment remains explicit; no automatic mastery or promotion.

After capability state becomes version 2, every device writing it must use a
Beta7-or-newer runtime with `growth --help` support from this implementation.
Direct LAN peer synchronization requires Beta8 on both endpoints.
Back up the previous executable and complete data roots before upgrade. Reads
preserve persisted v1 bytes and expose unknown baseline history. An explicit
human capability update creates v2/history once; use the same operation ID and
exact arguments for retry. Export/verify retains history. To downgrade, restore
the whole prior backup to a separate root; never discard v2 fields.
Old beta writers reject v2. Updating this source guide does not update installed
runtime/plugin caches.


## Explicit LAN device synchronization

When the user requests direct device-to-device knowledge transfer or recovery
of a peer sync, read [the LAN reference](references/lan-direct-sync.md) before
operating either endpoint. Use the peer commands for the requested direct path.
Invitations are private credentials; keep them out of chat, task memory and logs.
Use explicit roots, observed peer identities and managed short-lived processes.

The reference defines pairing, write permission, conflict decisions, expired
certificate refresh and pending-session recovery. Confirm both terminal receipts
and matching baseline evidence; loopback fixtures alone do not prove two-Mac LAN
acceptance. Preserve ordinary human review/knowledge-approval rules above.
