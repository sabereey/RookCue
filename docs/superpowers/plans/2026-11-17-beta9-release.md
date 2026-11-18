# Beta.9 release implementation plan

Goal: publish one traceable beta.9 product version with automated checks, native
packages, shared skill, bilingual notes and clean-install/upgrade evidence.

Approved scope: main plus short development branches; unified CLI/plugin/skill
version; immutable release tags/assets; independent data schema versions.

- [x] Add tested bump/check/pin tooling; remove launcher/test version duplication.
- [x] Add PR/main CI and tag-only release workflow with two native platforms,
  checksums, source/skill packages and publication only after all checks pass.
- [x] Add disposable fresh-install and beta.8 upgrade verification.
- [x] Update English/Chinese release notes, changelog and release procedure.
- [x] Test and review; commit runtime source, push, then pin its downloaded archive.
- [x] Verify final revision, merge to main, tag v0.1.0-beta.9, monitor Actions and
  verify published assets. Never move a published tag or replace published assets.

Runtime pin identifies the runtime input commit; the later release commit contains
that immutable pin. Runtime-relevant trees must be identical between those commits.
No real project/personal data is migrated as part of release tests.

Completed 2026-11-18: release tag points to 7cb55464302322a82392a4515573592a8cba47d1.
Actions run 44225385635 passed both native builds and publication. All 667 tests
passed locally and in the release builds; fresh installation and beta.8 upgrade
preserved project/personal bytes. Release contains four archives, SHA256SUMS and
install-verification.json. Published asset digests match the checksum manifest.
Post-publication documentation correction records the stale Zod inventory label;
runtime and immutable tag/assets remain unchanged.
