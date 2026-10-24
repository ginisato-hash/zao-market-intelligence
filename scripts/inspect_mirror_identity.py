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
from pathlib import Path


def stamp(path):
    s = path.stat()
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns


class HashingReader(io.RawIOBase):
    def __init__(self, raw, digest):
        self.raw, self.digest = raw, digest

    def readable(self):
        return True

    def readinto(self, buffer):
        n = self.raw.readinto(buffer)
        if n:
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


def inspect(history_dir, db_path, max_rows=1_000_000):
    directory, db = Path(history_dir).resolve(strict=True), Path(db_path).resolve(strict=True)
    if Path(str(db) + "-wal").exists():
        raise ValueError("WAL_PRESENT_USE_REVIEWED_SNAPSHOT_PATH")
    files = sorted(p for p in directory.iterdir() if re.fullmatch(r"zao_signals_\d{4}_\d{2}\.csv", p.name) and p.is_file())
    if not files:
        raise ValueError("HISTORY_SHARDS_MISSING")
    before = {p.name: stamp(p) for p in files}
    db_before = stamp(db)
    connection = sqlite3.connect(db.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        rows = connection.execute("SELECT row_id,row_hash FROM market_signal_history")
        db_hashes, db_rows, db_duplicates = {}, 0, 0
        for key, value in rows:
            db_rows += 1
            if db_rows > max_rows:
                raise ValueError("DB_IDENTITY_BUDGET_EXCEEDED")
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
            wrapped = io.TextIOWrapper(io.BufferedReader(HashingReader(raw, digest)), encoding="utf-8-sig", newline="")
            reader = csv.DictReader(wrapped)
            if not {"row_id", "row_hash"}.issubset(reader.fieldnames or []):
                raise ValueError("IDENTITY_COLUMNS_MISSING")
            for row in reader:
                count += 1
                file_rows += 1
                if count > max_rows:
                    raise ValueError("HISTORY_IDENTITY_BUDGET_EXCEEDED")
                key, value = row.get("row_id"), row.get("row_hash")
                if not key or not value or not re.fullmatch(r"[0-9a-f]{64}", value):
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
              and sorted(before) == sorted(p.name for p in directory.iterdir() if re.fullmatch(r"zao_signals_\d{4}_\d{2}\.csv", p.name) and p.is_file()))
    exact = stable and count == len(seen) == db_rows == len(db_hashes) and not any([missing, conflicts, db_only, invalid, db_duplicates])
    return {"kind": "ZMI_MIRROR_IDENTITY_AUDIT_V1", "stable": stable, "mirror_exact_match": exact,
            "history_rows": count, "history_unique_ids": len(seen), "db_rows": db_rows,
            "history_only": missing, "db_only": db_only, "hash_conflicts": conflicts,
            "history_duplicate_ids": duplicates, "history_duplicate_hash_conflicts": duplicate_conflicts,
            "db_duplicate_ids": db_duplicates, "invalid_identities": invalid,
            "history_identity_sha256": identity_digest(seen), "db_identity_sha256": identity_digest(db_hashes),
            "db_schema_sha256": hashlib.sha256(schema.encode()).hexdigest(), "shards": summaries,
            "db_writes": 0, "history_writes": 0, "semantic_validation": "NOT_PERFORMED"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--history-dir", required=True)
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.history_dir, args.db), sort_keys=True))
