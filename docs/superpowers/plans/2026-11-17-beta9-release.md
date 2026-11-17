# Beta.9 release implementation plan

Goal: publish one traceable beta.9 product version with automated checks, native
packages, shared skill, bilingual notes and clean-install/upgrade evidence.

Approved scope: main plus short development branches; unified CLI/plugin/skill
version; immutable release tags/assets; independent data schema versions.

- [ ] Add tested bump/check/pin tooling; remove launcher/test version duplication.
- [ ] Add PR/main CI and tag-only release workflow with two native platforms,
  checksums, source/skill packages and publication only after all checks pass.
- [ ] Add disposable fresh-install and beta.8 upgrade verification.
- [ ] Update English/Chinese release notes, changelog and release procedure.
- [ ] Test and review; commit runtime source, push, then pin its downloaded archive.
- [ ] Verify final revision, merge to main, tag v0.1.0-beta.9, monitor Actions and
  verify published assets. Never move a published tag or replace published assets.

Runtime pin identifies the runtime input commit; the later release commit contains
that immutable pin. Runtime-relevant trees must be identical between those commits.
No real project/personal data is migrated as part of release tests.
