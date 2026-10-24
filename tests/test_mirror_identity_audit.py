import csv
import importlib.util
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location("mirror_identity", Path(__file__).parents[1] / "scripts/inspect_mirror_identity.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class MirrorIdentityAuditTests(unittest.TestCase):
    def fixture(self, history, database):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        shard = root / "zao_signals_2027_01.csv"
        with shard.open("w", newline="") as out:
            writer = csv.writer(out)
            writer.writerow(["row_id", "row_hash", "unreported_text"])
            writer.writerows((key, value, "DO_NOT_EMIT") for key, value in history)
        db = root / "fixture.sqlite"
        connection = sqlite3.connect(db)
        connection.execute("CREATE TABLE market_signal_history(row_id TEXT PRIMARY KEY,row_hash TEXT)")
        connection.executemany("INSERT INTO market_signal_history VALUES(?,?)", database)
        connection.commit()
        connection.close()
        return root, shard, db

    def test_exact_and_raw_bytes_unchanged(self):
        root, shard, db = self.fixture([("a", "1" * 64)], [("a", "1" * 64)])
        original = db.read_bytes(), shard.read_bytes()
        report = audit.inspect(root, db)
        self.assertTrue(report["mirror_exact_match"])
        self.assertEqual(original, (db.read_bytes(), shard.read_bytes()))
        self.assertNotIn("DO_NOT_EMIT", str(report))
        self.assertNotIn(str(root), str(report))

    def test_classifies_each_mismatch_without_repair(self):
        root, _, db = self.fixture([("a", "1" * 64), ("b", "2" * 64), ("b", "3" * 64)], [("a", "4" * 64), ("c", "5" * 64)])
        report = audit.inspect(root, db)
        self.assertEqual([report[k] for k in ["history_only", "db_only", "hash_conflicts", "history_duplicate_ids", "history_duplicate_hash_conflicts"]], [1, 1, 1, 1, 1])
        self.assertFalse(report["mirror_exact_match"])

    def test_refuses_wal_and_budget_exhaustion(self):
        root, _, db = self.fixture([("a", "1" * 64)], [])
        with self.assertRaisesRegex(ValueError, "BUDGET_EXCEEDED"):
            audit.inspect(root, db, max_rows=0)
        Path(str(db) + "-wal").touch()
        with self.assertRaisesRegex(ValueError, "WAL_PRESENT"):
            audit.inspect(root, db)

    def test_rejects_ambiguous_csv_shape(self):
        root, shard, db = self.fixture([], [("a", "2" * 64)])
        shard.write_text("row_id,row_hash,row_hash\na," + "1" * 64 + "," + "2" * 64 + "\n")
        with self.assertRaisesRegex(ValueError, "DUPLICATE_CSV_HEADERS"):
            audit.inspect(root, db)
        shard.write_text("row_id,row_hash\na," + "2" * 64 + ",unexpected\n")
        with self.assertRaisesRegex(ValueError, "ROW_WIDTH"):
            audit.inspect(root, db)

    def test_bounded_shards_bytes_and_db_identity_size(self):
        root, shard, db = self.fixture([], [("a" * 257, "1" * 64)])
        with self.assertRaisesRegex(ValueError, "SIZE_OR_TYPE"):
            audit.inspect(root, db)
        with self.assertRaisesRegex(ValueError, "BYTE_BUDGET"):
            audit.inspect(root, db, max_bytes=1)
        with self.assertRaisesRegex(ValueError, "SHARD_BUDGET"):
            audit.inspect(root, db, max_shards=0)

    def test_cli_error_redacts_paths_and_tracebacks(self):
        script = Path(__file__).parents[1] / "scripts/inspect_mirror_identity.py"
        run = subprocess.run([sys.executable, str(script), "--history-dir", "/missing/SECRET_PATH", "--db", "/missing/SECRET_DB"], capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)
        self.assertNotIn("SECRET", run.stdout + run.stderr)
        self.assertNotIn("Traceback", run.stderr)
        self.assertNotIn(str(script), run.stderr)
        self.assertIn("AUDIT_INPUT_UNREADABLE_OR_INVALID", run.stderr)

    def test_db_row_budget_bounds_sql_work_before_any_full_scan(self):
        root, _, db = self.fixture([], [(str(i), "1" * 64) for i in range(5000)])
        connect = sqlite3.connect
        def bounded_connect(*args, **kwargs):
            connection = connect(*args, **kwargs)
            # A full-table COUNT/type/length validation exceeds this VM-instruction budget.
            connection.set_progress_handler(lambda: 1, 1000)
            return connection
        with patch.object(audit.sqlite3, "connect", bounded_connect):
            with self.assertRaisesRegex(ValueError, "DB_IDENTITY_BUDGET_EXCEEDED"):
                audit.inspect(root, db, max_rows=1)


if __name__ == "__main__":
    unittest.main()
