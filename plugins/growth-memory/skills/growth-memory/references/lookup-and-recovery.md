# Read-only lookup and recovery

Use the launcher from SKILL.md for every `rookcue` command below.

## Find related experience

```bash
rookcue knowledge search --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --query "<specific topic terms>" --limit 3 --json
rookcue knowledge show --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --concept "$CONCEPT_ID" --json
rookcue knowledge provenance --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --concept "$CONCEPT_ID" --json
```

Search terms should come from the task: component names, failure symptoms, or the
decision being made. Search is lexical, not a semantic vector index; a long
conversational Chinese phrase may not match shorter terms. Try a few specific
terms or a relevant code identifier. Inspect actual results, never infer a hit.
Only use an approved, non-obsolete concept whose boundary fits the new task.

Show a short principle, why it fits, its limitation and the returned source task
or review. Use provenance when more detail is needed. For automatic task-start
retrieval, no relevant match means no interruption. For an explicit lookup,
report no match without inventing experience. These reads never need `init`.

## Continue previous work

```bash
rookcue context show --project "$PROJECT_ROOT" --json
rookcue status --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
```

Read `activeTask`, `latestCheckpoint`, `working`, and `latestReview`. Summarize:
task title, observed progress, blocker, next step, and any pending human decision.
Reuse the active task ID if it is clearly the requested task. “Continue” authorizes
continuing that identified task; it does not grant new knowledge approval.

If no active task or several historical tasks could be meant, read recent
`<project>/.growth-memory/tasks/*.json` with filesystem tools and show only titles,
dates and status. Ask which task the user means. There is no `task resume` or
`task list` command in this runtime: do not invent one. Do not reopen completed
tasks by editing JSON. A follow-up to a completed task needs a new task with the
user's recording authorization; preserve the original evidence.

An interrupted review can be inspected with `review show --review ID --json`;
use `review resume --review ID --json` with the project root only when the user
wants to continue that review. Preserve its current phase and wait for missing
human input. Do not start another review to bypass its gates.

Missing memory means no recorded task to recover. Do not initialize directories
or create a task as a side effect of answering a recovery request.
