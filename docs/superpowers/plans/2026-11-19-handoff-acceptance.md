# Cross-agent handoff acceptance

The beta.10 candidate should let a new session continue the same task with a
short request. The latest checkpoint supplies the remaining work, artifacts,
constraints and any decision the user still needs to make.

| Scenario | Expected result |
| --- | --- |
| A fresh Grok → Codex → Grok session continues a brief | Keep the task ID and saved scope, verify referenced files and continue from the recorded step. |
| A brief is ready for acceptance | Present the artifact and ask for the recorded decision. Keep the task open until the user decides. |
| A required tool is unavailable | Explain the blocker and preserve the next action and input parameters for the next host. |
| The requested task is unclear | Identify plausible recorded tasks and ask the user to choose. The current runtime permits one active task per project. |
| Two sessions save progress from the same checkpoint | Accept the first save and reject the stale save. Reload before reconciling new work. Test this with an existing checkpoint and with no checkpoint yet. |

- [x] Reproduce the stale overwrite on beta.9 with separate CLI processes.
- [x] Add a CLI regression for stale snapshots, simultaneous saves, retry after reload and saves after closure.
- [x] Add an optional checkpoint precondition under the existing project write lock.
- [x] Document guarded saves and run the handoff and full test suites. All 668 tests passed.
- [x] Validate the Grok-to-Codex handoff with the short request `继续上次任务` after updating the Codex plugin to beta.9.
- [x] Verify the Grok return behavior against the user's screenshot and the saved task state.
- [x] Verify that explicit closure in Grok is visible from Codex for the original task.
- [x] Verify that the approved review lesson can be found by keyword and traced to the closed task.
- [x] Verify that the new Grok brief retains original post quotes and links.
- [x] Verify that all seven cards in the corrected brief and JSON snapshot label the claims as unverified.
- [x] Verify stale checkpoint rejection and recovery in actual Codex and Grok sessions.
- [ ] In a future run, capture the lesson ID and source before screening so its use can be verified.

The user shared a Codex transcript showing that the short request recovered
the original X brief task, presented the HTML and JSON artifacts, and asked for
acceptance while keeping the task open. A read-only check confirmed the beta.9
runtime, the same active task ID, and the presence of the cited artifacts. The
latest checkpoint records a stop after page 2 and 18 collected posts. The JSON
snapshot contains 13 cards and 11 withdrawals. This is a legacy checkpoint.
Codex inferred pending acceptance from its recorded outcome and constraints.

The Grok screenshot shows the 13-card brief and asks whether to keep or revise
the cards while leaving the task open. The same task and checkpoint IDs were
still current in the read-only check, and all referenced artifacts were present.
The crop shows the result and acceptance request. The opening prompt and Grok's
tool calls are outside the crop.

After the user explicitly closed the task in Grok, a read-only check from Codex
confirmed the original record was `completed` and the project had no active task.

A read-only library check found the approved review lesson by keyword and traced
it to the original task, review, and checkpoint. On November 20, the user's Grok
screenshot showed the brief request without a supplied lesson ID or text, and
Grok reported using approved experience. All seven cards in the saved snapshot
include the original quote and post link. Six use the quote as the conclusion,
and no additional evidence is attached to the cards. The GTA card reproduces a
post's numbered list without an explicit verification label. The screenshot
does not show which lesson Grok retrieved or the order of its tool calls.

The follow-up saved all seven conclusions with an explicit unverified label in
both HTML and JSON and retained the original quotes and links. Grok reported
that the earlier lookup could not be established from the available records.
The corrected artifacts verify the labeling. The initial lesson retrieval and
its timing remain unconfirmed.

On November 23, separate Codex and Grok CLI sessions used a candidate runtime
built in a temporary project. Both read the base checkpoint at 10 samples.
Codex saved 20 samples with sample 21 next. Grok's guarded save using the old
checkpoint returned `CHECKPOINT_CONFLICT` and left Codex's checkpoint intact.
Grok then re-read the new base and saved sample 7 as a duplicate. Readback
confirmed the same active task, three checkpoints, the 20-sample progress, and
the unchanged handoff. Grok's first attempt consulted its installed skill and
did not write. The passing attempt explicitly used the temporary candidate
launcher. This exercises both hosts with the candidate runtime in isolation.
