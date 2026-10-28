import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMirrorRecovery, applyMirrorDatabaseRecovery, rollbackMirrorDatabaseRecovery, publishRecoveredLegacyHistory, resumeMirrorRecovery, persistMirrorRecoveryPlan, withMirrorRecoveryLock, type MirrorRecoveryAcceptance } from "../src/services/marketMirrorRecoveryPlan";
import { ensureMirrorSchema, applyRealSync } from "../src/services/historyToDbSyncRealRun";
import { mapHistoryRowToMarketSignalHistoryRow, parseCsvTable } from "../src/services/historyToDbSyncDryRun";
import { HISTORY_CSV_HEADERS, buildRowId, buildRowHash, renderHistoryCsv, type HistoryRow } from "../src/services/localHistorySchemaDesign";
import { parseShardRows } from "../src/services/localHistoryRealAppend";
vi.mock("node:fs", async (importOriginal) => { const fs = await importOriginal<typeof import("node:fs")>(); return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) }; });
const AT = "2026-10-25T01:00:00+09:00", REF = "https://github.com/ginisato-hash/zao-market-intelligence-private/issues/13#issuecomment-9999999999";
function row(day: number): HistoryRow {
    const raw: Record<string, string> = Object.fromEntries(HISTORY_CSV_HEADERS.map(k => [k, ""]));
    Object.assign(raw, { shard_month: "2027_01", source: "booking", source_phase: "fixture", collector_stage: "fixture", canonical_property_name: "Fixture", source_property_name: "Fixture", source_slug_or_code: "fixture", source_property_id: "fixture",
        property_identity_match: "true", collected_date_jst: "2026-10-24", collected_at_jst: "2026-10-24T12:00:00+09:00", normalized_at_jst: "2026-10-24T12:00:00+09:00", checkin: `2027-01-${String(day).padStart(2, "0")}`,
        checkout: `2027-01-${String(day + 1).padStart(2, "0")}`, stay_nights: "1", group_adults: "2", group_children: "0", no_rooms: "1", currency: "JPY", language: "ja", stay_scope: "one_night", availability_status: "available", sold_out_status: "not_sold_out",
        normalized_total_price: "20000", basis_confidence: "A", source_classification: "fixture", is_price_usable_for_dp_direct: "true", is_price_usable_for_dp_directional: "false", is_price_excluded_from_dp: "false", schema_version: "fixture" });
    const parsed = parseShardRows(HISTORY_CSV_HEADERS.join(",") + "\n" + HISTORY_CSV_HEADERS.map(k => raw[k]).join(",") + "\n")[0]!;
    parsed.rowId = buildRowId(parsed);
    parsed.rowHash = buildRowHash(parsed);
    return parsed;
}
function fixture(history: HistoryRow[], existing: HistoryRow[], fileDb = false) {
    const dir = mkdtempSync(join(tmpdir(), "mirror-recovery-")), path = join(dir, "zao_signals_2027_01.csv"), content = renderHistoryCsv(history);
    writeFileSync(path, content);
    const db = new Database(fileDb ? join(dir, "market.sqlite") : ":memory:");
    ensureMirrorSchema(db);
    db.exec("CREATE TABLE protected_state(v TEXT); INSERT INTO protected_state VALUES('KEEP')");
    if (existing.length)
        applyRealSync({ db, runId: "fixture-seed", generatedAtJst: AT, reportPath: "fixture", sourceHistoryFiles: [], rows: parseCsvTable(renderHistoryCsv(existing)).rows.map(r => mapHistoryRowToMarketSignalHistoryRow(r, AT)) });
    const pin = () => [{ name: "zao_signals_2027_01.csv", sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), rows: parseCsvTable(readFileSync(path, "utf8")).rows.length }];
    return { dir, path, db, pin };
}
function accept(p: ReturnType<typeof prepareMirrorRecovery>, purpose: MirrorRecoveryAcceptance["purpose"] = "MIRROR_RECONCILIATION"): MirrorRecoveryAcceptance {
    return { purpose, planSha256: p.plan.planSha256, releaseGitSha: p.plan.releaseGitSha, tdAcceptanceRef: REF, ownerApprovalRef: REF };
}
describe("bounded explicit mirror recovery", () => {
    it("keeps DB-only originals, verifies saved identity/content, and refuses DB repair until canonical publication", () => {
        const x = fixture([row(1), row(2)], [row(1), row(3)]), before = readFileSync(x.path), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            expect(p.plan).toMatchObject({ historyRows: 2, dbRows: 2, historyOnly: 1, dbOnly: 1, recoverableLegacyRows: 1, originalSourceAuthenticity: "NOT_ESTABLISHED" });
            expect(p.legacyRows[0]!.rowHash).toBe(row(3).rowHash);
            expect(() => withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock))).toThrow("LEGACY_HISTORY_PUBLICATION_REQUIRED");
            expect(x.db.prepare("SELECT COUNT(*) n FROM market_signal_history").get()).toEqual({ n: 2 });
            expect(readFileSync(x.path).equals(before)).toBe(true);
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("inserts only missing rows atomically, replays without duplicates, and rollback preserves originals plus later natural rows", () => {
        const x = fixture([row(1), row(2), row(3)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            expect(withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock))).toEqual({ state: "APPLIED", inserted: 2, mirrorExact: true });
            expect(withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock))).toEqual({ state: "ALREADY_APPLIED", inserted: 0, mirrorExact: true });
            applyRealSync({ db: x.db, runId: "later-natural", generatedAtJst: AT, reportPath: "fixture", sourceHistoryFiles: [], rows: parseCsvTable(renderHistoryCsv([row(4)])).rows.map(r => mapHistoryRowToMarketSignalHistoryRow(r, AT)) });
            p.close(); // A restart must not require the original in-memory preparation token for rollback.
            expect(withMirrorRecoveryLock(x.dir, lock => rollbackMirrorDatabaseRecovery(x.db, p.plan.planSha256, accept(p, "MIRROR_RECONCILIATION_ROLLBACK"), lock))).toBe(2);
            expect(x.db.prepare("SELECT row_id FROM market_signal_history ORDER BY row_id").all()).toEqual([{ row_id: row(1).rowId }, { row_id: row(4).rowId }]);
            expect(x.db.prepare("SELECT v FROM protected_state").get()).toEqual({ v: "KEEP" });
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("rolls back every insert, sync log and recovery DDL on a mid-insert failure", () => {
        const x = fixture([row(1), row(2), row(3)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        x.db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON market_signal_history WHEN NEW.checkin_date='2027-01-03' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
        try {
            expect(() => withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock))).toThrow("fixture failure");
            expect(x.db.prepare("SELECT COUNT(*) n FROM market_signal_history").get()).toEqual({ n: 1 });
            expect(x.db.prepare("SELECT COUNT(*) n FROM market_signal_sync_runs").get()).toEqual({ n: 1 });
            expect(x.db.prepare("SELECT name FROM sqlite_master WHERE name='market_mirror_reconciliations'").get()).toBeUndefined();
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("refuses modified DB, changed/new history shards, forged plan, wrong release and missing acceptance", () => {
        for (const change of ["db", "source", "new-shard", "forged", "release", "approval"]) {
            const x = fixture([row(1), row(2)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
            try {
                let prepared = p, a = accept(p);
                if (change === "db")
                    x.db.prepare("UPDATE market_signal_history SET row_hash=?").run("f".repeat(64));
                if (change === "source")
                    writeFileSync(x.path, renderHistoryCsv([row(1), row(3)]));
                if (change === "new-shard")
                    writeFileSync(join(x.dir, "zao_signals_2027_02.csv"), renderHistoryCsv([]));
                if (change === "forged")
                    prepared = { ...p };
                if (change === "release")
                    a = { ...a, releaseGitSha: "c".repeat(40) };
                if (change === "approval")
                    a = { ...a, tdAcceptanceRef: "none" };
                expect(() => withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, prepared, a, AT, lock)), change).toThrow("RECOVERY_REFUSED");
                expect(x.db.prepare("SELECT COUNT(*) n FROM market_signal_history").get()).toEqual({ n: 1 });
            }
            finally {
                p.close();
                x.db.close();
            }
        }
    });
    it("refuses duplicate/conflicting rows and pins that omit part of the history universe", () => {
        const x = fixture([row(1), row(1)], []);
        try {
            expect(() => prepareMirrorRecovery(x.db, x.dir, x.pin())).toThrow("DUPLICATE");
        }
        finally {
            x.db.close();
        }
        const y = fixture([row(1)], [{ ...row(1), rowHash: "e".repeat(64) }]);
        try {
            expect(() => prepareMirrorRecovery(y.db, y.dir, y.pin())).toThrow("HASH_CONFLICT");
        }
        finally {
            y.db.close();
        }
        const z = fixture([row(1)], []);
        writeFileSync(join(z.dir, "zao_signals_2027_02.csv"), renderHistoryCsv([]));
        try {
            expect(() => prepareMirrorRecovery(z.db, z.dir, z.pin())).toThrow("UNIVERSE_INCOMPLETE");
        }
        finally {
            z.db.close();
        }
    });
    it("rejects saved JSON whose content no longer agrees with the original DB hash", () => {
        const x = fixture([row(1)], [row(1), row(2)]);
        const r = x.db.prepare("SELECT raw_json FROM market_signal_history WHERE row_id=?").get(row(2).rowId) as {
            raw_json: string;
        };
        const raw = JSON.parse(r.raw_json);
        raw.normalized_total_price = "100";
        x.db.prepare("UPDATE market_signal_history SET raw_json=? WHERE row_id=?").run(JSON.stringify(raw), row(2).rowId);
        try {
            expect(() => prepareMirrorRecovery(x.db, x.dir, x.pin())).toThrow("LEGACY_CONTENT_HASH");
        }
        finally {
            x.db.close();
        }
    });
    it("restores legacy history with byte-preserving prefix and multiline data, then backfills DB under the same accepted plan", () => {
        const legacy = { ...row(3), basisNote: 'quote, "text"\n\nsecond paragraph' };
        const x = fixture([row(1), row(2)], [row(1), legacy]), before = readFileSync(x.path), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            withMirrorRecoveryLock(x.dir, lock => {
                expect(existsSync(join(x.dir, ".append.lock"))).toBe(true);
                const published = publishRecoveredLegacyHistory(p, accept(p), join(x.dir, ".recovery"), Buffer.alloc(32, 7), lock);
                expect(published).toEqual({ appended: 1, touchedShards: 1 });
                expect(readFileSync(x.path).subarray(0, before.length).equals(before)).toBe(true);
                expect(parseShardRows(readFileSync(x.path, "utf8")).find(r => r.rowId === legacy.rowId)!.basisNote).toBe(legacy.basisNote);
                expect(publishRecoveredLegacyHistory(p, accept(p), join(x.dir, ".recovery"), Buffer.alloc(32, 7), lock)).toEqual({ appended: 0, touchedShards: 0 });
                expect(applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock)).toEqual({ state: "APPLIED", inserted: 1, mirrorExact: true });
            });
            const encrypted = readdirSync(join(x.dir, ".recovery")).find(n => n.endsWith('.aesgcm'))!;
            expect(readFileSync(join(x.dir, ".recovery", encrypted)).includes(before)).toBe(false);
            expect(existsSync(join(x.dir, ".append.lock"))).toBe(false);
            expect(x.db.prepare("SELECT COUNT(*) n FROM market_signal_history").get()).toEqual({ n: 3 });
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("a fake or expired canonical lock and a different target DB cannot authorize writes", () => {
        const x = fixture([row(1), row(2)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            expect(() => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, { historyDir: x.dir })).toThrow("CANONICAL_HISTORY_LOCK_REQUIRED");
            const token = withMirrorRecoveryLock(x.dir, lock => lock);
            expect(() => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, token)).toThrow("CANONICAL_HISTORY_LOCK_REQUIRED");
            const other = fixture([row(1), row(2)], [row(1)]);
            try {
                expect(() => withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(other.db, p, accept(p), AT, lock))).toThrow("TARGET_DATABASE_CHANGED");
            }
            finally {
                other.db.close();
            }
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("never clears a prior or replaced legacy lock, and refuses writes after lock ownership changes", () => {
        const x = fixture([row(1), row(2)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin()), path = join(x.dir, '.append.lock');
        try {
            writeFileSync(path, 'prior owner');
            expect(() => withMirrorRecoveryLock(x.dir, () => { })).toThrow('LEGACY_APPEND_LOCK_PRESENT');
            expect(readFileSync(path, 'utf8')).toBe('prior owner');
        }
        finally {
            p.close();
            x.db.close();
        }
        const y = fixture([row(1), row(2)], [row(1)]), q = prepareMirrorRecovery(y.db, y.dir, y.pin()), other = join(y.dir, '.append.lock');
        try {
            withMirrorRecoveryLock(y.dir, lock => {
                writeFileSync(other, 'replaced owner');
                expect(() => applyMirrorDatabaseRecovery(y.db, q, accept(q), AT, lock)).toThrow('CANONICAL_HISTORY_LOCK_REQUIRED');
            });
            expect(readFileSync(other, 'utf8')).toBe('replaced owner');
            expect(y.db.prepare('SELECT COUNT(*) n FROM market_signal_history').get()).toEqual({ n: 1 });
        }
        finally {
            q.close();
            y.db.close();
        }
    });
    it("refuses rollback when a recovery row changed, without deleting any row", () => {
        const x = fixture([row(1), row(2)], [row(1)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock));
            x.db.prepare('UPDATE market_signal_history SET row_hash=? WHERE row_id=?').run('e'.repeat(64), row(2).rowId);
            expect(() => withMirrorRecoveryLock(x.dir, lock => rollbackMirrorDatabaseRecovery(x.db, p.plan.planSha256, accept(p, 'MIRROR_RECONCILIATION_ROLLBACK'), lock))).toThrow('ROLLBACK_ROW_CHANGED');
            expect(x.db.prepare('SELECT COUNT(*) n FROM market_signal_history').get()).toEqual({ n: 2 });
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("binds legacy saved fields excluded from row_hash and refuses changed raw JSON before any publication", () => {
        const x = fixture([row(1)], [row(2)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            const raw = JSON.parse((x.db.prepare('SELECT raw_json FROM market_signal_history').get() as {
                raw_json: string;
            }).raw_json);
            raw.basis_note = 'changed note';
            x.db.prepare('UPDATE market_signal_history SET raw_json=?').run(JSON.stringify(raw));
            const next = prepareMirrorRecovery(x.db, x.dir, x.pin());
            try {
                expect(next.plan.planSha256).not.toBe(p.plan.planSha256);
            }
            finally {
                next.close();
            }
            expect(() => withMirrorRecoveryLock(x.dir, lock => publishRecoveredLegacyHistory(p, accept(p), join(x.dir, '.recovery'), Buffer.alloc(32, 7), lock))).toThrow('LEGACY_SAVED_JSON_CHANGED');
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("resumes the exact accepted plan after a restart between CSV publication and DB commit, then replays a committed result", () => {
        const x = fixture([row(1), row(2)], [row(1), row(3)], true), pins = x.pin(), p = prepareMirrorRecovery(x.db, x.dir, pins), a = accept(p), backup = join(x.dir, '.recovery'), key = Buffer.alloc(32, 7);
        withMirrorRecoveryLock(x.dir, lock => publishRecoveredLegacyHistory(p, a, backup, key, lock));
        p.close();
        x.db.close();
        const db = new Database(join(x.dir, 'market.sqlite'));
        try {
            expect(() => prepareMirrorRecovery(db, x.dir, pins)).toThrow('SOURCE_CHANGED');
            withMirrorRecoveryLock(x.dir, lock => {
                const resumed = resumeMirrorRecovery(db, x.dir, backup, a, key, lock);
                try {
                    expect(resumed.plan.planSha256).toBe(a.planSha256);
                    expect(publishRecoveredLegacyHistory(resumed, a, backup, key, lock).appended).toBe(0);
                    expect(applyMirrorDatabaseRecovery(db, resumed, a, AT, lock)).toEqual({ state: 'APPLIED', inserted: 1, mirrorExact: true });
                }
                finally {
                    resumed.close();
                }
            });
        }
        finally {
            db.close();
        }
        const db2 = new Database(join(x.dir, 'market.sqlite'));
        try {
            withMirrorRecoveryLock(x.dir, lock => {
                const resumed = resumeMirrorRecovery(db2, x.dir, backup, a, key, lock);
                try {
                    expect(applyMirrorDatabaseRecovery(db2, resumed, a, AT, lock)).toEqual({ state: 'ALREADY_APPLIED', inserted: 0, mirrorExact: true });
                }
                finally {
                    resumed.close();
                }
            });
        }
        finally {
            db2.close();
        }
    });
    it("rejects an unrelated third-state append after publication and leaves both DB and history alone", () => {
        const x = fixture([row(1), row(2)], [row(1), row(3)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin()), a = accept(p), backup = join(x.dir, '.recovery'), key = Buffer.alloc(32, 7);
        try {
            withMirrorRecoveryLock(x.dir, lock => publishRecoveredLegacyHistory(p, a, backup, key, lock));
            p.close();
            writeFileSync(x.path, renderHistoryCsv([row(1), row(2), row(3), row(4)]));
            const before = readFileSync(x.path);
            expect(() => withMirrorRecoveryLock(x.dir, lock => resumeMirrorRecovery(x.db, x.dir, backup, a, key, lock))).toThrow('RESUME_RECEIPT');
            expect(readFileSync(x.path)).toEqual(before);
            expect(x.db.prepare('SELECT COUNT(*) n FROM market_signal_history').get()).toEqual({ n: 2 });
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("ignores partial unique orphans, and reclaims only its proven-dead recorded recovery lock", () => {
        const x = fixture([row(1)], [row(2)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin()), a = accept(p), backup = join(x.dir, '.recovery'), key = Buffer.alloc(32, 7);
        try {
            withMirrorRecoveryLock(x.dir, lock => persistMirrorRecoveryPlan(p, a, backup, lock));
            writeFileSync(join(backup, 'orphan.pending_fixture'), 'partial ciphertext');
            writeFileSync(x.path + '.recovery_' + a.planSha256 + '_orphan.tmp', 'partial staging');
            withMirrorRecoveryLock(x.dir, lock => publishRecoveredLegacyHistory(p, a, backup, key, lock));
            p.close();
            const body = `recovery_12345678-1234-1234-1234-123456789abc\n2026-10-25T00:00:00Z\npid=2147483000\nhost=${hostname()}\n`;
            writeFileSync(join(x.dir, '.append.lock'), body);
            writeFileSync(join(backup, `execution_lock_${a.planSha256}.json`), JSON.stringify({ kind: 'ZMI_RECOVERY_LOCK_V1', planSha256: a.planSha256, body }));
            withMirrorRecoveryLock(x.dir, lock => {
                const resumed = resumeMirrorRecovery(x.db, x.dir, backup, a, key, lock);
                try {
                    expect(applyMirrorDatabaseRecovery(x.db, resumed, a, AT, lock).mirrorExact).toBe(true);
                }
                finally {
                    resumed.close();
                }
            }, { planSha256: a.planSha256, backupDir: backup });
            expect(existsSync(join(x.dir, '.append.lock'))).toBe(false);
            expect(readFileSync(join(backup, 'orphan.pending_fixture'), 'utf8')).toBe('partial ciphertext');
        }
        finally {
            p.close();
            x.db.close();
        }
    });
    it("recovers from interrupted encrypted backup, receipt, and source staging writes without publishing partial final artifacts", async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        for (const phase of ['backup', 'receipt', 'staging']) {
            const x = fixture([row(1)], [row(2)]), p = prepareMirrorRecovery(x.db, x.dir, x.pin()), a = accept(p), backup = join(x.dir, '.recovery'), key = Buffer.alloc(32, 7), before = readFileSync(x.path);
            let failed = false;
            const mocked = vi.mocked(writeFileSync);
            mocked.mockImplementation(((fd: Parameters<typeof writeFileSync>[0], content: Parameters<typeof writeFileSync>[1], options?: Parameters<typeof writeFileSync>[2]) => {
                const text = Buffer.isBuffer(content) ? content.toString() : String(content);
                const match = phase === 'backup' ? text.includes('ZMI_ENCRYPTED_MIRROR_BACKUP_V1') : phase === 'receipt' ? text.includes('ZMI_LEGACY_HISTORY_PUBLICATION_V1') : text.startsWith('row_id,row_hash');
                if (!failed && match) {
                    failed = true;
                    actual.writeFileSync(fd, text.slice(0, 12), options);
                    throw new Error('fixture interrupted write');
                }
                return actual.writeFileSync(fd, content, options);
            }) as typeof writeFileSync);
            try {
                expect(() => withMirrorRecoveryLock(x.dir, lock => publishRecoveredLegacyHistory(p, a, backup, key, lock))).toThrow('fixture interrupted write');
                expect(readFileSync(x.path)).toEqual(before);
                expect(failed).toBe(true);
                mocked.mockImplementation(actual.writeFileSync);
                withMirrorRecoveryLock(x.dir, lock => {
                    expect(publishRecoveredLegacyHistory(p, a, backup, key, lock).appended).toBe(1);
                    expect(applyMirrorDatabaseRecovery(x.db, p, a, AT, lock).mirrorExact).toBe(true);
                });
            }
            finally {
                mocked.mockImplementation(actual.writeFileSync);
                p.close();
                x.db.close();
            }
        }
    });
    it('preserves pinned opaque historical ID variants, records their count, and still verifies content hashes', () => {
        const legacy = { ...row(1), rowId: row(1).rowId + '|legacy-suffix' }, x = fixture([legacy], []), p = prepareMirrorRecovery(x.db, x.dir, x.pin());
        try {
            expect(p.plan.historicalIdentityFormatExceptions).toBe(1);
            withMirrorRecoveryLock(x.dir, lock => applyMirrorDatabaseRecovery(x.db, p, accept(p), AT, lock));
            expect(x.db.prepare('SELECT row_id,row_hash FROM market_signal_history').get()).toEqual({ row_id: legacy.rowId, row_hash: legacy.rowHash });
        }
        finally {
            p.close();
            x.db.close();
        }
    });
});
