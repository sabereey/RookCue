# Multi-agent installation implementation plan

Implement the user's requested single-install experience in the current checkout.
The existing launcher remains the entry point and runtime owner. A shared,
content-addressed skill copy supports Codex, Grok and Claude Code on macOS/Linux.
Agent-specific symlinks point to an atomically switched current skill. Existing
Codex plugins remain host-managed to avoid duplicate discovery.

- [x] Add behavioral tests for read-only discovery, detected/explicit agents,
  repeated installation, source-independent copies, shared updates, conflicts,
  legacy Codex plugins, and concurrent installation locks.
- [x] Add `agents` and `connect [--agents auto|codex,grok,claude]` to the launcher.
  Use one locked installer and return per-agent states with actionable failures.
- [x] Add `install --approve-install [--agents ...]` to compose the existing
  runtime setup and agent connection. Reuse setup's Node bootstrap and offline
  options. Validate all arguments before writes.
- [x] Document one natural-language installation request, host-managed plugin
  coexistence, upgrades, new agents, shared data and environment boundaries.
- [x] Run plugin tests, typecheck and full suite. Report live-host validation
  separately from filesystem fixtures.

Review focus includes conflicting user-owned directories, broken links,
interrupted publication, duplicate Codex plugin discovery, custom runtime roots,
and paths containing spaces. Preserve knowledge data and existing host settings.

Verification completed on 2026-11-13. Plugin tests passed (34), typecheck and shell syntax passed, and the diff whitespace check passed. The full suite passed 562 cases inside the sandbox; 79 loopback-listener cases were blocked by EPERM. All four affected files then passed outside the sandbox (86 cases), covering all 641 cases in aggregate. Independent review findings on Bash 3.2 empty arrays and host-path error isolation were reproduced, fixed and reviewed again. Live agent loading and release publication remain separate acceptance steps.
