"""Read-only follow-up restricted to DB-referenced historical shards; emits aggregate lineage only.
Requires the prior stable identity audit and its exact DB/shard identities. No repair or raw exports.
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
from inspect_mirror_identity import AuditError, HashingReader, SafeParser, identity_digest, stamp

FIELDS = ['source', 'source_phase', 'collector_stage', 'canonical_property_name', None,
          'checkin', 'checkout', 'stay_scope', 'collected_date_jst', 'availability_status',
          'sold_out_status', 'normalized_total_price', 'basis_confidence', 'source_classification',
          'is_price_usable_for_dp_direct', 'is_price_usable_for_dp_directional', 'is_price_excluded_from_dp']


def saved_hash(row):
    token = row.get('source_slug_or_code', '').strip() or row.get('source_property_id', '').strip() or 'market_aggregate'
    parts = []
    for field in FIELDS:
        value = token if field is None else row.get(field)
        if field == 'normalized_total_price' and value == '':
            value = 'null'
        if not isinstance(value, str):
            return None
        if field and field.startswith('is_price_') and value not in ('true', 'false'):
            return None
        parts.append(value)
    return hashlib.sha256('|'.join(parts).encode()).hexdigest()


def inspect(history_dir, db_path, prior, max_db_rows=3000):
    if prior.get('kind') != 'ZMI_MIRROR_IDENTITY_AUDIT_V1' or prior.get('stable') is not True:
        raise AuditError('PRIOR_STABLE_AUDIT_REQUIRED')
    directory, db = Path(history_dir).resolve(strict=True), Path(db_path).resolve(strict=True)
    if Path(str(db)+'-wal').exists():
        raise AuditError('WAL_PRESENT_STOP')
    before_db = stamp(db)
    connection = sqlite3.connect(db.as_uri()+'?mode=ro&immutable=1', uri=True)
    try:
        valid = "typeof(row_id)='text' AND length(CAST(row_id AS BLOB)) BETWEEN 1 AND 256 AND typeof(row_hash)='text' AND length(CAST(row_hash AS BLOB))=64 AND typeof(raw_json)='text' AND length(CAST(raw_json AS BLOB))<=65536 AND length(shard_month)<=7"
        raw = connection.execute(f'SELECT CASE WHEN {valid} THEN row_id END,CASE WHEN {valid} THEN row_hash END,CASE WHEN {valid} THEN shard_month END,CASE WHEN {valid} THEN raw_json END FROM market_signal_history LIMIT ?', (max_db_rows+1,))
        rows = []
        for row in raw:
            if len(rows) == max_db_rows:
                raise AuditError('DB_DELTA_ROW_BUDGET')
            if any(v is None for v in row) or not re.fullmatch(r'[0-9a-f]{64}', row[1]) or not re.fullmatch(r'\d{4}_\d{2}', row[2]):
                raise AuditError('DB_DELTA_IDENTITY_OR_SIZE_INVALID')
            rows.append(row)
    finally:
        connection.close()
    pairs = {r[0]:r[1] for r in rows}
    if len(pairs) != len(rows) or identity_digest(pairs) != prior['db_identity_sha256']:
        raise AuditError('DB_IDENTITY_CHANGED')
    references = {s['shard']:s for s in prior['shards']}
    selected = sorted({'zao_signals_'+r[2]+'.csv' for r in rows})
    if len(selected)>12:
        raise AuditError('HISTORICAL_SHARD_BUDGET')
    matched, summaries = set(), []
    budget = [96*1024*1024]
    for name in selected:
        if name not in references:
            raise AuditError('DB_SHARD_NOT_IN_PRIOR_AUDIT')
        path = directory/name
        before = stamp(path)
        if before[2] > budget[0]:
            raise AuditError('HISTORICAL_BYTE_BUDGET')
        digest, count = hashlib.sha256(), 0
        with path.open('rb', buffering=0) as raw:
            text = io.TextIOWrapper(io.BufferedReader(HashingReader(raw,digest,budget)), encoding='utf-8-sig', newline='')
            reader = csv.DictReader(text)
            if len(reader.fieldnames or [])!=len(set(reader.fieldnames or [])) or not {'row_id','row_hash'}.issubset(reader.fieldnames or []):
                raise AuditError('CSV_HEADERS_INVALID')
            for row in reader:
                count += 1
                if count>200_000 or None in row or any(v is None for v in row.values()):
                    raise AuditError('CSV_SHAPE_OR_ROW_BUDGET')
                key = row['row_id']
                if key in pairs:
                    if pairs[key] != row['row_hash']:
                        raise AuditError('DB_HISTORY_HASH_CONFLICT')
                    matched.add(key)
        if stamp(path)!=before or digest.hexdigest()!=references[name]['raw_bytes_sha256'] or count!=references[name]['rows']:
            raise AuditError('HISTORICAL_SHARD_CHANGED')
        summaries.append({'shard':name,'rows':count,'raw_bytes_sha256':digest.hexdigest()})
    delta = [r for r in rows if r[0] not in matched]
    if len(delta)!=prior['db_only']:
        raise AuditError('DELTA_COUNT_CHANGED_OR_WRONG_SHARD')
    results = {'saved_identity_matches':0,'saved_content_hash_matches':0,'saved_content_hash_unverified':0}
    by_source, dates = {}, []
    for key, digest, _, payload in delta:
        try:
            row = json.loads(payload)
        except (ValueError,TypeError):
            row = None
        if not isinstance(row,dict):
            results['saved_content_hash_unverified'] += 1
            continue
        results['saved_identity_matches'] += int(row.get('row_id')==key and row.get('row_hash')==digest)
        same = saved_hash(row)==digest
        results['saved_content_hash_matches' if same else 'saved_content_hash_unverified'] += 1
        source = row.get('source')
        source = source if source in ('booking','jalan','rakuten','google_hotels') else 'OTHER'
        by_source[source] = by_source.get(source,0)+1
        date = row.get('collected_date_jst','')
        if isinstance(date,str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):
            dates.append(date)
    if stamp(db)!=before_db or Path(str(db)+'-wal').exists():
        raise AuditError('DB_CHANGED_DURING_READ')
    return {'kind':'ZMI_LEGACY_MIRROR_DELTA_V1','db_rows':len(rows),'db_only':len(delta),**results,'by_source':by_source,
            'collected_date_from':min(dates) if dates else None,'collected_date_to':max(dates) if dates else None,
            'historical_shards':summaries,'db_writes':0,'history_writes':0,'independent_original_source_authenticity':'NOT_ESTABLISHED'}


def main():
    try:
        parser=SafeParser(prog='inspect_legacy_mirror_delta')
        for key in ['history-dir','db','prior-audit']:
            parser.add_argument('--'+key, required=True)
        args=parser.parse_args()
        prior=json.loads(Path(args.prior_audit).read_text())
        print(json.dumps(inspect(args.history_dir,args.db,prior),sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({'status':'REFUSED','reason':str(error) if isinstance(error,AuditError) else 'DELTA_INPUT_UNREADABLE_OR_INVALID'}),file=sys.stderr)
        return 2

if __name__=='__main__':
    sys.exit(main())
