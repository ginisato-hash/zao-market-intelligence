// Explicit recovery primitive, never called by natural collectors. No flag/guard overrides.
// Source capture is bounded to pinned monthly shards; DB-only history is retained for separate reviewed recovery.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import { historyRowFromCsvRecord } from "./localHistoryAppendValidationPolicy";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mapHistoryRowToMarketSignalHistoryRow, parseCsvTable, REQUIRED_HISTORY_COLUMNS } from "./historyToDbSyncDryRun";
import { applyRealSync } from "./historyToDbSyncRealRun";
import { buildRowHash, buildRowId, HISTORY_CSV_HEADERS, renderHistoryCsv, shardMonthFromCheckin, type HistoryRow } from "./localHistorySchemaDesign";
import { APPEND_LOCK_FILENAME, parseShardRows } from "./localHistoryRealAppend";
import { encryptMirrorBackup, decryptMirrorBackup } from "./mirrorRecoveryEncryption";
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
function fail(reason: string): never { throw new Error(`MIRROR_RECOVERY_REFUSED(${reason})`); }
const stamp = (p: string): string => { const s = statSync(p, { bigint: true }); return [s.dev, s.ino, s.size, s.mtimeNs].join("|"); };
const REF = /^https:\/\/github\.com\/ginisato-hash\/zao-market-intelligence-private\/issues\/13#issuecomment-\d+$/u;
export interface PinnedMarketShard {
    name: string;
    sha256: string;
    rows: number;
}
export interface MirrorRecoveryPlan {
    kind: "ZMI_MIRROR_RECOVERY_PLAN_V1";
    planSha256: string;
    releaseGitSha: string;
    dbIdentitySha256: string;
    historyIdentitySha256: string;
    unionIdentitySha256: string;
    historyRows: number;
    dbRows: number;
    historyOnly: number;
    dbOnly: number;
    recoverableLegacyRows: number;
    legacyIdentitySha256: string;
    legacySavedJsonSha256: string;
    pins: PinnedMarketShard[];
    originalSourceAuthenticity: "NOT_ESTABLISHED";
}
export interface MirrorRecoveryAcceptance {
    purpose: "MIRROR_RECONCILIATION" | "MIRROR_RECONCILIATION_ROLLBACK";
    planSha256: string;
    releaseGitSha: string;
    tdAcceptanceRef: string;
    ownerApprovalRef: string;
}
export interface PreparedMirrorRecovery {
    plan: MirrorRecoveryPlan;
    legacyRows: readonly HistoryRow[];
    close(): void;
}
export interface MirrorRecoveryLock {
    readonly historyDir: string;
}
const ownedLocks = new WeakMap<object, {
    path: string;
    body: string;
}>();
export function withMirrorRecoveryLock<T>(historyDir: string, work: (lock: MirrorRecoveryLock) => T, resume?: {
    planSha256: string;
    backupDir: string;
}): T {
    const dir = realpathSync(historyDir), path = join(dirname(dir), "locks", "history_writer.lock.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path), token = Object.freeze({ historyDir: dir });
    const legacyPath = join(dir, APPEND_LOCK_FILENAME), body = `recovery_${randomUUID()}\n${new Date().toISOString()}\npid=${process.pid}\nhost=${hostname()}\n`;
    let ownsLegacy = false;
    try {
        db.pragma("busy_timeout=30000");
        db.exec("BEGIN EXCLUSIVE");
        if (existsSync(legacyPath)) {
            if (!resume || !/^[0-9a-f]{64}$/u.test(resume.planSha256))
                fail("LEGACY_APPEND_LOCK_PRESENT");
            const receiptPath = join(resume.backupDir, `execution_lock_${resume.planSha256}.json`);
            if (!existsSync(receiptPath) || statSync(receiptPath).size > 4096)
                fail("LEGACY_APPEND_LOCK_PRESENT");
            const saved = JSON.parse(readFileSync(receiptPath, "utf8")) as {
                kind: string;
                planSha256: string;
                body: string;
            };
            const current = readFileSync(legacyPath, "utf8"), pid = /^pid=(\d+)$/mu.exec(current)?.[1];
            if (saved.kind !== "ZMI_RECOVERY_LOCK_V1" || saved.planSha256 !== resume.planSha256 || saved.body !== current
                || !/^recovery_[0-9a-f-]{36}\n/u.test(current) || !current.includes(`\nhost=${hostname()}\n`) || !pid)
                fail("LEGACY_LOCK_NOT_OWN_RECOVERY");
            let dead = false;
            try {
                process.kill(Number(pid), 0);
            }
            catch (e) {
                dead = (e as NodeJS.ErrnoException).code === "ESRCH";
            }
            if (!dead || readFileSync(legacyPath, "utf8") !== current)
                fail("LEGACY_LOCK_OWNER_LIVE_OR_UNKNOWN");
            unlinkSync(legacyPath);
        }
        const fd = openSync(legacyPath, "wx", 0o600);
        try {
            writeFileSync(fd, body);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        ownsLegacy = true;
        ownedLocks.set(token, { path: legacyPath, body });
        const result = work(token);
        if (result instanceof Promise)
            fail("SYNCHRONOUS_LOCK_SCOPE_REQUIRED");
        return result;
    }
    finally {
        ownedLocks.delete(token);
        if (ownsLegacy && existsSync(legacyPath) && readFileSync(legacyPath, "utf8") === body)
            unlinkSync(legacyPath);
        if (db.inTransaction)
            db.exec("ROLLBACK");
        db.close();
    }
}
function requireLock(lock: MirrorRecoveryLock, dir: string): void {
    const owned = ownedLocks.get(lock);
    if (!owned || lock.historyDir !== dir || !existsSync(owned.path) || readFileSync(owned.path, "utf8") !== owned.body)
        fail("CANONICAL_HISTORY_LOCK_REQUIRED");
}
interface Context {
    historyDir: string;
    sourceDatabase: Database.Database;
    legacyPublished: boolean;
    admitOwnPublication(path: string): void;
    stage: Database.Database;
    dbHashes: Map<string, string>;
    sourceUnchanged(): void;
    legacyUnchanged(): void;
}
const genuine = new WeakMap<object, Context>();
function digestRows(rows: Iterable<{
    row_id: string;
    row_hash: string;
}>): string {
    const h = createHash("sha256");
    for (const r of rows)
        h.update(r.row_id).update("\0").update(r.row_hash).update("\n");
    return h.digest("hex");
}
function dbHashes(db: Database.Database): Map<string, string> {
    const map = new Map<string, string>();
    const valid = "typeof(row_id)='text' AND length(CAST(row_id AS BLOB)) BETWEEN 1 AND 256 AND typeof(row_hash)='text' AND length(CAST(row_hash AS BLOB))=64";
    for (const r of db.prepare(`SELECT CASE WHEN ${valid} THEN row_id END row_id,CASE WHEN ${valid} THEN row_hash END row_hash FROM market_signal_history LIMIT 200001`).iterate() as Iterable<{
        row_id: unknown;
        row_hash: unknown;
    }>) {
        if (map.size >= 200000 || typeof r.row_id !== "string" || typeof r.row_hash !== "string" || !/^[0-9a-f]{64}$/u.test(r.row_hash) || map.has(r.row_id))
            fail("DB_IDENTITY_OR_BUDGET");
        map.set(r.row_id, r.row_hash);
    }
    return map;
}
const mapDigest = (map: Map<string, string>): string => digestRows([...map].map(([row_id, row_hash]) => ({ row_id, row_hash })).sort((a, b) => Buffer.compare(Buffer.from(a.row_id), Buffer.from(b.row_id))));
const csv = (s: string): string => /[",\r\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
function legacyFromSaved(raw: string, id: string, sha: string): HistoryRow {
    let row: Record<string, unknown>;
    try {
        row = JSON.parse(raw);
    }
    catch {
        return fail("LEGACY_JSON");
    }
    if (row === null || typeof row !== "object" || row["row_id"] !== id || row["row_hash"] !== sha || HISTORY_CSV_HEADERS.some(k => typeof row[k] !== "string"))
        return fail("LEGACY_SHAPE");
    const text = HISTORY_CSV_HEADERS.join(",") + "\n" + HISTORY_CSV_HEADERS.map(k => csv(row[k] as string)).join(",") + "\n";
    const parsed = parseShardRows(text)[0]!;
    if (parsed.shardMonth !== shardMonthFromCheckin(parsed.checkin) || buildRowId(parsed) !== id || buildRowHash(parsed) !== sha)
        return fail("LEGACY_CONTENT_HASH");
    return parsed;
}
export function prepareMirrorRecovery(db: Database.Database, historyDir: string, pins: readonly PinnedMarketShard[]): PreparedMirrorRecovery {
    return prepareInternal(db, historyDir, pins);
}
function prepareInternal(db: Database.Database, historyDir: string, pins: readonly PinnedMarketShard[], resume?: {
    originals: Map<string, Buffer>;
    expectedCurrent: Map<string, string>;
    originalDb?: Map<string, string>;
}): PreparedMirrorRecovery {
    if (pins.length === 0 || pins.length > 240 || new Set(pins.map(p => p.name)).size !== pins.length)
        fail("SHARD_BUDGET");
    const dir = realpathSync(historyDir), dbMap = resume?.originalDb ?? dbHashes(db), stage = new Database(":memory:");
    const inventory = (): string => readdirSync(dir).filter(n => /^zao_signals_\d{4}_\d{2}\.csv$/u.test(n)).sort().join("|");
    let expectedNames = pins.map(p => p.name).sort().join("|");
    if (inventory() !== expectedNames) {
        stage.close();
        return fail("PINNED_UNIVERSE_INCOMPLETE");
    }
    stage.exec("CREATE TABLE history(row_id TEXT PRIMARY KEY,row_hash TEXT NOT NULL,raw_json TEXT NOT NULL)");
    const insert = stage.prepare("INSERT INTO history VALUES(?,?,?)"), find = stage.prepare("SELECT row_hash FROM history WHERE row_id=?");
    let bytes = 0, count = 0, missing = 0;
    const stamps = new Map<string, string>();
    try {
        for (const pin of [...pins].sort((a, b) => a.name.localeCompare(b.name))) {
            if (!/^zao_signals_\d{4}_\d{2}\.csv$/u.test(pin.name) || !/^[0-9a-f]{64}$/u.test(pin.sha256) || !Number.isSafeInteger(pin.rows) || pin.rows < 0)
                fail("PIN_INVALID");
            const path = join(dir, pin.name), before = stamp(path), size = statSync(path).size;
            if (size > 32 * 1024 * 1024 || bytes + size > 128 * 1024 * 1024)
                fail("BYTE_BUDGET");
            bytes += size;
            const current = readFileSync(path);
            if (resume?.expectedCurrent.has(pin.name) && hash(current) !== resume.expectedCurrent.get(pin.name))
                fail("RESUME_SOURCE_CHANGED");
            const raw = resume?.originals.get(pin.name) ?? current;
            if (hash(raw) !== pin.sha256 || stamp(path) !== before)
                fail("SOURCE_CHANGED");
            const table = parseCsvTable(raw.toString("utf8"));
            if (new Set(table.headers).size !== table.headers.length || REQUIRED_HISTORY_COLUMNS.some(c => !table.headers.includes(c)) || table.rows.length !== pin.rows)
                fail("SOURCE_SCHEMA_OR_COUNT");
            stage.transaction(() => {
                for (const row of table.rows) {
                    count++;
                    if (count > 200000 || !row["row_id"] || Buffer.byteLength(row["row_id"]) > 256 || !/^[0-9a-f]{64}$/u.test(row["row_hash"] ?? ""))
                        fail("HISTORY_IDENTITY_OR_BUDGET");
                    if (find.get(row["row_id"]))
                        fail("HISTORY_DUPLICATE");
                    const parsed = historyRowFromCsvRecord(HISTORY_CSV_HEADERS.map(k => row[k] ?? ""));
                    if (parsed.shardMonth !== pin.name.slice(12, -4) || parsed.shardMonth !== shardMonthFromCheckin(parsed.checkin)
                        || buildRowId(parsed) !== row["row_id"] || buildRowHash(parsed) !== row["row_hash"])
                        fail("HISTORY_CONTENT_HASH_OR_SHARD");
                    const old = dbMap.get(row["row_id"]);
                    if (old !== undefined && old !== row["row_hash"])
                        fail("HASH_CONFLICT");
                    if (old === undefined)
                        missing++;
                    insert.run(row["row_id"], row["row_hash"], JSON.stringify(row));
                }
            })();
            stamps.set(path, before);
        }
        const sourceUnchanged = (): void => {
            if (inventory() !== expectedNames)
                fail("SOURCE_UNIVERSE_CHANGED");
            for (const [p, s] of stamps)
                if (stamp(p) !== s)
                    fail("SOURCE_CHANGED");
        };
        sourceUnchanged();
        const historySha = digestRows(stage.prepare("SELECT row_id,row_hash FROM history ORDER BY row_id COLLATE BINARY").iterate() as Iterable<{
            row_id: string;
            row_hash: string;
        }>);
        const legacy: HistoryRow[] = [];
        const legacyPairs: Map<string, string> = new Map(), legacyRawHashes: Map<string, string> = new Map();
        const getRaw = db.prepare("SELECT CASE WHEN length(CAST(raw_json AS BLOB))<=65536 THEN raw_json END raw_json FROM market_signal_history WHERE row_id=?");
        for (const [id, sha] of dbMap)
            if (!find.get(id)) {
                if (legacy.length >= 1000)
                    fail("LEGACY_RECOVERY_BUDGET");
                const r = getRaw.get(id) as {
                    raw_json: string | null;
                } | undefined;
                if (typeof r?.raw_json !== "string")
                    fail("LEGACY_RAW_UNAVAILABLE");
                const parsed = legacyFromSaved(r.raw_json, id, sha);
                if (!pins.some(p => p.name === `zao_signals_${parsed.shardMonth}.csv`))
                    fail("LEGACY_TARGET_SHARD_NOT_PINNED");
                legacy.push(parsed);
                legacyPairs.set(id, sha);
                legacyRawHashes.set(id, hash(r.raw_json));
            }
        const union = new Map(dbMap);
        for (const r of stage.prepare("SELECT row_id,row_hash FROM history").iterate() as Iterable<{
            row_id: string;
            row_hash: string;
        }>)
            union.set(r.row_id, r.row_hash);
        const releaseGitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" }).trim();
        if (!/^[0-9a-f]{40}$/u.test(releaseGitSha))
            fail("CODE_RELEASE_UNKNOWN");
        const base = { kind: "ZMI_MIRROR_RECOVERY_PLAN_V1" as const, releaseGitSha, dbIdentitySha256: mapDigest(dbMap), historyIdentitySha256: historySha, unionIdentitySha256: mapDigest(union), historyRows: count, dbRows: dbMap.size,
            historyOnly: missing, dbOnly: legacy.length, recoverableLegacyRows: legacy.length, legacyIdentitySha256: mapDigest(legacyPairs), legacySavedJsonSha256: mapDigest(legacyRawHashes), pins: [...pins].map(p => Object.freeze({ ...p })), originalSourceAuthenticity: "NOT_ESTABLISHED" as const };
        const plan = { ...base, planSha256: hash(JSON.stringify(base)) };
        Object.freeze(plan.pins);
        Object.freeze(plan);
        const result = { plan, legacyRows: Object.freeze(legacy.map(r => Object.freeze(r))), close: () => {
                if (genuine.delete(result))
                    stage.close();
            } };
        genuine.set(result, { historyDir: dir, sourceDatabase: db, legacyPublished: legacy.length === 0, stage, dbHashes: dbMap, sourceUnchanged,
            legacyUnchanged(): void { for (const [id, sha] of legacyRawHashes) {
                const r = getRaw.get(id) as {
                    raw_json: string | null;
                } | undefined;
                if (typeof r?.raw_json !== "string" || hash(r.raw_json) !== sha)
                    fail("LEGACY_SAVED_JSON_CHANGED");
            } },
            admitOwnPublication(path: string): void {
                const next = [...new Set([...expectedNames.split("|"), basename(path)])].sort().join("|");
                if (inventory() !== next)
                    fail("SOURCE_UNIVERSE_CHANGED");
                expectedNames = next;
                stamps.set(path, stamp(path));
            } });
        return Object.freeze(result);
    }
    catch (e) {
        stage.close();
        throw e;
    }
}
function acceptance(prepared: PreparedMirrorRecovery, a: MirrorRecoveryAcceptance, purpose: MirrorRecoveryAcceptance["purpose"]): Context {
    const ctx = genuine.get(prepared);
    if (!ctx || !a || a.purpose !== purpose || a.planSha256 !== prepared.plan.planSha256 || a.releaseGitSha !== prepared.plan.releaseGitSha || !/^[0-9a-f]{40}$/u.test(a.releaseGitSha) || !REF.test(a.tdAcceptanceRef) || !REF.test(a.ownerApprovalRef))
        return fail("EXPLICIT_ACCEPTANCE_REQUIRED");
    return ctx;
}
function syncDirectory(path: string): void { const fd = openSync(path, "r"); try {
    fsyncSync(fd);
}
finally {
    closeSync(fd);
} }
/** An interrupted write can leave only a unique orphan; final names never expose partial bytes. */
function publishExclusive(path: string, body: Buffer | string): void {
    const tmp = `${path}.pending_${randomUUID()}`, fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, body);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    linkSync(tmp, path);
    syncDirectory(dirname(path));
    unlinkSync(tmp);
    syncDirectory(dirname(path));
}
function appendImage(before: Buffer, rows: readonly HistoryRow[]): {
    after: Buffer;
    added: number;
} {
    const table = parseCsvTable(before.toString("utf8"));
    if (JSON.stringify(table.headers) !== JSON.stringify(HISTORY_CSV_HEADERS))
        fail("LEGACY_SHARD_SCHEMA_MISMATCH");
    const present = new Map(table.rows.map(r => [r["row_id"], r["row_hash"]]));
    const fresh = rows.filter(r => { const old = present.get(r.rowId); if (old !== undefined && old !== r.rowHash)
        fail("LEGACY_HISTORY_CONFLICT"); return old === undefined; })
        .sort((a, b) => Buffer.compare(Buffer.from(a.rowId), Buffer.from(b.rowId)));
    if (fresh.length === 0)
        return { after: before, added: 0 };
    const rendered = renderHistoryCsv(fresh), body = rendered.slice(rendered.indexOf("\n") + 1);
    const after = Buffer.concat([before, Buffer.from(before.length > 0 && before[before.length - 1] !== 10 ? "\n" : ""), Buffer.from(body)]);
    if (after.length > 32 * 1024 * 1024)
        fail("PUBLISHED_SHARD_BYTE_BUDGET");
    return { after, added: fresh.length };
}
function stageLegacy(prepared: PreparedMirrorRecovery, ctx: Context): void {
    ctx.stage.transaction(() => {
        const insert = ctx.stage.prepare("INSERT INTO history VALUES(?,?,?)");
        for (const row of prepared.legacyRows) {
            const raw = parseCsvTable(renderHistoryCsv([row])).rows[0]!;
            insert.run(row.rowId, row.rowHash, JSON.stringify(raw));
        }
        if (digestRows(ctx.stage.prepare("SELECT row_id,row_hash FROM history ORDER BY row_id COLLATE BINARY").iterate() as Iterable<{
            row_id: string;
            row_hash: string;
        }>) !== prepared.plan.unionIdentitySha256)
            fail("PUBLICATION_UNION_MISMATCH");
    })();
    ctx.legacyPublished = true;
}
export function persistMirrorRecoveryPlan(prepared: PreparedMirrorRecovery, a: MirrorRecoveryAcceptance, backupDir: string, lock: MirrorRecoveryLock): void {
    const ctx = acceptance(prepared, a, "MIRROR_RECONCILIATION");
    requireLock(lock, ctx.historyDir);
    ctx.sourceUnchanged();
    ctx.legacyUnchanged();
    mkdirSync(backupDir, { recursive: true });
    const backup = realpathSync(backupDir);
    if (backup === ctx.historyDir)
        fail("BACKUP_MUST_BE_SEPARATE");
    const path = join(backup, `recovery_plan_${prepared.plan.planSha256}.json`), body = JSON.stringify(prepared.plan);
    if (existsSync(path)) {
        if (readFileSync(path, "utf8") !== body)
            fail("PLAN_MANIFEST_CONFLICT");
    }
    else
        publishExclusive(path, body);
    const owned = ownedLocks.get(lock)!, receipt = join(backup, `execution_lock_${prepared.plan.planSha256}.json`);
    // The latest acquisition pointer is atomically replaced only while owning both locks.
    const content = JSON.stringify({ kind: "ZMI_RECOVERY_LOCK_V1", planSha256: prepared.plan.planSha256, body: owned.body });
    const tmp = `${receipt}.pending_${randomUUID()}`, fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, content);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, receipt);
    syncDirectory(backup);
}
export function readPersistedMirrorRecoveryPlan(backupDir: string, a: MirrorRecoveryAcceptance): MirrorRecoveryPlan {
    if (a.purpose !== "MIRROR_RECONCILIATION" || !/^[0-9a-f]{64}$/u.test(a.planSha256) || !REF.test(a.tdAcceptanceRef) || !REF.test(a.ownerApprovalRef))
        fail("RESUME_ACCEPTANCE");
    const manifest = join(backupDir, `recovery_plan_${a.planSha256}.json`);
    if (statSync(manifest).size > 128 * 1024)
        fail("RESUME_MANIFEST_BUDGET");
    const saved = JSON.parse(readFileSync(manifest, "utf8")) as MirrorRecoveryPlan;
    const { planSha256, ...base } = saved;
    if (saved.kind !== "ZMI_MIRROR_RECOVERY_PLAN_V1" || planSha256 !== a.planSha256 || hash(JSON.stringify(base)) !== a.planSha256 || saved.releaseGitSha !== a.releaseGitSha || !Array.isArray(saved.pins) || saved.pins.length > 240)
        fail("RESUME_MANIFEST");
    return saved;
}
/** Reconstruct only this accepted plan's original inputs. Third-state files or DB edits refuse; no guessed cleanup. */
export function resumeMirrorRecovery(db: Database.Database, historyDir: string, backupDir: string, a: MirrorRecoveryAcceptance, key: Buffer, lock: MirrorRecoveryLock): PreparedMirrorRecovery {
    const dir = realpathSync(historyDir);
    requireLock(lock, dir);
    const saved = readPersistedMirrorRecoveryPlan(backupDir, a);
    const originals = new Map<string, Buffer>(), expectedCurrent = new Map<string, string>();
    for (const pin of saved.pins) {
        if (!/^zao_signals_\d{4}_\d{2}\.csv$/u.test(pin.name) || !/^[0-9a-f]{64}$/u.test(pin.sha256))
            fail("RESUME_PIN");
        const path = join(dir, pin.name);
        if (statSync(path).size > 32 * 1024 * 1024)
            fail("RESUME_SHARD_BUDGET");
        const currentSha = hash(readFileSync(path));
        expectedCurrent.set(pin.name, currentSha);
        if (currentSha === pin.sha256)
            continue;
        const receiptPath = join(backupDir, `${pin.name}.${a.planSha256}.json`);
        if (statSync(receiptPath).size > 4096)
            fail("RESUME_RECEIPT_BUDGET");
        const r = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
        if (r.kind !== "ZMI_LEGACY_HISTORY_PUBLICATION_V1" || r.planSha256 !== a.planSha256 || r.shard !== pin.name || r.beforeSha256 !== pin.sha256
            || r.afterSha256 !== currentSha || r.sourceDbIdentitySha256 !== saved.dbIdentitySha256)
            fail("RESUME_RECEIPT");
        const encryptedPath = join(backupDir, `${pin.name}.before_${pin.sha256}.aesgcm`);
        if (statSync(encryptedPath).size > 45 * 1024 * 1024)
            fail("RESUME_BACKUP_BUDGET");
        originals.set(pin.name, decryptMirrorBackup(readFileSync(encryptedPath), key, { planSha256: a.planSha256, shard: pin.name, beforeSha256: pin.sha256 }));
    }
    let originalDb: Map<string, string> | undefined;
    const actual = dbHashes(db), journal = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_mirror_reconciliations'").get();
    if (journal) {
        const r = db.prepare("SELECT state,release_sha,td_ref,owner_ref FROM market_mirror_reconciliations WHERE plan_sha=?").get(a.planSha256) as {
            state: string;
            release_sha: string;
            td_ref: string;
            owner_ref: string;
        } | undefined;
        if (r) {
            if (r.state !== "APPLIED" || r.release_sha !== a.releaseGitSha || r.td_ref !== a.tdAcceptanceRef || r.owner_ref !== a.ownerApprovalRef || mapDigest(actual) !== saved.unionIdentitySha256)
                fail("RESUME_APPLIED_DB_CHANGED");
            originalDb = new Map(actual);
            let n = 0;
            for (const inserted of db.prepare("SELECT row_id,row_hash FROM market_mirror_reconciliation_rows WHERE plan_sha=? LIMIT 200001").iterate(a.planSha256) as Iterable<{
                row_id: string;
                row_hash: string;
            }>) {
                if (++n > 200000 || actual.get(inserted.row_id) !== inserted.row_hash)
                    fail("RESUME_JOURNAL_ROWS");
                originalDb.delete(inserted.row_id);
            }
            if (n !== saved.historyOnly || mapDigest(originalDb) !== saved.dbIdentitySha256)
                fail("RESUME_ORIGINAL_DB_MISMATCH");
        }
    }
    const prepared = prepareInternal(db, dir, saved.pins, { originals, expectedCurrent, ...(originalDb ? { originalDb } : {}) });
    try {
        if (JSON.stringify(prepared.plan) !== JSON.stringify(saved))
            fail("RESUME_PLAN_CHANGED");
        for (const [name, before] of originals) {
            const rows = prepared.legacyRows.filter(r => `zao_signals_${r.shardMonth}.csv` === name), expected = appendImage(before, rows);
            if (expected.added === 0 || hash(expected.after) !== expectedCurrent.get(name))
                fail("RESUME_UNAPPROVED_PUBLICATION");
        }
        if (originalDb) {
            for (const row of prepared.legacyRows)
                if (!originals.has(`zao_signals_${row.shardMonth}.csv`))
                    fail("RESUME_DB_BEFORE_HISTORY");
        }
        if (prepared.legacyRows.every(r => originals.has(`zao_signals_${r.shardMonth}.csv`)))
            stageLegacy(prepared, genuine.get(prepared)!);
        return prepared;
    }
    catch (e) {
        prepared.close();
        throw e;
    }
}
/** Restore only saved, re-hashed legacy rows under the same exact recovery acceptance. Collection time is preserved.
 * Successful per-file publication is retained if the later DB phase fails; no historical rows are deleted.
 * Each file is atomically published with encrypted original-byte backup and an immutable metadata receipt.
 */
