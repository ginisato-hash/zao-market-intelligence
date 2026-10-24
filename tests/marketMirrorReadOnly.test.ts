import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadOnlyMarketMirror } from '../src/services/marketMirrorReadOnly';
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'market-projection-')), path = join(dir, 'source.sqlite'), db = new Database(path);
    db.exec('CREATE TABLE market_signal_history(row_id TEXT PRIMARY KEY,row_hash TEXT,raw_json TEXT);CREATE TABLE unrelated_secret(v TEXT);INSERT INTO unrelated_secret VALUES(\'EXCLUDED\')');
    db.prepare('INSERT INTO market_signal_history VALUES(?,?,?)').run('fixture', 'a'.repeat(64), '{}');
    db.close();
    return { dir, path };
}
it('projects only identity/saved JSON into query-only RAM and leaves source/sidecars unchanged', () => {
    const x = fixture(), before = readFileSync(x.path), p = openReadOnlyMarketMirror(x.path);
    try {
        expect(p.db.prepare('SELECT row_id FROM market_signal_history').get()).toEqual({ row_id: 'fixture' });
        expect(p.db.prepare("SELECT name FROM sqlite_master WHERE name='unrelated_secret'").get()).toBeUndefined();
        expect(() => p.db.exec("DELETE FROM market_signal_history")).toThrow();
        p.assertUnchanged();
        expect(readFileSync(x.path)).toEqual(before);
        expect(existsSync(x.path + '-wal')).toBe(false);
        expect(existsSync(x.path + '-shm')).toBe(false);
    }
    finally {
        p.close();
    }
});
it('refuses actual WAL behind a symlink and detects subsequent source changes', () => {
    const x = fixture(), alias = join(x.dir, 'alias');
    symlinkSync(x.path, alias);
    writeFileSync(x.path + '-wal', 'fixture');
    expect(() => openReadOnlyMarketMirror(alias)).toThrow('SIDECAR');
    const y = fixture(), p = openReadOnlyMarketMirror(y.path);
    try {
        writeFileSync(y.path, Buffer.concat([readFileSync(y.path), Buffer.from('change')]));
        expect(() => p.assertUnchanged()).toThrow('SOURCE_CHANGED');
    }
    finally {
        p.close();
    }
});
it('rejects invalid or oversized saved JSON with a sanitized error', () => {
    for (const value of ['x'.repeat(65537), null]) {
        const x = fixture(), db = new Database(x.path);
        db.prepare('UPDATE market_signal_history SET raw_json=?').run(value);
        db.close();
        expect(() => openReadOnlyMarketMirror(x.path)).toThrow('MARKET_PROJECTION_REFUSED(CAPTURE)');
    }
});
