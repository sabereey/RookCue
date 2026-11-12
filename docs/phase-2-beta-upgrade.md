# Upgrade Phase 2 data

Build the current version and use it on every device that writes to the same
personal knowledge store. Use `gmem growth --help` to confirm support before
upgrading a legacy capability record.

1. Preserve the previous executable and take a complete backup of both project
   `.growth-memory` and personal knowledge roots. Keep credentials and backups
   private. Pause old devices that write the same personal store.
2. Follow the [source install guide](../README.md#install). Check `gmem --version`
   and `gmem growth --help` before replacing the previous installation.
3. Install the matching Codex plugin and start a fresh chat. Check the runtime
   on each writing device before enabling capability changes.
4. Read `growth history`, `quality`, `due` and `report` with explicit `--project`
   and `--personal` roots. Legacy capability v1 reads preserve the original file
   bytes. Its current level is a baseline with unknown earlier history/content;
   it is not evidence of improvement or mastery.
5. Only after an actual human assessment, an explicit `capability update` writes
   v2 current state and history atomically. Retain the same `--operation` ID and
   exact arguments for retries; replay does not append a second history event.
   `--rationale` records the human assessment context, and `--evidence` must refer
   to appropriate existing review/task evidence. No automatic assessment occurs.
6. Export with `personal export`, then `personal verify` the generated bundle.
   Capability history is included, as are the portable minimal growth records.
   Generated reports/caches and private credentials are excluded.

Once any capability mutation writes v2, old writers cannot safely use that
personal store. Do not remove fields or rewrite its version to simulate a
downgrade. To return to an old runtime, restore the entire prior backup to a
separate root and preserve the v2 data separately; post-backup changes will not
be present in that restored copy.

Human review, promotion approval and voluntary recall feedback retain their
existing gates. Capture history only after actual task closure and completed
human review. Automated acceptance uses disposable synthetic fixtures; it does
not count as genuine one-to-two-week usage or user feedback.
