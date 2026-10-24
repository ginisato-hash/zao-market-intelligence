// Local, non-PII RMS -> collector request. It conveys collection priorities, never pricing authority.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { canonicalJson } from './marketEvidenceSidecar';
import { createHash } from 'node:crypto';
import type { PricingQuoteNeed } from './usefulQuoteRefreshPlanner';

export interface RmsQuoteRequest {
    kind: 'K27_MARKET_QUOTE_REQUEST_V1'; propertyId: '330695';
    createdAt: string; expiresAt: string;
    source: { runId: string; releaseGitSha: string; bundleSha256: string; graphSha256: string; evidenceSha256: string; observedAt: string };
    needs: Array<PricingQuoteNeed & { dateEvidenceSha256: string }>;
    requestSha256: string;
}
const instant = (s: unknown) => typeof s === 'string' && /(?:Z|[+-]\d\d:\d\d)$/u.test(s) ? Date.parse(s) : NaN;
const hash = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/u.test(s);
const date = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const keys = (v: object, expected: string[]) => Object.keys(v).sort().join('|') === expected.sort().join('|');
export function validateRmsQuoteRequest(raw: unknown, now: string, accepted: { releaseGitSha: string; bundleSha256: string; graphSha256: string }): RmsQuoteRequest {
    if (!/^[0-9a-f]{40}$/u.test(accepted.releaseGitSha) || !hash(accepted.bundleSha256) || !hash(accepted.graphSha256) || !Number.isFinite(instant(now))) throw Error('RMS_QUOTE_ACCEPTED_SOURCE_REQUIRED');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('RMS_QUOTE_SCHEMA');
    const r = raw as RmsQuoteRequest;
    if (!keys(r, ['kind', 'propertyId', 'createdAt', 'expiresAt', 'source', 'needs', 'requestSha256']) || r.kind !== 'K27_MARKET_QUOTE_REQUEST_V1' || r.propertyId !== '330695'
        || !r.source || typeof r.source !== 'object' || !keys(r.source, ['runId', 'releaseGitSha', 'bundleSha256', 'graphSha256', 'evidenceSha256', 'observedAt'])
        || !/^k27run_\d{4}-\d{2}-\d{2}_[0-9a-f]{8}$/u.test(r.source.runId) || r.source.releaseGitSha !== accepted.releaseGitSha || r.source.bundleSha256 !== accepted.bundleSha256 || r.source.graphSha256 !== accepted.graphSha256
        || !hash(r.source.evidenceSha256) || r.source.observedAt !== r.createdAt || !Array.isArray(r.needs) || r.needs.length > 2000) throw Error('RMS_QUOTE_SCHEMA_OR_SOURCE');
    const at = instant(r.createdAt), expiry = instant(r.expiresAt), current = instant(now);
    if (!Number.isFinite(at) || !Number.isFinite(expiry) || at > current || expiry <= current || expiry <= at || expiry - at > 36 * 3600000) throw Error('RMS_QUOTE_EXPIRED_OR_TIME_INVALID');
    const seen = new Set<string>();
    for (const n of r.needs) {
        if (!n || typeof n !== 'object' || !keys(n, ['stayDate', 'admittedAt', 'priceDecisionEligible', 'decisionImpact', 'changedAt', 'dateEvidenceSha256'])
            || !date(n.stayDate) || seen.has(n.stayDate) || typeof n.priceDecisionEligible !== 'boolean' || !Number.isFinite(instant(n.admittedAt)) || instant(n.admittedAt) > at
            || !Number.isFinite(n.decisionImpact) || n.decisionImpact < 0 || n.decisionImpact > 1 || !hash(n.dateEvidenceSha256)
            || n.changedAt !== null && (!Number.isFinite(instant(n.changedAt)) || instant(n.changedAt) > at || instant(n.changedAt) < instant(n.admittedAt))) throw Error('RMS_QUOTE_NEED_INVALID');
        seen.add(n.stayDate);
    }
    const { requestSha256, ...unsigned } = r;
    if (!hash(requestSha256) || createHash('sha256').update(canonicalJson(unsigned)).digest('hex') !== requestSha256) throw Error('RMS_QUOTE_SEAL');
    return r;
}

/** Fixed configured path, bounded stable read; raw content and absolute paths never enter diagnostics. */
export function readRmsQuoteRequest(path: string, now: string, accepted: Parameters<typeof validateRmsQuoteRequest>[2]) {
    let fd: number | undefined;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 1024n * 1024n) throw Error('BUDGET');
        const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
        if (bytes.length > 1024 * 1024 || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw Error('CHANGED');
        return validateRmsQuoteRequest(JSON.parse(bytes.toString('utf8')), now, accepted);
    } catch { throw Error('RMS_QUOTE_REQUEST_UNAVAILABLE_OR_INVALID'); }
    finally { if (fd !== undefined) closeSync(fd); }
}
