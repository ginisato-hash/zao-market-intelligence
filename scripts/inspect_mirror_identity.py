"""One-pass, bounded, read-only CSV/DB identity audit. No rows, URLs or paths in output.

This proves row_id/row_hash relationships, not full quote semantics or repair authority.
No production runner, schema mutation, synchronization or credential code is imported.
"""
import argparse
import csv
import hashlib
import io
import json
import re
import sqlite3
import sys
from pathlib import Path


class AuditError(ValueError):
    pass


def stamp(path):
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns


class HashingReader(io.RawIOBase):
    def __init__(self, raw, digest, budget):
        self.raw, self.digest, self.budget = raw, digest, budget

    def readable(self):
        return True

    def readinto(self, buffer):
        n = self.raw.readinto(buffer)
        if n:
            self.budget[0] -= n
            if self.budget[0] < 0:
                raise AuditError("HISTORY_BYTE_BUDGET_EXCEEDED")
            self.digest.update(memoryview(buffer)[:n])
        return n


def identity_digest(pairs):
    digest = hashlib.sha256()
    for key, value in sorted(pairs.items()):
        digest.update(key.encode())
        digest.update(b"\0")
        digest.update(value.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def shard_files(directory, max_shards):
    files = []
    for p in directory.iterdir():
        if re.fullmatch(r"zao_signals_\d{4}_\d{2}\.csv", p.name) and p.is_file():
            files.append(p)
            if len(files) > max_shards:
                raise AuditError("HISTORY_SHARD_BUDGET_EXCEEDED")
    return sorted(files)


def inspect(history_dir, db_path, max_rows=200_000, max_shards=240, max_bytes=256 * 1024 * 1024):
    directory, db = Path(history_dir).resolve(strict=True), Path(db_path).resolve(strict=True)
    if Path(str(db) + "-wal").exists():
        raise AuditError("WAL_PRESENT_USE_REVIEWED_SNAPSHOT_PATH")
    files = shard_files(directory, max_shards)
    if not files:
        raise AuditError("HISTORY_SHARDS_MISSING")
    before = {p.name: stamp(p) for p in files}
    if sum(v[2] for v in before.values()) > max_bytes:
        raise AuditError("HISTORY_BYTE_BUDGET_EXCEEDED")
    byte_budget = [max_bytes]
    db_before = stamp(db)
    connection = sqlite3.connect(db.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        # One bounded pass. CASE prevents oversized/invalid identity values reaching Python.
        valid = "typeof(row_id)='text' AND length(CAST(row_id AS BLOB)) BETWEEN 1 AND 256 AND typeof(row_hash)='text' AND length(CAST(row_hash AS BLOB))=64"
        rows = connection.execute(f"SELECT CASE WHEN {valid} THEN row_id END, CASE WHEN {valid} THEN row_hash END FROM market_signal_history LIMIT ?", (max_rows + 1,))
        db_hashes, db_rows, db_duplicates = {}, 0, 0
        for key, value in rows:
            db_rows += 1
            if db_rows > max_rows:
                raise AuditError("DB_IDENTITY_BUDGET_EXCEEDED")
            if key is None or value is None:
                raise AuditError("DB_IDENTITY_SIZE_OR_TYPE_INVALID")
            if not re.fullmatch(r"[0-9a-f]{64}", value):
                raise AuditError("DB_IDENTITY_HASH_INVALID")
            if key in db_hashes:
                db_duplicates += 1
            db_hashes[key] = value
        schema = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='market_signal_history'").fetchone()[0]
    finally:
        connection.close()
    seen, summaries = {}, []
    count = missing = conflicts = duplicates = duplicate_conflicts = invalid = 0
    for path in files:
        digest, file_rows = hashlib.sha256(), 0
        with path.open("rb", buffering=0) as raw:
            wrapped = io.TextIOWrapper(io.BufferedReader(HashingReader(raw, digest, byte_budget)), encoding="utf-8-sig", newline="")
            reader = csv.DictReader(wrapped)
            if len(reader.fieldnames or []) != len(set(reader.fieldnames or [])):
                raise AuditError("DUPLICATE_CSV_HEADERS")
            if not {"row_id", "row_hash"}.issubset(reader.fieldnames or []):
                raise AuditError("IDENTITY_COLUMNS_MISSING")
            for row in reader:
                if None in row or any(v is None for v in row.values()):
                    raise AuditError("CSV_ROW_WIDTH_INVALID")
                count += 1
                file_rows += 1
                if count > max_rows:
                    raise AuditError("HISTORY_IDENTITY_BUDGET_EXCEEDED")
                key, value = row.get("row_id"), row.get("row_hash")
                if not key or len(key.encode()) > 256 or not value or not re.fullmatch(r"[0-9a-f]{64}", value):
                    invalid += 1
                    continue
                if key in seen:
                    duplicates += 1
                    duplicate_conflicts += int(seen[key] != value)
                    continue
                seen[key] = value
                if key not in db_hashes:
                    missing += 1
                elif db_hashes[key] != value:
                    conflicts += 1
        summaries.append({"shard": path.name, "rows": file_rows, "raw_bytes_sha256": digest.hexdigest()})
    db_only = sum(key not in seen for key in db_hashes)
    stable = (db_before == stamp(db) and not Path(str(db) + "-wal").exists()
              and all(before[p.name] == stamp(p) for p in files)
              and sorted(before) == [p.name for p in shard_files(directory, max_shards)])
    exact = stable and count == len(seen) == db_rows == len(db_hashes) and not any([missing, conflicts, db_only, invalid, db_duplicates])
    return {"kind": "ZMI_MIRROR_IDENTITY_AUDIT_V1", "stable": stable, "mirror_exact_match": exact,
            "history_rows": count, "history_unique_ids": len(seen), "db_rows": db_rows,
            "history_only": missing, "db_only": db_only, "hash_conflicts": conflicts,
            "history_duplicate_ids": duplicates, "history_duplicate_hash_conflicts": duplicate_conflicts,
            "db_duplicate_ids": db_duplicates, "invalid_identities": invalid,
            "history_identity_sha256": identity_digest(seen), "db_identity_sha256": identity_digest(db_hashes),
            "db_schema_sha256": hashlib.sha256(schema.encode()).hexdigest(), "shards": summaries,
            "db_writes": 0, "history_writes": 0, "semantic_validation": "NOT_PERFORMED"}


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise AuditError("ARGUMENTS_INVALID")


def main():
    try:
        parser = SafeParser(prog="inspect_mirror_identity")
        parser.add_argument("--history-dir", required=True)
        parser.add_argument("--db", required=True)
        args = parser.parse_args()
        print(json.dumps(inspect(args.history_dir, args.db), sort_keys=True))
        return 0
    except Exception as error:
        # No raw exception text, path, row, SQL value or traceback may leave this process.
        code = str(error) if isinstance(error, AuditError) else "AUDIT_INPUT_UNREADABLE_OR_INVALID"
        print(json.dumps({"kind": "ZMI_MIRROR_IDENTITY_AUDIT_V1", "status": "REFUSED", "reason": code}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
