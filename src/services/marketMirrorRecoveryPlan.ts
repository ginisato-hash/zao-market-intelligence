// Explicit recovery primitive, never called by natural collectors. No flag/guard overrides.
// Source capture is bounded to pinned monthly shards; DB-only history is retained for separate reviewed recovery.
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
export interface MirrorRecoveryLock { readonly historyDir: string; }
const ownedLocks = new WeakMap<object,{path:string;body:string}>();
export function withMirrorRecoveryLock<T>(historyDir: string, work: (lock: MirrorRecoveryLock) => T): T {
    const dir = realpathSync(historyDir), path = join(dirname(dir), "locks", "history_writer.lock.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path), token = Object.freeze({ historyDir: dir });
    const legacyPath=join(dir,APPEND_LOCK_FILENAME),body=`recovery_${randomUUID()}\n${new Date().toISOString()}\npid=${process.pid}\nhost=${hostname()}\n`;
    let ownsLegacy=false;
    try {
        db.pragma("busy_timeout=30000"); db.exec("BEGIN EXCLUSIVE");
        if (existsSync(join(dir, APPEND_LOCK_FILENAME))) fail("LEGACY_APPEND_LOCK_PRESENT");
        const fd=openSync(legacyPath,"wx",0o600);try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}ownsLegacy=true;
        ownedLocks.set(token,{path:legacyPath,body});
        const result = work(token); if (result instanceof Promise) fail("SYNCHRONOUS_LOCK_SCOPE_REQUIRED");
        return result;
    } finally { ownedLocks.delete(token); if(ownsLegacy && existsSync(legacyPath) && readFileSync(legacyPath,"utf8")===body)unlinkSync(legacyPath); if (db.inTransaction) db.exec("ROLLBACK"); db.close(); }
}
function requireLock(lock: MirrorRecoveryLock, dir: string): void {
    const owned=ownedLocks.get(lock);
    if (!owned || lock.historyDir !== dir || !existsSync(owned.path) || readFileSync(owned.path,"utf8")!==owned.body) fail("CANONICAL_HISTORY_LOCK_REQUIRED");
}
interface Context {
    historyDir: string;
    sourceDatabase: Database.Database;
    legacyPublished: boolean;
    admitOwnPublication(path: string): void;
    stage: Database.Database;
    dbHashes: Map<string, string>;
    sourceUnchanged(): void;
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
    if (pins.length === 0 || pins.length > 240 || new Set(pins.map(p => p.name)).size !== pins.length)
        fail("SHARD_BUDGET");
    const dir = realpathSync(historyDir), dbMap = dbHashes(db), stage = new Database(":memory:");
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
            const raw = readFileSync(path);
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
                    const parsed=historyRowFromCsvRecord(HISTORY_CSV_HEADERS.map(k=>row[k]??""));
                    if(parsed.shardMonth!==pin.name.slice(12,-4) || parsed.shardMonth!==shardMonthFromCheckin(parsed.checkin)
                       || buildRowId(parsed)!==row["row_id"] || buildRowHash(parsed)!==row["row_hash"])fail("HISTORY_CONTENT_HASH_OR_SHARD");
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
        const sourceUnchanged = (): void => { if (inventory() !== expectedNames)
            fail("SOURCE_UNIVERSE_CHANGED"); for (const [p, s] of stamps)
            if (stamp(p) !== s)
                fail("SOURCE_CHANGED"); };
        sourceUnchanged();
        const historySha = digestRows(stage.prepare("SELECT row_id,row_hash FROM history ORDER BY row_id COLLATE BINARY").iterate() as Iterable<{
            row_id: string;
            row_hash: string;
        }>);
        const legacy: HistoryRow[] = [];
        const legacyPairs: Map<string, string> = new Map();
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
                legacy.push(parsed);
                legacyPairs.set(id, sha);
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
            historyOnly: missing, dbOnly: legacy.length, recoverableLegacyRows: legacy.length, legacyIdentitySha256: mapDigest(legacyPairs), pins: [...pins].map(p => Object.freeze({ ...p })), originalSourceAuthenticity: "NOT_ESTABLISHED" as const };
        const plan = { ...base, planSha256: hash(JSON.stringify(base)) };
        Object.freeze(plan.pins);
        Object.freeze(plan);
        const result = { plan, legacyRows: Object.freeze(legacy.map(r => Object.freeze(r))), close: () => { if (genuine.delete(result))
                stage.close(); } };
        genuine.set(result, { historyDir: dir, sourceDatabase: db, legacyPublished: legacy.length === 0, stage, dbHashes: dbMap, sourceUnchanged,
            admitOwnPublication(path: string): void {
                const next = [...new Set([...expectedNames.split("|"), basename(path)])].sort().join("|");
                if (inventory() !== next) fail("SOURCE_UNIVERSE_CHANGED");
                expectedNames = next; stamps.set(path, stamp(path));
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
/** Restore only saved, re-hashed legacy rows under the same exact recovery acceptance. Collection time is preserved.
 * Successful per-file publication is retained if the later DB phase fails; no historical rows are deleted.
 * Each file is atomically published with encrypted original-byte backup and an immutable metadata receipt.
 */
export function publishRecoveredLegacyHistory(prepared: PreparedMirrorRecovery, a: MirrorRecoveryAcceptance,
    backupDir: string, backupKey: Buffer, lock: MirrorRecoveryLock): { appended: number; touchedShards: number } {
    const ctx = acceptance(prepared, a, "MIRROR_RECONCILIATION"); requireLock(lock, ctx.historyDir);
    if (mapDigest(dbHashes(ctx.sourceDatabase)) !== prepared.plan.dbIdentitySha256) fail("DB_CHANGED");
    ctx.sourceUnchanged();
    if (ctx.sourceDatabase.readonly) fail("WRITABLE_TARGET_REQUIRED");
    if (backupKey.length !== 32) fail("ENCRYPTED_BACKUP_KEY_REQUIRED");
    if (ctx.legacyPublished) return { appended: 0, touchedShards: 0 };
    mkdirSync(backupDir, { recursive: true }); const backup = realpathSync(backupDir);
    if (backup === ctx.historyDir) fail("BACKUP_MUST_BE_SEPARATE");
    const groups = new Map<string, HistoryRow[]>();
    for (const row of prepared.legacyRows) { const list = groups.get(row.shardMonth) ?? []; list.push(row); groups.set(row.shardMonth, list); }
    let appended = 0, touched = 0;
    for (const [month, rows] of groups) {
        if (!/^\d{4}_\d{2}$/u.test(month)) fail("LEGACY_SHARD_INVALID");
        const name = `zao_signals_${month}.csv`, path = join(ctx.historyDir, name);
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail("LINKED_SHARD_PUBLICATION_UNSUPPORTED");
        const before = existsSync(path) ? readFileSync(path) : Buffer.from(HISTORY_CSV_HEADERS.join(",") + "\n");
        const table = parseCsvTable(before.toString("utf8"));
        if (JSON.stringify(table.headers) !== JSON.stringify(HISTORY_CSV_HEADERS)) fail("LEGACY_SHARD_SCHEMA_MISMATCH");
        const present = new Map(table.rows.map(r => [r["row_id"],r["row_hash"]]));
        const fresh = rows.filter(r => { const found = present.get(r.rowId); if (found !== undefined && found !== r.rowHash) fail("LEGACY_HISTORY_CONFLICT"); return found === undefined; });
        if (fresh.length === 0) continue;
        const rendered = renderHistoryCsv(fresh), body = rendered.slice(rendered.indexOf("\n") + 1);
        const after = Buffer.concat([before, Buffer.from(before.length > 0 && before[before.length-1] !== 10 ? "\n" : ""), Buffer.from(body)]);
        const beforeSha = hash(before), afterSha = hash(after), beforePath = join(backup, `${name}.before_${beforeSha}.aesgcm`);
        const backupContext = { planSha256: prepared.plan.planSha256, shard: name, beforeSha256: beforeSha };
        if (existsSync(beforePath)) { if (hash(decryptMirrorBackup(readFileSync(beforePath), backupKey, backupContext)) !== beforeSha) fail("BACKUP_CONFLICT"); }
        else { const fd = openSync(beforePath,"wx",0o600); try { writeFileSync(fd,encryptMirrorBackup(before, backupKey, backupContext)); fsyncSync(fd); } finally { closeSync(fd); } }
        if (hash(decryptMirrorBackup(readFileSync(beforePath), backupKey, backupContext)) !== beforeSha) fail("BACKUP_READBACK");
        const receipt = JSON.stringify({kind:"ZMI_LEGACY_HISTORY_PUBLICATION_V1",planSha256:prepared.plan.planSha256,sourceDbIdentitySha256:prepared.plan.dbIdentitySha256,
            shard:name,beforeSha256:beforeSha,afterSha256:afterSha,rowsAdded:fresh.length,origin:"SAVED_DB_JSON_REHASHED",independentOriginalSourceAuthenticity:"NOT_ESTABLISHED"});
        const receiptPath = join(backup,`${name}.${prepared.plan.planSha256}.json`);
        if (existsSync(receiptPath)) { if (readFileSync(receiptPath,"utf8") !== receipt) fail("RECEIPT_CONFLICT"); }
        else { const fd = openSync(receiptPath,"wx",0o600); try { writeFileSync(fd,receipt); fsyncSync(fd); } finally { closeSync(fd); } }
        const backupDirectory = openSync(backup,"r"); try { fsyncSync(backupDirectory); } finally { closeSync(backupDirectory); }
        const tmp = `${path}.recovery_${prepared.plan.planSha256}.tmp`;
        if (existsSync(tmp)) { if (hash(readFileSync(tmp)) !== afterSha) fail("STAGING_CONFLICT"); }
        else { const fd = openSync(tmp,"wx",0o600); try { writeFileSync(fd,after); fsyncSync(fd); } finally { closeSync(fd); } }
        ctx.sourceUnchanged(); requireLock(lock,ctx.historyDir);
        renameSync(tmp,path); const directory = openSync(ctx.historyDir,"r"); try { fsyncSync(directory); } finally { closeSync(directory); }
        if (hash(readFileSync(path)) !== afterSha) fail("PUBLICATION_READBACK_MISMATCH");
        ctx.admitOwnPublication(path); appended += fresh.length; touched++;
    }
    ctx.stage.transaction(() => {
        const insert = ctx.stage.prepare("INSERT INTO history VALUES(?,?,?)");
        for (const row of prepared.legacyRows) {
            const raw = parseCsvTable(renderHistoryCsv([row])).rows[0]!;
            insert.run(row.rowId,row.rowHash,JSON.stringify(raw));
        }
        const observed = digestRows(ctx.stage.prepare("SELECT row_id,row_hash FROM history ORDER BY row_id COLLATE BINARY").iterate() as Iterable<{row_id:string;row_hash:string}>);
        if (observed !== prepared.plan.unionIdentitySha256) fail("PUBLICATION_UNION_MISMATCH");
    })();
    ctx.sourceUnchanged(); ctx.legacyPublished = true;
    return {appended,touchedShards:touched};
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
    if (db !== ctx.sourceDatabase) fail("TARGET_DATABASE_CHANGED");
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
      CREATE TABLE IF NOT EXISTS market_mirror_reconciliation_rows(plan_sha TEXT NOT NULL,row_id TEXT NOT NULL,row_hash TEXT NOT NULL,PRIMARY KEY(plan_sha,row_id));`);
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
        ctx.sourceUnchanged(); requireLock(lock,ctx.historyDir);
        if (mapDigest(dbHashes(db)) !== prepared.plan.unionIdentitySha256)
            fail("POST_MIRROR_MISMATCH");
        db.prepare("INSERT INTO market_mirror_reconciliations VALUES(?,?,?,?,?,'APPLIED',?,?)").run(prepared.plan.planSha256, a.releaseGitSha, a.tdAcceptanceRef, a.ownerApprovalRef, at, inserted, hash(ctx.historyDir));
        return { state: "APPLIED", inserted, mirrorExact: true };
    }).immediate();
}
/** Exact insert-set rollback only. Original DB rows and any later natural inserts are never removed. */
export function rollbackMirrorDatabaseRecovery(db: Database.Database, recordedPlanSha: string, a: MirrorRecoveryAcceptance, lock: MirrorRecoveryLock): number {
    if (!a || a.purpose !== "MIRROR_RECONCILIATION_ROLLBACK" || a.planSha256 !== recordedPlanSha || !/^[0-9a-f]{64}$/u.test(recordedPlanSha)
        || !/^[0-9a-f]{40}$/u.test(a.releaseGitSha) || !REF.test(a.tdAcceptanceRef) || !REF.test(a.ownerApprovalRef) || !ownedLocks.has(lock)) fail("EXPLICIT_ROLLBACK_ACCEPTANCE_REQUIRED");
    requireLock(lock,lock.historyDir);
    return db.transaction(() => {
        const record = db.prepare("SELECT state,release_sha,history_dir_sha FROM market_mirror_reconciliations WHERE plan_sha=?").get(recordedPlanSha) as { state: string; release_sha: string; history_dir_sha: string } | undefined;
        if (record?.state !== "APPLIED" || record.release_sha !== a.releaseGitSha || record.history_dir_sha !== hash(lock.historyDir)) fail("ROLLBACK_NOT_APPLIED_OR_WRONG_TARGET");
        const drift = db.prepare(`SELECT 1 FROM market_mirror_reconciliation_rows r LEFT JOIN market_signal_history h ON h.row_id=r.row_id
          WHERE r.plan_sha=? AND (h.row_id IS NULL OR h.row_hash!=r.row_hash) LIMIT 1`).get(recordedPlanSha);
        if (drift) fail("ROLLBACK_ROW_CHANGED");
        const n = db.prepare("DELETE FROM market_signal_history WHERE row_id IN (SELECT row_id FROM market_mirror_reconciliation_rows WHERE plan_sha=?)").run(recordedPlanSha).changes;
        db.prepare("UPDATE market_mirror_reconciliations SET state='ROLLED_BACK' WHERE plan_sha=?").run(recordedPlanSha);
        return n;
    }).immediate();
}
