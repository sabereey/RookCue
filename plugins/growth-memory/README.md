# RookCue for local agents

English | [简体中文](README_CN.md)

Use conversation to record work, recover progress, find prior experience and
review useful lessons. The agent runs the underlying commands.

## Shared installation

Ask your local coding agent:

> Install RookCue from https://github.com/sabereey/RookCue for the Codex, Grok and Claude Code agents already on this computer, using one shared personal knowledge library.

Agents can start with the repository's [installation entry point](../../llms.txt).

The agent obtains the complete skill directory, inspects local hosts and prepares
one shared installation. From a repository checkout, the entry point is:

```bash
bash plugins/growth-memory/skills/growth-memory/scripts/rookcue.sh install --approve-install
```

Auto-detection uses host configuration directories or executables on PATH.
`--agents codex,grok,claude` selects hosts explicitly. One shared skill copy lives
under `~/.local/share/rookcue/skills/`; host entries link to its current revision.
Codex uses `~/.agents/skills/growth-memory`, Grok uses
`~/.grok/skills/growth-memory` (including older versions), and Claude Code uses
`~/.claude/skills/growth-memory`. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected
for host configuration discovery. Use the same personal root across hosts,
normally `~/.growth-memory`, and the same project directory to continue a task.

The installer supports macOS/Linux and reuses the runtime setup described below.
Ask your agent to add another host, inspect installation or update RookCue.
`connect` handles local wiring; `agents` is read-only. Run `install` from a new
release to update. Revisions are published atomically; start a new host session
to load the updated skill. Old revisions remain available on disk.

For an installation with a custom runtime root, read `scripts/runtime-home` from
the currently installed shared skill and pass that value as `ROOKCUE_RUNTIME_HOME`
when running the new release's installer. A fresh source package uses the default
location unless this environment variable is supplied. Keep the same root when
updating or connecting another host from fresh source.

User-owned skills are preserved and reported with their paths. Enabled Codex
plugins are `plugin-managed` and updated through Codex. To migrate fully, disable
the old RookCue plugin and rerun `connect --agents codex`. Filesystem tests cover
these paths; actual skill loading and workflow execution need host acceptance.
Other local agents require an adapter. Cloud environments and other computers
need their own installation and data access.

## Codex plugin installation

In Codex, ask the agent:

> Install the RookCue plugin from https://github.com/sabereey/RookCue.

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

Say “Record this task with RookCue.” The agent checks for a compatible local runtime.
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
| Record this task with RookCue | Explain scope and record this task under the task authorization |
| Continue my previous task | Read context/checkpoint and clarify which task when needed |
| Find relevant experience | Search existing knowledge and show source and applicability |
| Review this task and save useful lessons | Guide review, then show the exact candidate for approval |

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
