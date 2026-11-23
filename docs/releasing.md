# Releasing RookCue

English | [简体中文](releasing_CN.md)

Use short `codex/*` branches and pull requests; keep `main` passing CI. CLI,
plugin and shared skill use one product version. Data schema versions are separate.
Never move published tags or replace release assets: publish a new version instead.
Beta versions advance beta.9, beta.10, etc.; publish 0.1.0 after core installation,
upgrade, recovery and approval flows have stable acceptance evidence. Later patches
fix compatible bugs; minor versions add compatible features; breaking stable APIs
or data contracts require a major version and an explicit migration plan.

## Prepare

```sh
npm run release:version -- 0.1.0-beta.10
npm run release:check
npm run typecheck
npm test -- --maxWorkers=2 --testTimeout=30000
```

The bump updates package, lockfile, plugin manifest, runtime manifest and the
Node-free launcher version together. Add matching bilingual changelog entries and
`docs/releases/<version>.md`. Commit and push the runtime source candidate first.

```sh
npm run release:pin -- FULL_RUNTIME_SOURCE_COMMIT
npm run release:verify-pin
npm run release:verify-install
```

Pinning downloads the candidate's GitHub archive, hashes it and fixes the runtime
URL/commit/checksum. Verification rejects differing runtime sources, package/lock
inputs or version. The final release commit includes the pin; the runtime input
commit precedes it to avoid self-reference. Both identities remain traceable.
The install check uses disposable HOME/project/personal roots and validates fresh
installation, upgrade from beta.9, unchanged data bytes, readable approved
knowledge, retained runtime, and conflict recovery through the shared skill paths.
The optional argument to `release:verify-install` selects the previous skill commit;
its current baseline is the beta.9 release tag's commit.

Commit the pin, review/merge to main and wait for CI and both native build jobs.
Main and `codex/release-*` pushes build and verify without publishing. Tag the final clean revision:

```sh
git tag -a v0.1.0-beta.10 -m "RookCue 0.1.0-beta.10"
git push origin v0.1.0-beta.10
```

The Release workflow verifies tag/version/pin, runs tests on Linux x64 and macOS
arm64 with Node 24.12.0, verifies native binaries, packages corresponding source,
tests installation, and publishes only after both builds succeed. It creates a
GitHub prerelease for versions containing a hyphen. No npm publication occurs.
Inspect the successful run, release assets and `SHA256SUMS` before announcing it.
An existing release causes publication to fail rather than overwrite assets.
If a tag run fails before publication, diagnose it; do not silently move the tag.
Source fixes should receive a new release candidate/version.

Shared upgrades switch one skill revision for attached hosts. Existing Codex
plugins need app-managed updates; report this explicitly rather than claiming all
hosts upgraded. Do not mutate real memory roots during release verification.
