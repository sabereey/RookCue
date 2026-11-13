# First-use runtime setup

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
