import csv
import importlib.util
import sqlite3
import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
