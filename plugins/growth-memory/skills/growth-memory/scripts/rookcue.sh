#!/bin/bash
# Interpreter entry point: package installers may strip executable bits.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_home=${ROOKCUE_RUNTIME_HOME:-"$HOME/.local/share/rookcue"}
node_dir="$runtime_home/node-v24.12.0"
action=${1:-}
error() { printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$1" "$2"; exit 1; }

validate_setup() {
  shift
  approved=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --approve-install) approved=true ;;
      --offline) ;;
      --archive) shift; [ "$#" -gt 0 ] && [ -n "$1" ] || error INVALID_ARGUMENT 'Missing archive path.' ;;
      *) error INVALID_ARGUMENT 'Use setup with --approve-install and optional --archive PATH or --offline.' ;;
    esac
    shift
  done
  $approved || error INSTALL_APPROVAL_REQUIRED 'Explain the downloads and install location and obtain user consent before setup.'
}
case "$action" in
  check) [ "$#" -eq 1 ] || error INVALID_ARGUMENT 'check takes no arguments.' ;;
  setup) validate_setup "$@" ;;
  run) [ "$#" -ge 3 ] && [ "$2" = -- ] || error INVALID_ARGUMENT 'Use run -- followed by CLI arguments.' ;;
  *) error INVALID_ARGUMENT 'Expected check, setup, or run.' ;;
esac

node_bin=$(command -v node || true)
usable_node() { [ -n "$1" ] && "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' >/dev/null 2>&1; }
if ! usable_node "$node_bin"; then node_bin="$node_dir/bin/node"; fi

# A self-contained native CLI can work even when no JavaScript runtime exists.
if ! usable_node "$node_bin"; then
  for name in rookcue gmem growth-memory; do
    candidate=$(command -v "$name" || true)
    case "$candidate" in /*) ;; *) continue ;; esac
    version=$("$candidate" --version 2>/dev/null) || continue
    [ "$version" = 0.1.0-beta.8 ] || continue
    help=$("$candidate" --help 2>/dev/null) || continue
    compatible=true
    for word in task knowledge review context; do
      case "$help" in *"$word"*) ;; *) compatible=false ;; esac
    done
    $compatible || continue
    case "$action" in
      check) printf '{"ok":true,"data":{"status":"ready","runtime":{"kind":"path","version":"0.1.0-beta.8"}}}\n'; exit 0 ;;
      setup) printf '{"ok":true,"data":{"status":"ready","reused":true,"runtime":{"kind":"path","version":"0.1.0-beta.8"}}}\n'; exit 0 ;;
      run) shift 2; exec "$candidate" "$@" ;;
    esac
  done
fi

# A compatible CLI needs no npm. Discover it before preparing a build toolchain.
if [ "$action" = setup ] && usable_node "$node_bin"; then
  existing=$("$node_bin" "$script_dir/runtime.mjs" check)
  if printf '%s' "$existing" | "$node_bin" -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.exit(JSON.parse(s).data?.status==="ready"?0:1))'; then
    exec "$node_bin" "$script_dir/runtime.mjs" "$@"
  fi
fi

# A working CLI needs Node only; source installation also needs npm.
need_node=false
usable_node "$node_bin" || need_node=true
if [ "$action" = setup ] && ! command -v npm >/dev/null 2>&1 && [ ! -f "$node_dir/bin/npm" ]; then need_node=true; fi
if $need_node; then
  if [ "$action" = check ]; then
    printf '{"ok":true,"data":{"status":"setup-required","prerequisite":"Node >=22.12.0 with npm","privateNodeVersion":"24.12.0"}}\n'
    exit 0
  fi
  [ "$action" = setup ] || error RUNTIME_MISSING 'Node is unavailable. Request installation consent before setup.'
  for arg in "$@"; do [ "$arg" != --offline ] || error NODE_MISSING 'Offline setup requires a preinstalled compatible Node and npm.'; done
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64; digest=319f221adc5e44ff0ed57e8a441b2284f02b8dc6fc87b8eb92a6a93643fd8080 ;;
    Linux-x86_64) platform=linux-x64; digest=6159227e0af7d7c3c6bb2fa900452b04a6cb8841a702a79acc613209d70b04d0 ;;
    *) error UNSUPPORTED_NODE_PLATFORM 'Private Node bootstrap supports macOS arm64 and Linux x64. Use an existing Node >=22.12 with npm on other platforms.' ;;
  esac
  command -v curl >/dev/null || error PREREQUISITE_MISSING 'curl is required for private Node setup.'
  command -v tar >/dev/null || error PREREQUISITE_MISSING 'tar is required for private Node setup.'
  mkdir -p "$runtime_home"
  mkdir "$runtime_home/node-install.lock" 2>/dev/null || error INSTALL_BUSY 'Another Node installation owns node-install.lock. Wait for it.'
  stage=''
  download_pid=''
  cleanup() {
    if [ -n "$download_pid" ]; then kill "$download_pid" 2>/dev/null || true; wait "$download_pid" 2>/dev/null || true; fi
    [ -z "$stage" ] || rm -rf "$stage"
    rm -f "$runtime_home/node-install.lock/owner.json"
    rmdir "$runtime_home/node-install.lock"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '{"pid":%s}\n' "$$" > "$runtime_home/node-install.lock/owner.json"
  [ ! -e "$node_dir" ] || error NODE_INSTALL_DAMAGED 'A private Node directory already exists but is unusable. Preserve it and select a separate ROOKCUE_RUNTIME_HOME.'
  stage=$(mktemp -d "$runtime_home/node-stage-XXXXXX")
  curl -fsSL --connect-timeout 15 --max-time 180 "https://nodejs.org/dist/v24.12.0/node-v24.12.0-$platform.tar.gz" -o "$stage/node.tar.gz" &
  download_pid=$!
  wait "$download_pid" || error NODE_DOWNLOAD_FAILED 'Could not download the pinned Node archive. Retry after connectivity is restored.'
  download_pid=''
  if command -v shasum >/dev/null; then actual=$(shasum -a 256 "$stage/node.tar.gz");
  elif command -v sha256sum >/dev/null; then actual=$(sha256sum "$stage/node.tar.gz");
  else error PREREQUISITE_MISSING 'shasum or sha256sum is required to verify Node.'; fi
  [ "${actual%% *}" = "$digest" ] || error CHECKSUM_MISMATCH 'Node archive checksum mismatch. Nothing was installed.'
  mkdir "$stage/node"
  tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/node"
  usable_node "$stage/node/bin/node" || error NODE_VERIFY_FAILED 'The downloaded Node executable could not run on this machine.'
  mv "$stage/node" "$node_dir"
  node_bin="$node_dir/bin/node"
  cleanup
  trap - EXIT INT TERM
fi
if [ -x "$node_dir/bin/node" ]; then
  # Prefer a complete private toolchain for setup when the system only has Node.
  if [ "$action" = setup ] && ! command -v npm >/dev/null 2>&1; then node_bin="$node_dir/bin/node"; fi
fi
export PATH="$(dirname "$node_bin"):$PATH"
exec "$node_bin" "$script_dir/runtime.mjs" "$@"
