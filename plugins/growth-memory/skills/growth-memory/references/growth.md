# Growth commands

Use the resolved launcher from SKILL.md for every command below.

## Phase 2 local growth reference

When the available runtime supports `rookcue growth --help` (substitute the
available alias when needed), use these additional commands. Phase 2 first shipped in Beta7. The current runtime
and plugin report `0.1.0-beta.8`. Historical beta.5 reported `0.1.0`; for older
builds that version alone is insufficient, so keep the command-support check.
When runtime or growth support is absent, continue ordinary work and briefly
state the limitation; the agent handles commands without asking the user to run them.

After the task is actually closed and its human review is completed, explicitly
capture the selected project's minimal review history for later reports:

```bash
rookcue growth capture --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
rookcue growth due --project "$PROJECT_ROOT" --personal "$PERSONAL_ROOT" --json
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


