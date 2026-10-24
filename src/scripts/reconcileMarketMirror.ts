// Explicit operator tool, never scheduled/imported by collectors. Prints safe metadata only.
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { prepareMirrorRecovery, publishRecoveredLegacyHistory, applyMirrorDatabaseRecovery, rollbackMirrorDatabaseRecovery, withMirrorRecoveryLock, persistMirrorRecoveryPlan, resumeMirrorRecovery, readPersistedMirrorRecoveryPlan, type MirrorRecoveryAcceptance, type PinnedMarketShard } from '../services/marketMirrorRecoveryPlan';
import { openReadOnlyMarketMirror } from '../services/marketMirrorReadOnly';
import { recoveryBackupKeyFromKeychain } from '../services/mirrorRecoveryEncryption';
const refuse = (s: string): never => { throw new Error(`MIRROR_OPERATOR_REFUSED(${s})`); };
const pathSha = (p: string) => createHash('sha256').update(realpathSync(p)).digest('hex');
function argumentsFor(args: string[]): Map<string, string> {
    const options = new Map<string, string>();
    for (const a of args) {
        const match = /^--(mode|db|history|audit|acceptance|backup-dir)=(.+)$/u.exec(a);
        if (!match)
            return refuse('ARGUMENTS');
        if (options.has(match[1]!))
            return refuse('ARGUMENTS');
        options.set(match[1]!, match[2]!);
    }
    for (const k of ['mode', 'db', 'history'])
        if (!options.get(k))
            refuse('MISSING_ARGUMENT');
    if (!['plan', 'apply', 'rollback'].includes(options.get('mode')!))
        refuse('MODE');
    return options;
}
export function reconcileMarketMirror(args: string[]): unknown {
    const o = argumentsFor(args), mode = o.get('mode')!, dbPath = realpathSync(o.get('db')!), historyDir = realpathSync(o.get('history')!);
    const moduleDir = fileURLToPath(new URL('.', import.meta.url));
    const cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: moduleDir, encoding: 'utf8' }).trim();
    const release = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'data/config', 'package.json', 'package-lock.json', 'tsconfig.json'], { cwd, encoding: 'utf8' }).trim();
    if (dirty || !/^[0-9a-f]{40}$/u.test(release))
        refuse('EXACT_CLEAN_SOURCE_REQUIRED');
    const accept = (): MirrorRecoveryAcceptance & {
        dbPathSha256: string;
        historyPathSha256: string;
    } => {
        if (!o.get('acceptance'))
            return refuse('ACCEPTANCE_REQUIRED');
        const a = JSON.parse(readFileSync(o.get('acceptance')!, 'utf8')) as ReturnType<typeof accept>;
        if (a.releaseGitSha !== release || a.dbPathSha256 !== pathSha(dbPath) || a.historyPathSha256 !== pathSha(historyDir))
            return refuse('ACCEPTANCE_SOURCE_OR_TARGET');
        return a;
    };
    if (mode === 'rollback') {
        const a = accept();
        if (a.purpose !== 'MIRROR_RECONCILIATION_ROLLBACK')
            refuse('ROLLBACK_PURPOSE');
        return withMirrorRecoveryLock(historyDir, lock => {
            const db = new Database(dbPath);
            db.pragma('foreign_keys=ON');
            try {
                return { kind: 'ZMI_MIRROR_RECOVERY_ROLLBACK_RESULT_V1', releaseGitSha: release, planSha256: a.planSha256, removedRecoveryRows: rollbackMirrorDatabaseRecovery(db, a.planSha256, a, lock), historyDeletions: 0 };
            }
            finally {
                db.close();
            }
        });
    }
    if (!o.get('audit'))
        return refuse('PINNED_AUDIT_REQUIRED');
    const audit = JSON.parse(readFileSync(o.get('audit')!, 'utf8')) as {
        kind?: string;
        stable?: boolean;
        history_identity_sha256?: string;
        db_identity_sha256?: string;
        shards?: {
            shard: string;
            raw_bytes_sha256: string;
            rows: number;
        }[];
    };
    if (audit.kind !== 'ZMI_MIRROR_IDENTITY_AUDIT_V1' || audit.stable !== true || !Array.isArray(audit.shards))
        return refuse('STABLE_AUDIT_REQUIRED');
    const pins: PinnedMarketShard[] = audit.shards.map(p => ({ name: p.shard, sha256: p.raw_bytes_sha256, rows: p.rows }));
    const check = (p: ReturnType<typeof prepareMirrorRecovery>) => {
        if (p.plan.releaseGitSha !== release || p.plan.historyIdentitySha256 !== audit.history_identity_sha256 || p.plan.dbIdentitySha256 !== audit.db_identity_sha256)
            return refuse('AUDIT_OR_RELEASE_CHANGED');
    };
    if (mode === 'plan') {
        const projected = openReadOnlyMarketMirror(dbPath);
        let prepared: ReturnType<typeof prepareMirrorRecovery> | undefined;
        try {
            prepared = prepareMirrorRecovery(projected.db, historyDir, pins);
            check(prepared);
            projected.assertUnchanged();
            return { ...prepared.plan, dbPathSha256: pathSha(dbPath), historyPathSha256: pathSha(historyDir), execution: 'PLAN_ONLY', sourceWrites: 0, keychainReads: 0, keychainWrites: 0 };
        }
        finally {
            prepared?.close();
            projected.close();
        }
    }
    const a = accept();
    if (a.purpose !== 'MIRROR_RECONCILIATION' || !o.get('backup-dir'))
        return refuse('APPLY_CONTEXT_REQUIRED');
    return withMirrorRecoveryLock(historyDir, lock => {
        const db = new Database(dbPath);
        db.pragma('foreign_keys=ON');
        db.pragma('busy_timeout=30000');
        let prepared: ReturnType<typeof prepareMirrorRecovery> | undefined, key: Buffer | undefined;
        try {
            const manifest = o.get('backup-dir')! + `/recovery_plan_${a.planSha256}.json`;
            if (existsSync(manifest)) {
                const saved = readPersistedMirrorRecoveryPlan(o.get('backup-dir')!, a);
                key = saved.dbOnly === 0 ? Buffer.alloc(0) : recoveryBackupKeyFromKeychain(a.planSha256, false);
                prepared = resumeMirrorRecovery(db, historyDir, o.get('backup-dir')!, a, key, lock);
            }
            else
                prepared = prepareMirrorRecovery(db, historyDir, pins);
            check(prepared);
            if (prepared.plan.planSha256 !== a.planSha256)
                return refuse('PLAN_CHANGED');
            // New Keychain item creation waits for all exact-source/target/plan checks. This task-owned item's creation needs release acceptance.
            if (prepared.plan.dbOnly > 0 && !key)
                key = recoveryBackupKeyFromKeychain(a.planSha256, true);
            persistMirrorRecoveryPlan(prepared, a, o.get('backup-dir')!, lock);
            const publication = prepared.plan.dbOnly > 0 ? publishRecoveredLegacyHistory(prepared, a, o.get('backup-dir')!, key!, lock) : { appended: 0, touchedShards: 0 };
            const applied = applyMirrorDatabaseRecovery(db, prepared, a, new Date().toISOString(), lock);
            return { kind: 'ZMI_MIRROR_RECOVERY_RESULT_V1', releaseGitSha: release, planSha256: a.planSha256, publication, ...applied, originalSourceAuthenticity: 'NOT_ESTABLISHED', mirrorFlagChanged: false, collectorRuns: 0 };
        }
        finally {
            key?.fill(0);
            prepared?.close();
            db.close();
        }
    }, { planSha256: a.planSha256, backupDir: o.get('backup-dir')! });
}
if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        console.log(JSON.stringify(reconcileMarketMirror(process.argv.slice(2)), null, 2));
    }
    catch (e) {
        const reason = /^(?:MIRROR_[A-Z_]+|MARKET_PROJECTION)_REFUSED\(([A-Z_]+)\)$/u.exec((e as Error).message)?.[1] ?? 'READ_OR_WRITE_FAILED';
        console.error(`MIRROR_OPERATOR_REFUSED(${reason})`);
        process.exitCode = 2;
    }
}
