import csv
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
scripts = Path(__file__).parents[1]/'scripts'
sys.path.insert(0,str(scripts))
from inspect_mirror_identity import inspect as identity_audit
from inspect_legacy_mirror_delta import inspect, saved_hash, FIELDS

class LegacyMirrorDeltaTests(unittest.TestCase):
    def fixture(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup);root=Path(temp.name)
        def row(key):
            value={field:'fixture' for field in FIELDS if field is not None}
            value.update({'row_id':key,'source':'booking','collected_date_jst':'2026-06-16','normalized_total_price':'10000','source_slug_or_code':'fixture',
                          'is_price_usable_for_dp_direct':'true','is_price_usable_for_dp_directional':'false','is_price_excluded_from_dp':'false','secret_url':'DO_NOT_EMIT'})
            value['row_hash']=saved_hash(value)
            return value
        good,delta=row('good'),row('delta')
        shard=root/'zao_signals_2026_06.csv'
        with shard.open('w',newline='') as out:
            writer=csv.writer(out);writer.writerow(['row_id','row_hash']);writer.writerow(['good',good['row_hash']])
        db=root/'fixture.sqlite';c=sqlite3.connect(db)
        c.execute('CREATE TABLE market_signal_history(row_id TEXT PRIMARY KEY,row_hash TEXT,shard_month TEXT,raw_json TEXT)')
        for value in [good,delta]:c.execute('INSERT INTO market_signal_history VALUES(?,?,?,?)',(value['row_id'],value['row_hash'],'2026_06',json.dumps(value)))
        c.commit();c.close()
        return root,shard,db,identity_audit(root,db)

    def test_lineage_summary_never_exports_raw_rows_or_claims_original_authenticity(self):
        root,shard,db,prior=self.fixture();before=(db.read_bytes(),shard.read_bytes())
        result=inspect(root,db,prior)
        self.assertEqual(result['db_only'],1);self.assertEqual(result['saved_content_hash_matches'],1)
        self.assertEqual(result['saved_identity_matches'],1)
        self.assertEqual(result['independent_original_source_authenticity'],'NOT_ESTABLISHED')
        self.assertNotIn('DO_NOT_EMIT',json.dumps(result));self.assertNotIn(str(root),json.dumps(result))
        self.assertEqual(before,(db.read_bytes(),shard.read_bytes()))

    def test_altered_saved_json_is_unverified_without_deleting_anything(self):
        root,_,db,prior=self.fixture();c=sqlite3.connect(db)
        raw=json.loads(c.execute("SELECT raw_json FROM market_signal_history WHERE row_id='delta'").fetchone()[0]);raw['normalized_total_price']='20000'
        c.execute("UPDATE market_signal_history SET raw_json=? WHERE row_id='delta'",(json.dumps(raw),));c.commit();c.close()
        result=inspect(root,db,prior)
        self.assertEqual(result['saved_content_hash_matches'],0);self.assertEqual(result['saved_content_hash_unverified'],1)

    def test_prior_shard_changes_wal_and_row_budget_refuse(self):
        root,shard,db,prior=self.fixture()
        with self.assertRaisesRegex(ValueError,'ROW_BUDGET'):inspect(root,db,prior,max_db_rows=1)
        shard.write_text(shard.read_text()+'\n')
        with self.assertRaisesRegex(ValueError,'SHARD_CHANGED'):inspect(root,db,prior)
        Path(str(db)+'-wal').touch()
        with self.assertRaisesRegex(ValueError,'WAL_PRESENT'):inspect(root,db,prior)

if __name__=='__main__':unittest.main()
