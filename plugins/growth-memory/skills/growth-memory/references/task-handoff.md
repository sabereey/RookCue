# Task handoff

Use for an authorized task's checkpoints and cross-agent recovery. The task ID
and lifecycle stay unchanged during handoff. An `active` task may be paused,
blocked, or waiting for acceptance; it does not necessarily have work executing.

## Save a complete snapshot

Read the latest checkpoint before writing. `--snapshot` replaces the snapshot;
the runtime does not merge fields or infer approval. Carry forward still-relevant
query/window/cursor parameters, existing files, constraints, and completed work.
Update only what changed. Keep older checkpoint IDs as source references when
recovering missing details. Remove obsolete information deliberately, with a reason.

Save against the checkpoint ID returned by `context show` when you read the
snapshot. For the first checkpoint, use `@none` if no checkpoint was returned.

```bash
rookcue task checkpoint --project "$PROJECT_ROOT" --task "$TASK_ID" \
  --reason interrupt --if-checkpoint "$BASE_CHECKPOINT_ID" \
  --snapshot '<full updated snapshot JSON>' --json
```

On `CHECKPOINT_CONFLICT`, reload `context show` and reconcile your observed work
with the newer snapshot before retrying. Keep the newer cursor, constraints and
evidence unless you can verify a correction. If changes cannot be reconciled,
or the checkpoint still cannot be read, report the conflict. On `TASK_NOT_ACTIVE`,
reload context and report the task state before attempting any further write.
If the runtime does not recognize `--if-checkpoint`, report that guarded saving
requires a newer runtime. A retry without the flag can overwrite newer progress.

Keep large raw results in durable project files. Put paths and summaries in the
checkpoint. Verify referenced files exist. Keep raw inputs separate from derived
reports, and distinguish previous-run files from current-run deliverables.

Include `handoff` in the snapshot using the following version 1 contract. Replace
the example content with observed facts; keep domain-specific fields beside it.

```json
{
  "handoff": {
    "version": 1,
    "state": "awaiting-user",
    "goal": "Deliver a sourced brief",
    "scope": "Build the brief from the collected posts",
    "summary": "Brief generated; retrieval stopped at the recorded stopping condition",
    "nextStep": "Present the brief and ask the user to accept it or request corrections",
    "pendingDecision": "Accept the brief or specify corrections; task remains open",
    "constraints": ["Do not complete the task or start a review"],
    "requiredTools": [],
    "artifacts": ["snapshots/raw-posts.json", "snapshots/screening.md", "snapshots/brief.html"],
    "completedWork": [
      {"agent": "grok", "summary": "Retrieved posts", "evidence": ["snapshots/raw-posts.json"]},
      {"agent": "codex", "summary": "Screened saved posts offline", "evidence": ["snapshots/screening.md"]},
      {"agent": "grok", "summary": "Built the brief", "evidence": ["snapshots/brief.html"]}
    ]
  }
}
```

All displayed fields except `pendingDecision` are required. Arrays may be empty
when there is nothing to report. Each completed-work entry needs evidence and
an `agent` string, or `null` if its executor is unknown. Attribution is reported
metadata, not authenticated identity. Infer no executor from who last saved the
checkpoint or which agent is speaking now.

| Field | Meaning |
| --- | --- |
| `goal` | Long-term outcome, without a temporary pause instruction |
| `scope` | What this round was authorized to do |
| `summary` | Observed progress, not a promise |
| `state` | `in-progress`, `paused`, `blocked`, or `awaiting-user` |
| `nextStep` | Concrete next action or decision, even when work must stop |
| `pendingDecision` | Required for `awaiting-user`; the specific human decision still missing |
| `constraints` | User limits carried forward until the user changes them |
| `requiredTools` | Capabilities needed for the next action; name unavailable dependencies |
| `artifacts` | Durable files needed to resume or inspect the outcome |
| `completedWork` | Cumulative relevant work with original executor and evidence |

Choose state from observed conditions:
- Work remains and execution continues: `in-progress`.
- Work remains and the user requested a pause: `paused`.
- Work remains but a tool or prerequisite is unavailable: `blocked`, with that
  dependency and its resolution in `requiredTools` and `nextStep`.
- Deliverables are ready and acceptance is pending, including a request to keep
  the task open: `awaiting-user`, with the artifact to inspect and decision needed.

If the user has already authorized completion and no acceptance decision remains,
complete the task normally. Do not invent an acceptance gate for every task.
Acceptance, task closure, review participation, and knowledge approval are separate
decisions. A generic “continue” is not evidence that an artifact was accepted.

## Recover and report

Use `context show`. Updated runtimes expose the validated handoff as `data.handoff`;
it is also stored in `latestCheckpoint.snapshot.handoff`. `status` shows the
execution state and pending decision. Older runtimes can store the snapshot but
do not validate or surface these fields separately; inspect the snapshot directly.

Report in this order: same task ID and lifecycle, current execution state, completed
work with known attribution, verified artifacts, remaining work/dependency, next
action or pending decision. Use the latest checkpoint for progress; the task's
original goal may still contain an old pause instruction. Do not rewrite history.

When `awaiting-user`, show the deliverable and ask the recorded decision; do not
repeat completed retrieval or treat “continue” as acceptance. When `paused`, continue
the identified task only within the latest user authorization. When `blocked`,
explain the missing capability and continue independent authorized work if possible.

Versioned handoffs are validated on new writes. Existing snapshots, including
legacy free-form `handoff` keys, remain readable; unversioned legacy values remain
writable. Only a valid version 1 handoff is exposed as structured recovery data.
Legacy checkpoints remain valid. Read their explicit status, files, constraints
and next step. If they record ready deliverables plus “do not complete/review”,
report that the deliverable awaits the user's decision. Attribute undocumented
work as unknown. Do not silently migrate or write during read-only recovery.
On the next authorized checkpoint, add the contract using verified facts.
