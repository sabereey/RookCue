# RookCue plugin first-use implementation plan

> Execute inline with superpowers:executing-plans. The user approved the proposed plugin-first workflow with “do it”.

**Goal:** Let a user install the plugin once and use natural language to record, recover, find and review experience, with agent-managed runtime setup and scoped human confirmation.

**Architecture:** Retain the existing CLI and data formats. Ship an independent launcher with the plugin: reuse a compatible installed CLI, otherwise install a checksum-pinned public source revision into a private user directory after consent. Bootstrap a private Node distribution when necessary on macOS arm64/Linux x64. Skills route user intent and keep human decisions outside automation.

**Tech stack:** Bash, dependency-free Node ESM, existing TypeScript CLI, Vitest.

## Constraints and decisions

- Reuse this clean checkout; preserve CLI aliases and plugin identity `growth-memory`.
- No automatic writes just because a coding task exists. An explicit recording request authorizes that task; an inferred suggestion needs confirmation. Installation consent is separate.
- Read-only lookup/recovery must not initialize roots or start a new task.
- Approval of a task or review is not approval of a candidate. Exact candidate content requires actual human approval.
- Runtime setup must work from a copied plugin without the source checkout or global npm link. Downloads are pinned and verified, installation is staged, retries are safe, existing installations/data are preserved.
- Keep unfinished Cloud features out of public usage docs. No website in this change.
- Distribution remains GitHub/source plugin installation, not a claim of listing in the public plugin directory.
- The existing runtime is unchanged; pin its already published revision. Plugin version remains compatible with beta.8.

## Tasks

- [x] 1. Baseline skill scenarios and installer tests: absent runtime, no consent, aliases, incompatible binaries, argument forwarding, copied plugin, integrity failure/retry, missing Node and readonly roots.
- [x] 2. Implement bundled launcher/setup with fixed source checksum, isolated install location, Node prerequisite bootstrap and clear JSON outcomes. Verify real fresh setup and retry.
- [x] 3. Rewrite intent-specific Skill; add setup, recovery/search and review references; update plugin prompts and user docs. Pressure-test actual consuming agents, including ambiguous tasks and absent human answers.
- [x] 4. Run a disposable CLI record → checkpoint/recover → human-input fixture review → exact approval → next-task search test. Do not manufacture a real human lesson or count the fixture as real-world adoption evidence.
- [ ] 5. Run appropriate full tests/typecheck, fresh review, correct issues, commit and push under existing publication authorization. Verify remote commit.

## Review focus

- Missing/outdated Node or npm, and spaces in install paths.
- Failed download/build or concurrent installs must leave no apparently usable partial runtime.
- Existing PATH aliases must be compatible, and forwarded user text must never become shell code.
- Lookup of an empty library must not write files; recovery must not create duplicate tasks.
- Broad phrases such as “记住” must not become fabricated human responses/approval.

## Evidence ledger

- Baseline skill simulation: ordinary bug requests start memory without consent; absent runtime skips setup; knowledge lookup/recovery procedures absent. Human approval exists but exact-content scope needs clarification.

- Installer regressions: corrupt archives, missing consent, missing Node/npm, native CLI reuse, invalid arguments, alias fallback, literal argv, production-mode builds, failed builds/retry, concurrent locks, source/Node download cancellation and subprocess-tree termination.
- Real macOS arm64 smoke: empty runtime directory with PATH excluding Node/CLI installed private Node 24.12.0 and built pinned beta.8; actual GitHub source-download setup passed; offline retry reused it. Actual pinned-source build under NODE_ENV=production + npm omit=dev passed after explicit dev-dependency inclusion.
- Disposable workflow test: read-only empty lookup, task/checkpoint recovery without duplication, quick-review human gates, promotion refusal before approval, exact-content approval fixture, and knowledge search from a second project with source/boundary intact. No real personal knowledge or human approval was synthesized.
- Skill consuming-agent evaluation: ordinary coding stays inactive; missing runtime waits for installation consent; empty lookup stays read-only; ambiguous recovery asks; five save-intent phrasings preserve exact-content approval. Generic review intent now explicitly asks for depth once.
- Independent implementation review found four installer issues; all corrected and re-reviewed. No remaining material findings.
- Full regression: 42 test files, 630 tests passed. TypeScript typecheck passed.
- Local Codex plugin installed from this source marketplace; all 11 packaged files matched source. Previous private-beta plugin disabled (files retained) to prevent duplicate activation. Installed launcher detects the existing compatible rookcue command. A new conversation is needed to load the new Skill.
- Ruling: retained beta.8 runtime/plugin identity and pinned the already published, unchanged CLI revision; only plugin packaging/behavior changed. The source installer preserves all source/license files. Public-directory submission and real-world adoption evidence remain outside this implementation.
