# Changelog

English | [简体中文](CHANGELOG_CN.md)

## 0.1.0-beta.10

- Cross-agent checkpoint saves can require the version the agent read. If another
  agent has saved newer progress or closed the task, the guarded save is rejected.
- The shared skill uses guarded saves and explains how to reload and reconcile progress.
- The beta.9 upgrade check verifies existing task and knowledge data, shared
  skill connections, and recovery from a checkpoint conflict.

See [beta.10 release notes](docs/releases/0.1.0-beta.10.md) for downloads and upgrade details.

## 0.1.0-beta.9

- Shared installation for Grok, Claude Code and eligible Codex installations.
- Structured task handoffs with per-step attribution, artifacts, constraints,
  current scope and explicit pending acceptance. Legacy checkpoints remain readable.
- English/Chinese onboarding and release documentation.
- Unified version updates, runtime source pins, CI and tag-triggered releases.
- Fresh-install and beta.8 upgrade checks preserve project/personal data.
- Updated Zod to 4.6.7 to include its constrained-collection validation security fix.

See [release notes](docs/releases/0.1.0-beta.9.md) for assets and upgrade details.
Earlier beta work predates the automated release workflow; beta.9 does not imply
that earlier version strings had corresponding immutable GitHub Releases.