export function publishRecoveredLegacyHistory(prepared: PreparedMirrorRecovery, a: MirrorRecoveryAcceptance, backupDir: string, backupKey: Buffer, lock: MirrorRecoveryLock): {
    appended: number;
    touchedShards: number;
} {
    const ctx = acceptance(prepared, a, "MIRROR_RECONCILIATION");
    requireLock(lock, ctx.historyDir);
    ctx.sourceUnchanged();
    ctx.legacyUnchanged();
    if (ctx.sourceDatabase.readonly)
        fail("WRITABLE_TARGET_REQUIRED");
    if (backupKey.length !== 32)
        fail("ENCRYPTED_BACKUP_KEY_REQUIRED");
    if (ctx.legacyPublished)
        return { appended: 0, touchedShards: 0 };
    if (mapDigest(dbHashes(ctx.sourceDatabase)) !== prepared.plan.dbIdentitySha256)
        fail("DB_CHANGED");
    mkdirSync(backupDir, { recursive: true });
    const backup = realpathSync(backupDir);
    if (backup === ctx.historyDir)
        fail("BACKUP_MUST_BE_SEPARATE");
    persistMirrorRecoveryPlan(prepared, a, backup, lock);
    const groups = new Map<string, HistoryRow[]>();
    for (const row of prepared.legacyRows) {
        const list = groups.get(row.shardMonth) ?? [];
        list.push(row);
        groups.set(row.shardMonth, list);
    }
    let appended = 0, touched = 0;
    for (const [month, rows] of groups) {
        if (!/^\d{4}_\d{2}$/u.test(month))
            fail("LEGACY_SHARD_INVALID");
        const name = `zao_signals_${month}.csv`, path = join(ctx.historyDir, name);
        if (existsSync(path) && lstatSync(path).isSymbolicLink())
            fail("LINKED_SHARD_PUBLICATION_UNSUPPORTED");
        const before = existsSync(path) ? readFileSync(path) : Buffer.from(HISTORY_CSV_HEADERS.join(",") + "\n");
        const { after, added } = appendImage(before, rows);
        if (added === 0)
            continue;
        const beforeSha = hash(before), afterSha = hash(after), beforePath = join(backup, `${name}.before_${beforeSha}.aesgcm`);
        const backupContext = { planSha256: prepared.plan.planSha256, shard: name, beforeSha256: beforeSha };
        if (existsSync(beforePath)) {
            if (hash(decryptMirrorBackup(readFileSync(beforePath), backupKey, backupContext)) !== beforeSha)
                fail("BACKUP_CONFLICT");
        }
        else
            publishExclusive(beforePath, encryptMirrorBackup(before, backupKey, backupContext));
        if (hash(decryptMirrorBackup(readFileSync(beforePath), backupKey, backupContext)) !== beforeSha)
            fail("BACKUP_READBACK");
        const receipt = JSON.stringify({ kind: "ZMI_LEGACY_HISTORY_PUBLICATION_V1", planSha256: prepared.plan.planSha256, sourceDbIdentitySha256: prepared.plan.dbIdentitySha256,
            shard: name, beforeSha256: beforeSha, afterSha256: afterSha, rowsAdded: added, origin: "SAVED_DB_JSON_REHASHED", independentOriginalSourceAuthenticity: "NOT_ESTABLISHED" });
        const receiptPath = join(backup, `${name}.${prepared.plan.planSha256}.json`);
        if (existsSync(receiptPath)) {
            if (readFileSync(receiptPath, "utf8") !== receipt)
                fail("RECEIPT_CONFLICT");
        }
        else
            publishExclusive(receiptPath, receipt);
        const backupDirectory = openSync(backup, "r");
        try {
            fsyncSync(backupDirectory);
        }
        finally {
            closeSync(backupDirectory);
        }
        const tmp = `${path}.recovery_${prepared.plan.planSha256}_${randomUUID()}.tmp`;
        const fd = openSync(tmp, "wx", 0o600);
        try {
            writeFileSync(fd, after);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        ctx.sourceUnchanged();
        ctx.legacyUnchanged();
        requireLock(lock, ctx.historyDir);
        renameSync(tmp, path);
        const directory = openSync(ctx.historyDir, "r");
        try {
            fsyncSync(directory);
        }
        finally {
            closeSync(directory);
        }
        if (hash(readFileSync(path)) !== afterSha)
            fail("PUBLICATION_READBACK_MISMATCH");
        ctx.admitOwnPublication(path);
        appended += added;
        touched++;
    }
    stageLegacy(prepared, ctx);
    ctx.sourceUnchanged();
    return { appended, touchedShards: touched };
}
/** Database phase only. Any legacy publication must finish under this genuine prepared context before applying.
 * Existing natural mirror guards are not weakened; this separate explicit recovery is bounded by its exact plan.
 */
export function applyMirrorDatabaseRecovery(db: Database.Database, prepared: PreparedMirrorRecovery, a: MirrorRecoveryAcceptance, at: string, lock: MirrorRecoveryLock): {
    state: string;
    inserted: number;
    mirrorExact: boolean;
} {
    const ctx = acceptance(prepared, a, "MIRROR_RECONCILIATION");
    requireLock(lock, ctx.historyDir);
    if (db !== ctx.sourceDatabase)
        fail("TARGET_DATABASE_CHANGED");
    if (!ctx.legacyPublished)
        fail("LEGACY_HISTORY_PUBLICATION_REQUIRED");
    if (!Number.isFinite(Date.parse(at)))
        fail("TIME_INVALID");
    return db.transaction(() => {
        const hasJournal = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='market_mirror_reconciliations'").get();
        if (hasJournal) {
            const previous = db.prepare("SELECT state,inserted_rows FROM market_mirror_reconciliations WHERE plan_sha=?").get(prepared.plan.planSha256) as {
                state: string;
                inserted_rows: number;
            } | undefined;
            if (previous?.state === 'APPLIED') {
                const drift = db.prepare(`SELECT 1 FROM market_mirror_reconciliation_rows r LEFT JOIN market_signal_history h ON h.row_id=r.row_id WHERE r.plan_sha=? AND (h.row_id IS NULL OR h.row_hash!=r.row_hash) LIMIT 1`).get(prepared.plan.planSha256);
                if (drift)
                    fail("APPLIED_ROWS_CHANGED");
                ctx.sourceUnchanged();
                return { state: "ALREADY_APPLIED", inserted: 0, mirrorExact: mapDigest(dbHashes(db)) === prepared.plan.unionIdentitySha256 };
            }
            if (previous)
                fail("PLAN_ALREADY_RECORDED");
        }
        if (mapDigest(dbHashes(db)) !== prepared.plan.dbIdentitySha256)
            fail("DB_CHANGED");
        ctx.sourceUnchanged();
        db.exec(`CREATE TABLE IF NOT EXISTS market_mirror_reconciliations(plan_sha TEXT PRIMARY KEY,release_sha TEXT NOT NULL,td_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL,inserted_rows INTEGER NOT NULL,history_dir_sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS market_mirror_reconciliation_rows(plan_sha TEXT NOT NULL,row_id TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(plan_sha,row_id));
      CREATE TABLE IF NOT EXISTS market_mirror_reconciliation_rollbacks(plan_sha TEXT PRIMARY KEY,release_sha TEXT NOT NULL,td_ref TEXT NOT NULL,owner_ref TEXT NOT NULL,rolled_back_at TEXT NOT NULL,removed_rows INTEGER NOT NULL);`);
        if (db.prepare("SELECT 1 FROM market_mirror_reconciliations WHERE plan_sha=?").get(prepared.plan.planSha256))
            fail("PLAN_ALREADY_RECORDED");
        const journal = db.prepare("INSERT INTO market_mirror_reconciliation_rows VALUES(?,?,?)");
        let inserted = 0, batch = 0;
        let chunk: ReturnType<typeof mapHistoryRowToMarketSignalHistoryRow>[] = [];
        const flush = (): void => {
            if (chunk.length === 0)
                return;
            const r = applyRealSync({ db, runId: `recovery_${prepared.plan.planSha256.slice(0, 20)}_${batch++}`, generatedAtJst: at, reportPath: "EXPLICIT_MIRROR_RECOVERY", sourceHistoryFiles: prepared.plan.pins.map(p => p.name), rows: chunk });
            if (r.conflict_rows !== 0 || r.inserted_rows !== chunk.length)
                fail("INSERT_READBACK_MISMATCH");
            for (const row of chunk)
                journal.run(prepared.plan.planSha256, row.row_id, row.row_hash);
            inserted += r.inserted_rows;
            chunk = [];
        };
        for (const r of ctx.stage.prepare("SELECT row_id,row_hash,raw_json FROM history ORDER BY row_id COLLATE BINARY").iterate() as Iterable<{
            row_id: string;
            row_hash: string;
            raw_json: string;
        }>) {
            if (ctx.dbHashes.has(r.row_id))
                continue;
            chunk.push(mapHistoryRowToMarketSignalHistoryRow(JSON.parse(r.raw_json), at));
            if (chunk.length >= 500)
                flush();
        }
        flush();
        ctx.sourceUnchanged();
        ctx.legacyUnchanged();
        requireLock(lock, ctx.historyDir);
        if (mapDigest(dbHashes(db)) !== prepared.plan.unionIdentitySha256)
            fail("POST_MIRROR_MISMATCH");
        db.prepare("INSERT INTO market_mirror_reconciliations VALUES(?,?,?,?,?,'APPLIED',?,?)").run(prepared.plan.planSha256, a.releaseGitSha, a.tdAcceptanceRef, a.ownerApprovalRef, at, inserted, hash(ctx.historyDir));
        return { state: "APPLIED", inserted, mirrorExact: true };
    }).immediate();
}
/** Exact insert-set rollback only. Original DB rows and any later natural inserts are never removed. */
export function rollbackMirrorDatabaseRecovery(db: Database.Database, recordedPlanSha: string, a: MirrorRecoveryAcceptance, lock: MirrorRecoveryLock): number {
    if (!a || a.purpose !== "MIRROR_RECONCILIATION_ROLLBACK" || a.planSha256 !== recordedPlanSha || !/^[0-9a-f]{64}$/u.test(recordedPlanSha)
        || !/^[0-9a-f]{40}$/u.test(a.releaseGitSha) || !REF.test(a.tdAcceptanceRef) || !REF.test(a.ownerApprovalRef) || !ownedLocks.has(lock))
        fail("EXPLICIT_ROLLBACK_ACCEPTANCE_REQUIRED");
    requireLock(lock, lock.historyDir);
    return db.transaction(() => {
        const record = db.prepare("SELECT state,release_sha,history_dir_sha FROM market_mirror_reconciliations WHERE plan_sha=?").get(recordedPlanSha) as {
            state: string;
            release_sha: string;
            history_dir_sha: string;
        } | undefined;
        if (record?.state !== "APPLIED" || record.release_sha !== a.releaseGitSha || record.history_dir_sha !== hash(lock.historyDir))
            fail("ROLLBACK_NOT_APPLIED_OR_WRONG_TARGET");
        const drift = db.prepare(`SELECT 1 FROM market_mirror_reconciliation_rows r LEFT JOIN market_signal_history h ON h.row_id=r.row_id
          WHERE r.plan_sha=? AND (h.row_id IS NULL OR h.row_hash!=r.row_hash) LIMIT 1`).get(recordedPlanSha);
        if (drift)
            fail("ROLLBACK_ROW_CHANGED");
        const n = db.prepare("DELETE FROM market_signal_history WHERE row_id IN (SELECT row_id FROM market_mirror_reconciliation_rows WHERE plan_sha=?)").run(recordedPlanSha).changes;
        db.prepare("INSERT INTO market_mirror_reconciliation_rollbacks VALUES(?,?,?,?,?,?)").run(recordedPlanSha, a.releaseGitSha, a.tdAcceptanceRef, a.ownerApprovalRef, new Date().toISOString(), n);
        db.prepare("UPDATE market_mirror_reconciliations SET state='ROLLED_BACK' WHERE plan_sha=?").run(recordedPlanSha);
        return n;
    }).immediate();
}
