import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileMarketMirror } from '../src/scripts/reconcileMarketMirror';
import { HISTORY_CSV_HEADERS, buildRowId, buildRowHash, renderHistoryCsv, type HistoryRow } from '../src/services/localHistorySchemaDesign';
import { parseShardRows } from '../src/services/localHistoryRealAppend';
import { ensureMirrorSchema, applyRealSync } from '../src/services/historyToDbSyncRealRun';
import { parseCsvTable, mapHistoryRowToMarketSignalHistoryRow } from '../src/services/historyToDbSyncDryRun';
import { recoveryBackupKeyFromKeychain } from '../src/services/mirrorRecoveryEncryption';
vi.mock('../src/services/mirrorRecoveryEncryption', async (importOriginal) => { const original = await importOriginal<typeof import('../src/services/mirrorRecoveryEncryption')>(); return { ...original, recoveryBackupKeyFromKeychain: vi.fn(() => { throw new Error('KEYCHAIN_MUST_NOT_RUN'); }) }; });
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
function row(day: string): HistoryRow {
    const raw = Object.fromEntries(HISTORY_CSV_HEADERS.map(k => [k, '']));
    Object.assign(raw, { shard_month: '2027_01', source: 'booking', source_phase: 'fixture', collector_stage: 'fixture', canonical_property_name: 'Fixture', source_property_name: 'Fixture', source_slug_or_code: 'fixture', source_property_id: 'fixture', source_url: 'https://example.test/private-fixture', collected_date_jst: '2026-10-24', collected_at_jst: '2026-10-24T12:00:00+09:00', normalized_at_jst: '2026-10-24T12:00:00+09:00', checkin: `2027-01-${day}`, checkout: `2027-01-${String(Number(day) + 1).padStart(2, '0')}`, stay_nights: '1', group_adults: '2', group_children: '0', no_rooms: '1', currency: 'JPY', language: 'ja', stay_scope: 'one_night', availability_status: 'available', sold_out_status: 'not_sold_out', normalized_total_price: '20000', basis_confidence: 'A', source_classification: 'fixture', is_price_usable_for_dp_direct: 'true', is_price_usable_for_dp_directional: 'false', is_price_excluded_from_dp: 'false', schema_version: 'fixture' });
    const r = parseShardRows(HISTORY_CSV_HEADERS.join(',') + '\n' + HISTORY_CSV_HEADERS.map(k => raw[k]).join(',') + '\n')[0]!;
    r.rowId = buildRowId(r);
    r.rowHash = buildRowHash(r);
    return r;
}
function fixture(legacy = false) {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-operator-')), history = join(dir, 'history');
    const source = join(dir, 'market.sqlite'), db = new Database(source);
    ensureMirrorSchema(db);
    const one = row('01'), two = row('02'), text = renderHistoryCsv([one, two]);
    // The directory is deliberately explicit; the operator never searches for an unknown workspace.
    mkdirSync(history);
    const shard = join(history, 'zao_signals_2027_01.csv');
    writeFileSync(shard, text);
    applyRealSync({ db, runId: 'fixture', generatedAtJst: '2026-10-24T12:00:00+09:00', reportPath: 'fixture', sourceHistoryFiles: [], rows: parseCsvTable(renderHistoryCsv(legacy ? [one, row('03')] : [one])).rows.map(r => mapHistoryRowToMarketSignalHistoryRow(r, '2026-10-24T12:00:00+09:00')) });
    db.close();
    const digest = (rows: HistoryRow[]) => sha(rows.sort((a, b) => Buffer.compare(Buffer.from(a.rowId), Buffer.from(b.rowId))).map(r => r.rowId + '\0' + r.rowHash + '\n').join(''));
    const audit = join(dir, 'audit.json');
    writeFileSync(audit, JSON.stringify({ kind: 'ZMI_MIRROR_IDENTITY_AUDIT_V1', stable: true, history_identity_sha256: digest([one, two]), db_identity_sha256: digest(legacy ? [one, row('03')] : [one]), shards: [{ shard: 'zao_signals_2027_01.csv', raw_bytes_sha256: sha(text), rows: 2 }] }));
    return { dir, source, history, shard, audit };
}
it('operator plan is read-only, excludes saved raw payload, and does not require credentials or a backup key', () => {
    const x = fixture(), before = readFileSync(x.source), csv = readFileSync(x.shard);
    const result = reconcileMarketMirror([`--mode=plan`, `--db=${x.source}`, `--history=${x.history}`, `--audit=${x.audit}`]);
    expect(result).toMatchObject({ historyRows: 2, dbRows: 1, historyOnly: 1, dbOnly: 0, execution: 'PLAN_ONLY', sourceWrites: 0, keychainReads: 0, keychainWrites: 0 });
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    expect(JSON.stringify(result)).not.toContain('raw_json');
    expect(readFileSync(x.source)).toEqual(before);
    expect(readFileSync(x.shard)).toEqual(csv);
    expect(existsSync(x.source + '-shm')).toBe(false);
    expect(existsSync(join(x.history, '.append.lock'))).toBe(false);
});
it('wrong target acceptance and unknown/duplicate arguments refuse before writes', () => {
    expect(() => reconcileMarketMirror(['--mode=plan', '--unknown=x'])).toThrow('ARGUMENTS');
    expect(() => reconcileMarketMirror(['--mode=plan', '--mode=apply'])).toThrow('ARGUMENTS');
    const x = fixture(), before = readFileSync(x.source), a = join(x.dir, 'accept.json');
    writeFileSync(a, JSON.stringify({ releaseGitSha: 'f'.repeat(40), dbPathSha256: 'f'.repeat(64), historyPathSha256: 'f'.repeat(64) }));
    expect(() => reconcileMarketMirror(['--mode=apply', `--db=${x.source}`, `--history=${x.history}`, `--audit=${x.audit}`, `--acceptance=${a}`, `--backup-dir=${x.dir}/backup`])).toThrow('ACCEPTANCE_SOURCE_OR_TARGET');
    expect(readFileSync(x.source)).toEqual(before);
    expect(existsSync(join(x.history, '.append.lock'))).toBe(false);
    expect(existsSync(join(x.dir, 'backup'))).toBe(false);
});
it('rejects missing or invalid source references before lock creation or any Keychain call, including legacy recovery', () => {
    const x = fixture(true), plan = reconcileMarketMirror(['--mode=plan', `--db=${x.source}`, `--history=${x.history}`, `--audit=${x.audit}`]) as Record<string, unknown>;
    expect(plan.dbOnly).toBe(1);
    const file = join(x.dir, 'accept.json'), before = readFileSync(x.source);
    for (const change of [{ ownerApprovalRef: undefined, tdAcceptanceRef: undefined }, { ownerApprovalRef: 'invalid', tdAcceptanceRef: 'invalid' }, { planSha256: 'invalid' }]) {
        writeFileSync(file, JSON.stringify({ ...plan, purpose: 'MIRROR_RECONCILIATION', ownerApprovalRef: 'https://github.com/ginisato-hash/zao-market-intelligence-private/issues/13#issuecomment-9999999999', tdAcceptanceRef: 'https://github.com/ginisato-hash/zao-market-intelligence-private/issues/13#issuecomment-9999999999', ...change }));
        expect(() => reconcileMarketMirror(['--mode=apply', `--db=${x.source}`, `--history=${x.history}`, `--audit=${x.audit}`, `--acceptance=${file}`, `--backup-dir=${x.dir}/backup`])).toThrow('FULL_ACCEPTANCE_REQUIRED');
    }
    expect(vi.mocked(recoveryBackupKeyFromKeychain)).not.toHaveBeenCalled();
    expect(readFileSync(x.source)).toEqual(before);
    expect(existsSync(join(x.history, '.append.lock'))).toBe(false);
    expect(existsSync(join(x.dir, 'backup'))).toBe(false);
});
