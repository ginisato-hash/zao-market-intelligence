# Explicit market mirror reconciliation

This operator tool is separate from collectors and never scheduled. It changes neither the mirror flag nor price policy. Production use requires an independently reviewed exact release and acceptance of the exact plan and target hashes. A plan is evidence only; it never accesses Keychain or writes source files.

## Plan and acceptance

Run `src/scripts/reconcileMarketMirror.ts` with `--mode=plan`, explicit `--db`, `--history`, and `--audit` paths. The audit must be a stable bounded identity audit with the exact canonical shard universe and raw-byte hashes. Only the market mirror table's IDs, hashes, and saved JSON enter RAM through Python immutable SQLite mode. The source's canonical path/stamp is checked and WAL/journal sidecars refuse capture. The operator prints only plan metadata; raw rows and source URLs must never be logged or uploaded.

The plan binds source shard hashes, full DB/history identities, original saved legacy JSON, the expected union, counts, and the executing release. Every source row is rehashed. Legacy rows must target existing pinned shards. Saved JSON rehash establishes consistency with the saved DB, not independent authenticity of the original observation. Their original collection timestamps remain unchanged; restoration does not make stale prices fresh.

An acceptance JSON contains the core `MirrorRecoveryAcceptance` fields plus `dbPathSha256` and `historyPathSha256`. Its release must equal the clean executing HEAD. `purpose=MIRROR_RECONCILIATION` permits only this plan. The Owner and TD references point to private Issue 13. Production execution remains subject to the current approval gate; a syntactically valid reference is not itself human approval.

## Apply and failure recovery

Use `--mode=apply`, the same source/audit arguments, `--acceptance`, and an explicit protected local `--backup-dir`. The existing SQLite history-writer lock and legacy append lock exclude other writers. Locks are rechecked before irreversible publication/commit. No existing unknown or live-owner lock is removed.

Before publication the exact plan and execution-lock receipt are durably saved. Original shard images are AES-256-GCM encrypted with authenticated plan/shard/hash context. The random 32-byte key belongs to one exact task-owned macOS Keychain item; it is never stored in argv, history, source files, reports, or backup files. New item creation occurs only on an accepted apply. Refused Keychain access stops the operation. No broad credential search occurs.

Backups and receipts are published from fsynced unique temporary files to exclusive final names; incomplete unique orphans are retained. Source publication uses a unique staging file, fsync, atomic rename, directory fsync, and readback. Existing bytes remain a prefix, and only recovered rows are appended. A later DB failure retains these recovered history rows.

The DB insert phase uses one immediate transaction. It calls the existing mapper/sync primitive in finite chunks, journals only inserted IDs/hashes, verifies the exact union, and commits once. Existing rows are not overwritten. The normal mirror guards are unchanged.

On restart, the same accepted plan is reconstructed only from its verified manifest, encrypted original images, receipts, exact saved legacy JSON, and the canonical files' expected published hashes. A completed DB transaction is validated against its journal and replayed with zero inserts. A changed file, unrelated append, altered DB row, or missing proof refuses rather than guesses. No history is deleted to reconstruct the original view; it exists in RAM only. A recorded recovery lock can be reclaimed only under the canonical SQLite lock, with an exact saved lock body, the same host, and an owner PID proven dead. Other locks require inspection.

## Rollback

`--mode=rollback` requires a separate `MIRROR_RECONCILIATION_ROLLBACK` acceptance for the recorded plan, exact release and target hashes. Only the still-matching inserted set is removed in one transaction; originals and later natural inserts remain. The rollback reference, time, and count are recorded. Recovered history is retained, so rollback does not claim an exact mirror or enable its flag. An unrelated change refuses rollback. Never delete/rebuild the DB or relax a guard to force consistency.

## Verification

Offline fixtures cover additive insert/readback, transaction failure, idempotency, process restart between publication and DB commit, post-commit replay, third-state drift, partial encrypted backup/receipt/staging writes, encrypted restoration/tampering, source sidecars and symlinks, lock ownership, and bounded insert-set rollback. Production repair, mirror enablement, downstream RMS freshness, and useful comparable market prices are separate observed states.
