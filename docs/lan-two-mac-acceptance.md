# Two-Mac LAN acceptance

Use two physical Macs on the same private LAN. Give each operator the matching
native executable for their Mac, its independently recorded SHA-256 and
the expected version `0.1.0-beta.8`. Both sides use temporary data roots.

## Mac B

Run this once with the delivered script and executable, the assigned private
IPv4 address on B and the expected executable digest. The script uses the tools
included with macOS.

```sh
/bin/bash /absolute/path/to/verify-peer-lan.sh /absolute/path/to/gmem \
  B_PRIVATE_IPV4 B_EXECUTABLE_SHA256
```

AirDrop the revealed `private-invitation.json` file to the intended operator
on Mac A within five minutes. Transfer the file privately and keep its contents
out of messages, transcripts and evidence. B closes pairing once A connects
and pairs. Leave the Terminal running, then give the A operator the nonsecret
`B_SYNC_ADDRESS` value. The sync address is selected separately from the invite
address. The sync listener expires after 30 minutes or when stopped with Ctrl-C.

## Mac A

Run the following in Bash, with A's candidate path and digest filled in.

```bash
umask 077
GMEM_A='/absolute/path/to/gmem'
EXPECTED_A_SHA='expected-executable-sha256'
cli=(/usr/bin/env -u NODE_OPTIONS -u NODE_PATH PATH= "$GMEM_A")
sha() { /usr/bin/shasum -a 256 < "$1" | /usr/bin/awk '{ print $1 }'; }
json() { /usr/bin/plutil -extract "$1" raw -o - "$2"; }
[[ "$GMEM_A" == /* && "$(sha "$GMEM_A")" == "$EXPECTED_A_SHA" &&
   "$("${cli[@]}" --version)" == 0.1.0-beta.8 ]]
```

Continue only after that comparison succeeds. Record A's version, digest,
architecture and assigned private LAN IPv4. Move the received invitation into
the temporary directory, restrict its permissions, and pair.

```bash
A_ROOT=$(/usr/bin/mktemp -d /private/tmp/gmem-peer-lan-a.XXXXXXXX)
A_RECEIVED='/absolute/path/to/received/private-invitation.json'
A_INVITE="$A_ROOT/private-invitation.json"
roots=(--project "$A_ROOT/project" --personal "$A_ROOT/personal" --json)
peer() { "${cli[@]}" peer "$@" "${roots[@]}"; }
"${cli[@]}" init "${roots[@]}" > "$A_ROOT/init.json"
/bin/mv "$A_RECEIVED" "$A_INVITE"
/bin/chmod 600 "$A_INVITE"
peer pair --invite-file "$A_INVITE" > "$A_ROOT/paired.json" && /bin/rm -f "$A_INVITE"
B_PEER=$(json data.peerId "$A_ROOT/paired.json")
A_PEER=$(json data.localPeerId "$A_ROOT/paired.json")
```

Check that the paired identities differ and that `A_PEER` matches B's
`B_TRUSTED_A_PEER`. Use the actual `B_SYNC_ADDRESS` from B to set up the target.

```bash
B_ADDRESS='B_SYNC_ADDRESS from Mac B'
target=(--peer "$B_PEER" --address "$B_ADDRESS")
sync() { peer sync "${target[@]}" "$@"; }
P="$A_ROOT/personal/practice"
/bin/mkdir -p "$P"
```

1. **Seed and no-op.** Create the left fixture, preview one operation in each
   direction, and confirm the right fixture only appears after apply. Check
   the bytes on A and the corresponding `B_SEED_*_SHA256` on B. Preview again
   and require empty local and remote operation arrays and no conflicts. Allow
   B a second to record the committed seed before beginning the next phase.

   ```bash
   printf 'initial left\n' > "$P/lan-left.md"
   sync --dry-run > "$A_ROOT/seed-plan.json"
   [[ ! -e "$P/lan-right.md" ]]
   sync --apply > "$A_ROOT/seed.json"
   printf 'initial right\n' | /usr/bin/cmp -s "$P/lan-right.md" -
   sync --dry-run > "$A_ROOT/seed-noop.json"
   /bin/sleep 1
   ```

2. **Increment.** Change A's left fixture and send the phase file. B then edits
   its right fixture. Preview again until the right fixture update appears in
   `data.localOperations`, apply it, and compare the fixture bytes and hashes.
   B's `B_INCREMENT_*_SHA256` records the resulting pair of bytes on B.

   ```bash
   printf 'increment left\n' > "$P/lan-left.md"
   printf 'increment\n' > "$P/lan-phase.md"
   sync --apply > "$A_ROOT/increment-push.json"
   sync --dry-run > "$A_ROOT/increment-plan.json"
   sync --apply > "$A_ROOT/increment-pull.json"
   printf 'increment right\n' | /usr/bin/cmp -s "$P/lan-right.md" -
   ```

