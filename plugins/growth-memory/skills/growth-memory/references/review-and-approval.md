# Human review and exact approval

Use the launcher from SKILL.md for every `rookcue` command below. IDs must come
from actual JSON responses. `review respond` and `review transfer` record HUMAN
input; `review correct` records an AI correction. Never substitute one for another.

## Quick review

Identify the completed task. For an ordinary task, offer a short quick review and
wait for acceptance unless the user already explicitly selected quick review.
A generic “复盘一下” requests a review, but does not select its depth: propose
quick once and wait for the level decision. Then:

```bash
rookcue review start --project "$PROJECT_ROOT" --task "$TASK_ID" --level quick --json
rookcue review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase context --text "<actual human level decision>" --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

The returned phase should be `correct`. Show a concise evidence-backed summary
and ask the user to confirm/correct it. Wait for the actual answer:

```bash
rookcue review respond --project "$PROJECT_ROOT" --review "$REVIEW_ID" --phase correct --text "<actual human confirmation or correction>" --evidence "task:$TASK_ID" --json
rookcue review advance --project "$PROJECT_ROOT" --review "$REVIEW_ID" --json
```

Verify `status=completed`, `phase=complete`. A quick review has no human transfer
answer, so its auto-proposal can be empty. If there is a supported reusable lesson,
draft an explicit candidate from the reviewed task instead of fabricating a transfer
answer or forcing a deep review. It still requires separate exact-content approval.

## Deep review

Recommend deep only for strong signals (architecture, meaningful rework, transferable
learning) or an explicit user request. Use `review recommend --task ID --signal
architecture-change transferable-learning --json` with the project root when those
signals actually occurred. Start with `review start --level deep --signal ...` only
after the user accepts. The human selects the depth; a score does not authorize it.

Follow `context → reconstruct → challenge → correct → transfer → complete`:

1. Record the actual level decision via `review respond --phase context`, then advance.
2. Before revealing the detailed solution, ask the user to reconstruct what changed
   and why. Record their answer with `review respond --phase reconstruct`, then advance.
3. Ask a specific challenge with `review question --text ...`; record the user's
   answer using `review respond --phase challenge`, then advance.
4. Provide the AI correction via `review correct --text ... --evidence kind:id`,
   grounded in observed evidence, then advance.
5. Ask where the principle transfers. Record the human answer using `review transfer
   --text ... --evidence kind:id`, then advance and verify completion.

Every command also takes `--project`, `--review`, and `--json`. `review show` reports
the phase; do not advance blindly. If input is missing, wait or interrupt the
review with `review interrupt`; never invent the user's reconstruction or transfer.

## Candidate approval

After a completed deep review, `knowledge propose --review ID` can auto-draft from
the human transfer answer. For a quick review, supply an explicit candidate:

```bash
rookcue knowledge propose --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --review "$REVIEW_ID" --candidate '<JSON with principle, boundary, evidence>' --json
```

Build valid JSON with a JSON serializer and pass it as one argument. The evidence
array contains actual references such as `{"kind":"task","id":"<task id>"}`.
Show the returned candidate's principle, boundary and evidence, with its ID so
approval can be tied to the exact candidate. Ask approve/reject/revise. A general
request to “记住这个经验” permits preparing this draft, not approving unseen text.

Only after the user approves that exact content:

```bash
rookcue knowledge decide --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_ID" --decision approve --actor human --source "<observed human approval quote/reference>" --json
rookcue knowledge promote --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --candidate "$CANDIDATE_ID" --confidence <0..1> --json
```

Reject only on an actual user rejection. If the candidate changes, show it again
and get new approval. Never make up `--source`. If the receipt no longer matches,
stop and resolve it with the user. Confidence describes evidence strength, not
the user's mastery. Show the saved principle and a concrete future-use condition.
