# RookCue Codex Plugin

Use conversation to record work, recover progress, find prior experience and
review useful lessons. The agent runs the underlying commands.

## Install once

In Codex, ask the agent:

> 帮我从 https://github.com/sabereey/RookCue 安装 RookCue 插件。

The agent can use the source marketplace with the Codex CLI:

```bash
codex plugin marketplace add sabereey/RookCue
codex plugin add growth-memory@growth-memory-local
```

For a local development checkout, use the repository root instead:

```bash
codex plugin marketplace add "$PWD"
codex plugin add growth-memory@growth-memory-local
```

The marketplace name and plugin ID are retained for compatibility. The displayed
name is RookCue. Source installation is available; this is not a public directory
listing. The plugin source includes its scripts and references. It does not need
the original checkout after installation.

Start a new Codex conversation after installing or updating so it loads the new
Skill. Avoid enabling an old private-beta copy and this copy simultaneously.

## First conversation

Say “用 RookCue 记录这次任务”. The agent checks for a compatible local runtime.
If it is missing, it explains the downloads and installation directory and asks
for consent. After confirmation, it prepares a private runtime and continues.
You do not need to run CLI commands or `npm link`.

The installer reuses `rookcue`, `gmem` or `growth-memory` beta.8 if available.
Otherwise it verifies a pinned GitHub source archive, installs locked dependencies
and builds it under `~/.local/share/rookcue`. On macOS arm64 and Linux x64 it can
also prepare a checksum-verified Node 24.12.0 when Node/npm are absent. Other
platforms need a working Node >=22.12.0 with npm. Bash, tar and (for Node download)
curl plus shasum/sha256sum are prerequisites. No global link, sudo or shell-profile
change is required. Existing data and binaries are preserved.

The installer downloads software; it does not upload task content. Runtime pin
and archive digest are inspectable in [runtime.json](skills/growth-memory/scripts/runtime.json).
An older or incompatible PATH command is preserved; the plugin uses its own
compatible runtime. Standalone CLI users can still use the root installation guide.

## Natural-language use

| Request | Behavior |
| --- | --- |
| 用 RookCue 记录这次任务 | Explain scope and record this task; no per-command confirmations |
| 继续上次任务 | Read context/checkpoint; ask if the intended task is ambiguous |
| 找找以前有没有类似问题 | Search existing knowledge; show source and applicability |
| 复盘一下，把这个经验记下来 | Guide review, then show exact candidate for approval |

An explicit recording request authorizes that task. Inferred recording suggestions
need confirmation; ordinary coding does not automatically enable it. Installation
and knowledge promotion have separate consent scopes. The host matches intent
against the Skill description; keywords are not a guaranteed trigger. Select
RookCue explicitly if needed (the Skill's compatibility name is `growth-memory`).

## Development verification

```bash
npm test -- tests/plugin
```

Read the [Skill](skills/growth-memory/SKILL.md) and its [setup reference](skills/growth-memory/references/setup.md)
for exact commands, error handling and approval rules. Plugin updates do not
rewrite existing memory. Keep the runtime pin and supported version checks aligned
when changing runtime behavior.

## License

GPL-3.0-only under the repository-root [LICENSE](../../LICENSE).