3. **Conflict.** Send the phase while left still contains `increment left`,
   then edit the same path on A. Repeat `conflict list` until it reports an
   edit/edit conflict at the left fixture. A plain apply must fail with
   `P2P_SYNC_CONFLICT`. Resolve in favor of B, apply, and compare the left bytes
   against `B_CONFLICT_LEFT_SHA256`.

   ```bash
   printf 'conflict\n' > "$P/lan-phase.md"
   sync --apply > "$A_ROOT/conflict-trigger.json"
   printf 'local conflict\n' > "$P/lan-left.md"
   peer conflict list "${target[@]}" > "$A_ROOT/conflicts.json"
   if sync --apply > "$A_ROOT/blocked.json"; then printf 'Unexpected successful apply\n' >&2; fi
   json error.code "$A_ROOT/blocked.json"
   peer conflict resolve "${target[@]}" --path practice/lan-left.md --strategy remote > "$A_ROOT/resolution.json"
   sync --apply > "$A_ROOT/resolved.json"
   printf 'remote conflict\n' | /usr/bin/cmp -s "$P/lan-left.md" -
   ```

4. **Delete and prepare recovery.** Delete the left fixture on A and send the
   retry phase. B reports `B_DELETION` after observing the committed deletion
   and creates 48 distinct retry fixtures. Repeat the preview until there are
   48 local operations, all for the named retry fixtures. Keep the listener
   running and continue to interruption without applying the preview.

   ```bash
   /bin/rm "$P/lan-left.md"
   printf 'retry\n' > "$P/lan-phase.md"
   sync --apply > "$A_ROOT/deleted.json"
   sync --dry-run > "$A_ROOT/retry-plan.json"
   json data.localOperations "$A_ROOT/retry-plan.json"
   ```

## Interruption and convergence

Start a real apply on A. As soon as its durable pending pointer appears,
suspend the candidate process, capture the pointer, then kill that process.
Use a fresh session with no pending pointer when starting this block.

```bash
pending="$A_ROOT/personal/.p2p/peers/$B_PEER/pending.json"
[[ ! -e "$pending" ]]
"${cli[@]}" peer sync "${roots[@]}" "${target[@]}" --apply > "$A_ROOT/interrupted.json" 2>&1 &
pid=$!
deadline=$((SECONDS + 90))
observed=
while kill -0 "$pid" 2>/dev/null && (( SECONDS < deadline )); do
  if [[ -s "$pending" ]] && kill -STOP "$pid" 2>/dev/null; then
    if [[ -s "$pending" ]] && /bin/cp "$pending" "$A_ROOT/interrupted-pending.json"; then
      kill -KILL "$pid"
      observed=yes
    else
      kill -CONT "$pid" 2>/dev/null || true
    fi
    break
  fi
  /bin/sleep 0.01
done
if [[ "$observed" != yes ]]; then kill -TERM "$pid" 2>/dev/null || true; fi
status=0
wait "$pid" || status=$?
printf 'A_INTERRUPTION_EXIT=%s\n' "$status"
[[ "$observed" == yes && "$status" == 137 && -s "$pending" ]]
```

Require the final assertion to pass. Record the captured session ID, then
resume that session and collect endpoint status and the final preview.

```bash
json sessionId "$A_ROOT/interrupted-pending.json"
peer session resume "${target[@]}" > "$A_ROOT/resumed.json"
peer session status "${target[@]}" > "$A_ROOT/converged.json"
sync --dry-run > "$A_ROOT/final-noop.json"
sha "$P/lan-retry-48.md"
```

Confirm the resumed session ID is the captured ID and that both receipts are
`committed` with the same session ID and plan digest. The local and remote
baselines in `converged.json` must agree on generation, digest and last session
ID, with both pending fields null. Verify both snapshots contain the 48 retry
fixtures with matching SHA-256 values and omit the deleted left fixture. Check
the last fixture's hash against `B_RETRY_48_SHA256` and require an empty final
preview.

Stop Mac B with Ctrl-C after these checks. Keep the sanitized gate evidence
separate from both retained private temporary directories. Record the observed
version and executable SHA-256 on each Mac, the LAN addresses, checks performed,
interruption exit status and matching session and baseline evidence.
