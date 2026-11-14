# First-use runtime setup

## Install once for local agents

For installation across local agents, resolve `SKILL_DIR` to the complete skill
folder from the downloaded repository or installed plugin. Inspect with
`bash "$SKILL_DIR/scripts/rookcue.sh" agents`. Explain the detected host connections
and runtime downloads together. An existing installation request covering this
scope is sufficient authorization; proceed without repeating the question.

```bash
bash "$SKILL_DIR/scripts/rookcue.sh" install --approve-install
```

This prepares one runtime and connects detected Codex, Grok and Claude Code hosts
on macOS/Linux. Optional `--agents codex,grok,claude` selects hosts explicitly.
The shared skill contains scripts and references and survives deletion of the
source checkout. A custom `ROOKCUE_RUNTIME_HOME` is recorded in the shared copy.
`install` also accepts setup's `--archive` and `--offline` options.

Use `connect` to attach a newly installed host; it needs Node >=22.12 or the
private Node prepared by `install`. Use `install` from a new skill release to
upgrade the runtime and publish the shared skill together. Connected hosts load
the new revision in a new session.
When using fresh source for an existing shared installation, read its installed
`scripts/runtime-home` and supply that value as `ROOKCUE_RUNTIME_HOME` to the new
launcher. This preserves custom locations during upgrades and host connections.

```bash
bash "$SKILL_DIR/scripts/rookcue.sh" connect
bash "$SKILL_DIR/scripts/rookcue.sh" agents
```

Inspect `ok` and each `data.agents` entry. `connected` confirms filesystem wiring;
invoke `growth-memory` in a new host session to verify loading. `plugin-managed`
means Codex already has an enabled RookCue plugin with its own update lifecycle.
To migrate fully, disable that plugin in Codex and rerun `connect --agents codex`.
`conflict` preserves an existing entry and reports its path for reconciliation.
Other hosts may already be connected when the result is `needs-attention`.
After a killed installer, inspect `agents.lock/owner.json` and its PID before
removing a stale lock. Normal errors release the lock.

Use the same personal root across hosts. When switching agents within a task,
read the same project's context/checkpoint and reuse its task ID. Independent work
in the same project must resolve the active-task choice first. Separate worktrees
have separate project records and can share the personal root. Cloud sandboxes
and other computers require their own runtime and data access or synchronization.

## Prepare the runtime for an existing skill

The plugin includes its launcher and installer. It works from a copied plugin;
the source checkout and global `npm link` are not required. Its runtime pin is
in `../scripts/runtime.json`. Plugin identity `growth-memory` is retained for
existing installations; its display name is RookCue.

1. Resolve `SKILL_DIR` from the host-provided SKILL.md path, then run:

   ```bash
   bash "$SKILL_DIR/scripts/rookcue.sh" check
   ```

   `check` creates no directories and makes no network requests. It looks for a
   compatible `rookcue`, `gmem`, then `growth-memory`, or its private installation.
   Runtime beta.8 is currently accepted; incompatible versions are preserved.

2. If `data.status` is `ready`, use the launcher directly. If `setup-required`,
   explain the installation and ask once, unless this exact installation was
   already authorized:

   > RookCue 需要准备本地运行环境。我会从 GitHub 下载固定版本的源码并校验摘要，
   > 用 npm 安装依赖和构建，存到 `~/.local/share/rookcue`。
   > 若缺少可用的 Node/npm，会从 nodejs.org 下载并校验独立的 Node 24.12.0。
   > 不修改全局命令或上传任务内容。是否继续？

   Use the actual `ROOKCUE_RUNTIME_HOME` location if customized. Installing the
   plugin or asking to record a task is not itself consent to these downloads.
   After approval, the agent runs:

   ```bash
   bash "$SKILL_DIR/scripts/rookcue.sh" setup --approve-install
   bash "$SKILL_DIR/scripts/rookcue.sh" check
   bash "$SKILL_DIR/scripts/rookcue.sh" run -- --version
   ```

3. Continue the original intent after verifying `ready`. Installation alone does
   not initialize memory roots. For a lookup, search directly. For recording,
   inspect context/status, then initialize only under recording authorization.

## Prerequisites and recovery

- Source runtime needs Node >=22.12.0 and npm. Private Node bootstrap supports
  macOS arm64 and Linux x64, using Bash, curl, tar and shasum/sha256sum. With
  compatible Node/npm already installed, the launcher can use them directly.
- Node, source and npm dependency downloads are installation traffic. Knowledge
  stays local. Source and Node digests are pinned; npm uses package-lock integrity.
  Dependency lifecycle scripts are disabled; the pinned TypeScript build runs.
- No sudo, global npm linking, shell-profile edits or global security changes.
  Existing aliases, runtime directories and memory data are preserved.
- `setup --approve-install --archive /absolute/source.tar.gz --offline` supports
  the exact pinned source archive and a populated npm cache, with existing Node/npm.
  The archive must match the bundled digest; no alternate URLs or arbitrary refs.
- Failure leaves no ready partial source runtime. Retry the same setup after a
  network error. Locks prevent concurrent installs; never remove a live lock.
  Normal cancellation cleans source staging and releases its lock. If the process
  was forcibly killed, inspect `install.lock/owner.json` and whether that PID is still alive before
  proposing removal of that stale lock. A damaged existing install is preserved;
  use a separate explicit `ROOKCUE_RUNTIME_HOME` for repair after explaining it.
- Shell/bootstrap errors, setup JSON errors, and nonzero command exits are failures.
  Do not claim success because a directory exists. Report an actual blocked
  prerequisite plainly; handle supported setup yourself after authorization.
