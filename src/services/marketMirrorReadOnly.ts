// Only the market mirror table's identity and saved JSON enter RAM; never log/serialize the captured rows.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
export function openReadOnlyMarketMirror(path: string): {
    db: Database.Database;
    assertUnchanged(): void;
    close(): void;
} {
    const canonical = realpathSync(path);
    const stamp = () => { const s = statSync(canonical, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs].join('|'); };
    const sidecar = () => existsSync(canonical + '-wal') || existsSync(canonical + '-journal');
    if (sidecar())
        throw new Error('MARKET_PROJECTION_REFUSED(SIDECAR)');
    const before = stamp();
    let doc: {
        kind: string;
        sourceStamp: string;
        rows: [
            string,
            string,
            string
        ][];
    };
    try {
        const raw = execFileSync('python3', [fileURLToPath(new URL('../../scripts/read_market_mirror_projection.py', import.meta.url)), canonical], { encoding: 'utf8', maxBuffer: 35 * 1024 * 1024, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
        doc = JSON.parse(raw) as typeof doc;
    }
    catch {
        throw new Error('MARKET_PROJECTION_REFUSED(CAPTURE)');
    }
    const assertUnchanged = () => { if (stamp() !== before || sidecar())
        throw new Error('MARKET_PROJECTION_REFUSED(SOURCE_CHANGED)'); };
    assertUnchanged();
    if (doc.kind !== 'MARKET_MIRROR_PRIVATE_RAM_PROJECTION_V1' || doc.sourceStamp !== before || !Array.isArray(doc.rows) || doc.rows.length > 200000)
        throw new Error('MARKET_PROJECTION_REFUSED(SHAPE)');
    const db = new Database(':memory:');
    try {
        db.exec('CREATE TABLE market_signal_history(row_id TEXT PRIMARY KEY,row_hash TEXT NOT NULL,raw_json TEXT NOT NULL)');
        const insert = db.prepare('INSERT INTO market_signal_history VALUES(?,?,?)');
        db.transaction(() => {
            for (const r of doc.rows) {
                if (!Array.isArray(r) || r.length !== 3 || r.some(v => typeof v !== 'string') || Buffer.byteLength(r[0]) < 1 || Buffer.byteLength(r[0]) > 256
                    || !/^[0-9a-f]{64}$/u.test(r[1]) || Buffer.byteLength(r[2]) > 65536)
                    throw new Error('MARKET_PROJECTION_REFUSED(ROW)');
                insert.run(...r);
            }
        })();
        db.pragma('query_only=ON');
        assertUnchanged();
        return { db, assertUnchanged, close: () => db.close() };
    }
    catch (e) {
        db.close();
        throw e;
    }
}
