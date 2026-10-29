"""Bounded market mirror management projection into child-process RAM/stdout only.
No other tables, files, credentials, or network. Caller must not log the private payload.
"""
import json
import re
import sqlite3
import sys
from pathlib import Path


def source_stamp(path):
    stat = path.stat()
    return '|'.join(str(v) for v in (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns))


def projection(source):
    path = Path(source).resolve(strict=True)
    if any(Path(str(path) + s).exists() for s in ('-wal', '-journal')):
        raise ValueError('SIDECAR_PRESENT')
    before = source_stamp(path)
    db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
    rows, size = [], 0
    try:
        valid = "typeof(row_id)='text' AND length(CAST(row_id AS BLOB)) BETWEEN 1 AND 256 AND typeof(row_hash)='text' AND length(CAST(row_hash AS BLOB))=64 AND typeof(raw_json)='text' AND length(CAST(raw_json AS BLOB))<=65536"
        sql = f'SELECT CASE WHEN {valid} THEN row_id END,CASE WHEN {valid} THEN row_hash END,CASE WHEN {valid} THEN raw_json END FROM market_signal_history LIMIT 200001'
        for row in db.execute(sql):
            if len(rows) >= 200000 or any(not isinstance(v, str) for v in row) or not re.fullmatch(r'[0-9a-f]{64}', row[1]):
                raise ValueError('IDENTITY_OR_ROW_BUDGET')
            size += len(json.dumps(row, ensure_ascii=False).encode('utf8')) + 2
            if size > 32 * 1024 * 1024:
                raise ValueError('PROJECTION_BYTE_BUDGET')
            rows.append(row)
    finally:
        db.close()
    if source_stamp(path) != before or any(Path(str(path) + s).exists() for s in ('-wal', '-journal')):
        raise ValueError('SOURCE_CHANGED')
    return {'kind': 'MARKET_MIRROR_PRIVATE_RAM_PROJECTION_V1', 'sourceStamp': before, 'rows': rows}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('EXACT_SOURCE_REQUIRED')
        result = projection(sys.argv[1])
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    except Exception:
        sys.stderr.write('MARKET_PROJECTION_REFUSED\n')
        sys.exit(2)
