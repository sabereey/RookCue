#!/bin/bash
set -euo pipefail
umask 077

usage() {
  printf 'Usage: bash %s /absolute/path/to/gmem B_PRIVATE_IPV4 EXPECTED_SHA256\n' "${0##*/}"
}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ $# -eq 1 && "$1" == --help ]]; then
  usage
  exit 0
fi
if [[ $# -ne 3 ]]; then
  usage >&2
  exit 2
fi

candidate=$1
bind=$2
expected_sha=$3
[[ "$(/usr/bin/uname -s)" == Darwin ]] || fail 'Run this helper on Mac B.'
[[ "$candidate" == /* && -f "$candidate" && -x "$candidate" ]] || fail 'Supply an absolute path to the executable candidate.'
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || fail 'Supply the trusted lowercase SHA-256 for the candidate.'
if [[ ! "$bind" =~ ^(10\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])|192\.168)\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  fail 'Supply an assigned private LAN IPv4 on Mac B.'
fi
/sbin/ifconfig | /usr/bin/awk -v bind="$bind" '$1 == "inet" && $2 == bind { found = 1 } END { exit !found }' ||
  fail 'The requested IPv4 is not assigned on Mac B.'

sha256() {
  /usr/bin/shasum -a 256 < "$1" | /usr/bin/awk '{ print $1 }'
}

actual_sha=$(sha256 "$candidate")
[[ "$actual_sha" == "$expected_sha" ]] || fail "Candidate SHA-256 mismatch. Observed $actual_sha"
runner=(/usr/bin/env -u NODE_OPTIONS -u NODE_PATH PATH= "$candidate")
version=$("${runner[@]}" --version)
[[ "$version" == 0.1.0-beta.8 ]] || fail 'Expected the 0.1.0-beta.8 native candidate.'
printf 'B_VERSION=%s\nB_EXECUTABLE_SHA256=%s\nB_ARCH=%s\n' "$version" "$actual_sha" "$(/usr/bin/uname -m)"

root=$(/usr/bin/mktemp -d /private/tmp/gmem-peer-lan-b.XXXXXXXX)
invite=$root/private-invitation.json
practice=$root/personal/practice
left=$practice/lan-left.md
right=$practice/lan-right.md
phase=$practice/lan-phase.md
roots=(--project "$root/project" --personal "$root/personal" --json)
listener_pid=

stop_listener() {
  if [[ -n "$listener_pid" ]]; then
    kill -TERM "$listener_pid" 2>/dev/null || true
    local deadline=$((SECONDS + 5))
    while kill -0 "$listener_pid" 2>/dev/null && (( SECONDS < deadline )); do /bin/sleep 0.2; done
    kill -KILL "$listener_pid" 2>/dev/null || true
    wait "$listener_pid" 2>/dev/null || true
    listener_pid=
  fi
}

cleanup() {
  stop_listener
  /bin/rm -f "$invite"
  printf 'B_EVIDENCE_DIR=%s\n' "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

json_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$2" 2>/dev/null
}

start_listener() {
  local mode=$1 timeout=$2 ready=$root/$1.ready.json address deadline=$((SECONDS + 15))
  shift 2
  "${runner[@]}" peer "$mode" "${roots[@]}" --bind "$bind" --port 0 --timeout "$timeout" \
    --ready-file "$ready" "$@" > "$root/$mode.log" 2>&1 &
  listener_pid=$!
  listener_deadline=$((SECONDS + timeout / 1000 + 10))
  while kill -0 "$listener_pid" 2>/dev/null && (( SECONDS < deadline )); do
    if address=$(json_value data.address "$ready") && [[ "$address" == "$bind":* ]]; then
      listener_address=$address
      return
    fi
    /bin/sleep 0.2
  done
  fail "Mac B $mode listener did not become ready. See the private $mode.log."
}

fixture_is() {
  [[ -f "$1" ]] && printf '%s\n' "$2" | /usr/bin/cmp -s "$1" -
}

write_fixture() {
  printf '%s\n' "$2" > "$root/fixture.tmp"
  /bin/mv -f "$root/fixture.tmp" "$1"
}

check_listener() {
  kill -0 "$listener_pid" 2>/dev/null || fail 'The Mac B listener ended before the next fixture phase.'
  (( SECONDS < listener_deadline )) || fail 'The Mac B listener exceeded its deadline.'
}

wait_for() {
  until "$@"; do
    check_listener
    /bin/sleep 0.25
  done
}

"${runner[@]}" init "${roots[@]}" > "$root/init.log" 2>&1 || fail 'Mac B candidate init failed. See the private init.log.'
/bin/mkdir -p "$practice"
write_fixture "$right" 'initial right'
start_listener invite 300000 --out "$invite"
[[ "$(/usr/bin/stat -f %Lp "$invite")" == 600 ]] || fail 'The invitation is missing or has unexpected permissions.'
printf 'B_INVITE_ADDRESS=%s\n' "$listener_address"
printf 'AirDrop only this invitation file to Mac A within five minutes. Finder will reveal it.\n%s\n' "$invite"
/usr/bin/open -R "$invite" > "$root/finder.log" 2>&1 || true

paired() {
  "${runner[@]}" peer list "${roots[@]}" > "$root/peer-list.json" 2> "$root/peer-list.stderr" ||
    fail 'Mac B could not read the local peer list.'
  peer_a=$(json_value data.peers.0.peerId "$root/peer-list.json") && [[ "$peer_a" =~ ^[a-z2-7]{52}$ ]]
}
wait_for paired
# Trust is persisted before B sends the reply. Wait for A to receive it and close the pairing socket.
while /usr/sbin/lsof -bnP -a -p "$listener_pid" -iTCP -sTCP:ESTABLISHED >/dev/null 2>&1; do
  check_listener
  /bin/sleep 0.2
done
stop_listener
/bin/rm -f "$invite"
printf 'B_TRUSTED_A_PEER=%s\n' "$peer_a"

peer_state=$root/personal/.p2p/peers/$peer_a
start_listener serve 1800000 --allow-apply
printf 'B_SYNC_ADDRESS=%s\n' "$listener_address"
printf 'Mac B is ready for sync for 30 minutes. Leave this Terminal running.\n'

seeded() {
  fixture_is "$left" 'initial left' && fixture_is "$right" 'initial right' && [[ ! -e "$peer_state/pending.json" ]]
}
wait_for seeded
printf 'B_SEED_LEFT_SHA256=%s\nB_SEED_RIGHT_SHA256=%s\n' "$(sha256 "$left")" "$(sha256 "$right")"

increment_requested() {
  fixture_is "$phase" increment && fixture_is "$left" 'increment left' && [[ ! -e "$peer_state/pending.json" ]]
}
wait_for increment_requested
write_fixture "$right" 'increment right'
printf 'B_INCREMENT_LEFT_SHA256=%s\nB_INCREMENT_RIGHT_SHA256=%s\n' "$(sha256 "$left")" "$(sha256 "$right")"

conflict_requested() {
  fixture_is "$phase" conflict && fixture_is "$left" 'increment left' && [[ ! -e "$peer_state/pending.json" ]]
}
wait_for conflict_requested
write_fixture "$left" 'remote conflict'
printf 'B_CONFLICT_LEFT_SHA256=%s\n' "$(sha256 "$left")"

retry_requested() {
  fixture_is "$phase" retry && [[ ! -e "$left" && ! -e "$peer_state/pending.json" ]]
}
wait_for retry_requested
printf 'B_DELETION=practice/lan-left.md absent\n'
/usr/bin/awk 'BEGIN { for (n=0; n<8192; n++) print "LAN retry payload" }' > "$root/retry.txt"
for index in {1..48}; do
  printf -v padded '%02d' "$index"
  { printf 'fixture %s\n' "$padded"; /bin/cat "$root/retry.txt"; } > "$root/fixture.tmp"
  /bin/mv -f "$root/fixture.tmp" "$practice/lan-retry-$padded.md"
done
printf 'B_RETRY_FIXTURES=48\nB_RETRY_48_SHA256=%s\n' "$(sha256 "$practice/lan-retry-48.md")"
while kill -0 "$listener_pid" 2>/dev/null; do
  (( SECONDS < listener_deadline )) || fail 'The Mac B listener exceeded its deadline.'
  /bin/sleep 1
done
wait "$listener_pid"
listener_pid=
printf 'Mac B listener stopped.\n'
