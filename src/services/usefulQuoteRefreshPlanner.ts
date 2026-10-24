// One bounded collection lane over the ACTUAL acceptance dates supplied by RMS.
// Reuses existing source caps, calendar scoring and throttle semantics. This is a plan, not a source enablement or price decision.
import { scoreTarget, bucketForOffset, SLOT_HOURS, type RotatingCaps, type RotatingDemandConfig, type RotatingTarget } from './rotatingCollectionScopePlanner';
import { epochDay } from './priorityRefreshTiers';
import type { MarketRefreshPropertyTarget } from './marketRefreshTargetUniverse';
export interface PricingQuoteNeed {
    stayDate: string;
    admittedAt: string;
    priceDecisionEligible: boolean;
    decisionImpact: number; // [0,1], prioritization only; never a price coefficient
    changedAt: string | null;
}
export interface UsefulQuoteState {
    source: 'booking' | 'jalan'; propertySlug: string; stayDate: string;
    lastAttemptAt: string | null;
    lastUsableAt: string | null;
    usableBasisVersion: string | null;
    retryAfter: string | null;
}
const instant = (s: string | null) => typeof s === 'string' && /(?:Z|[+-]\d\d:\d\d)$/u.test(s) ? Date.parse(s) : NaN;
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/u.test(s) && Number.isFinite(Date.parse(s+'T00:00:00Z')) && new Date(Date.parse(s + 'T00:00:00Z')).toISOString().slice(0, 10) === s;
const keyOf = (source: string, slug: string, date: string) => source + '|' + slug + '|' + date;
export function planUsefulQuoteRefresh(input: {
    now: string; runDate: string; needs: readonly PricingQuoteNeed[]; properties: readonly MarketRefreshPropertyTarget[];
    states: readonly UsefulQuoteState[]; basisVersion: string; caps: RotatingCaps; lanePages: number;
    freshHours: number; farDeadlineHours: number; maxPerProperty?:number; config: RotatingDemandConfig;
}) {
    const now = instant(input.now), budget = input.lanePages,propertyCap=input.maxPerProperty??input.caps.total_pages_per_run;
    if (!Number.isFinite(now) || !validDate(input.runDate) || new Date(now + 9 * 3600000).toISOString().slice(0, 10) !== input.runDate
        || input.needs.length > 2000 || input.properties.length > 100 || input.states.length > 200000 || !input.basisVersion
        || !Number.isSafeInteger(budget) || budget < 0 || budget > input.caps.total_pages_per_run
        || !Number.isFinite(input.freshHours) || input.freshHours <= 0 || input.freshHours > 48
        || !Number.isFinite(input.farDeadlineHours) || input.farDeadlineHours < input.freshHours || input.farDeadlineHours > 8760)
        throw new Error('USEFUL_QUOTE_PLAN_INVALID_OR_BUDGET');
    for (const n of [input.caps.total_pages_per_run, input.caps.booking_pages_per_run, input.caps.jalan_pages_per_run])
        if (!Number.isSafeInteger(n) || n < 0) throw new Error('USEFUL_QUOTE_CAP_INVALID');
    if(!Number.isSafeInteger(propertyCap)||propertyCap<0||propertyCap>input.caps.total_pages_per_run)throw new Error('USEFUL_QUOTE_PROPERTY_CAP_INVALID');
    if (input.caps.rakuten_pages_per_run !== 0 || input.caps.google_hotels_pages_per_run !== 0)
        throw new Error('USEFUL_QUOTE_DISABLED_SOURCE');
    const states = new Map<string, UsefulQuoteState>(), needs = new Map<string, PricingQuoteNeed>();
    const excluded: Record<string, number> = {}, drop = (why: string) => { excluded[why] = (excluded[why] ?? 0) + 1; };
    for (const s of input.states) {
        const k = keyOf(s.source, s.propertySlug, s.stayDate);
        if (states.has(k)) throw new Error('USEFUL_QUOTE_STATE_AMBIGUOUS');
        for (const value of [s.lastAttemptAt, s.lastUsableAt, s.retryAfter])
            if (value !== null && !Number.isFinite(instant(value))) throw new Error('USEFUL_QUOTE_STATE_TIME_INVALID');
        if (instant(s.lastAttemptAt) > now || instant(s.lastUsableAt) > now) throw new Error('USEFUL_QUOTE_FUTURE_OBSERVATION');
        states.set(k, s);
    }
    for (const n of input.needs) {
        if (!validDate(n.stayDate) || typeof n.priceDecisionEligible!=='boolean' || !Number.isFinite(instant(n.admittedAt)) || instant(n.admittedAt) > now || n.changedAt !== null && (!Number.isFinite(instant(n.changedAt)) || instant(n.changedAt) > now)
            || !Number.isFinite(n.decisionImpact) || n.decisionImpact < 0 || n.decisionImpact > 1 || needs.has(n.stayDate))
            throw new Error('USEFUL_QUOTE_NEED_INVALID_OR_AMBIGUOUS');
        needs.set(n.stayDate, n);
    }
    type Candidate = { target: RotatingTarget; deadlineAt: number; lastUsable: number;lastAttempt:number; impact: number; changed: boolean; far: boolean; key: string };
    const candidates: Candidate[] = [], properties = new Map<string, MarketRefreshPropertyTarget>();
    for (const p of input.properties) {
        if (p.enabled_for_live!==true || p.verified_mapping!==true || !['booking', 'jalan'].includes(p.source)) { drop('SOURCE_NOT_VERIFIED_LIVE'); continue; }
        const key = p.source + '|' + p.property_slug;
        if (properties.has(key)) throw new Error('USEFUL_QUOTE_PROPERTY_AMBIGUOUS');
        properties.set(key, p);
    }
    let farUniverse = 0;const farBySource={booking:0,jalan:0};
    for (const n of needs.values()) {
        const offset = epochDay(n.stayDate) - epochDay(input.runDate);
        if (!n.priceDecisionEligible || offset < 1) { drop('NOT_AN_ELIGIBLE_PRICE_DECISION_DATE'); continue; }
        for (const p of properties.values()) {
            const source = p.source as 'booking' | 'jalan', key = keyOf(source, p.property_slug, n.stayDate), state = states.get(key);
            const usable = state?.usableBasisVersion === input.basisVersion && state.lastUsableAt !== null ? instant(state.lastUsableAt) : NaN;
            const age = Number.isFinite(usable) ? (now - usable) / 3600000 : null, far = offset > 90;
            if (far){farUniverse++;farBySource[source]++;}
            if (state?.retryAfter && instant(state.retryAfter) > now) { drop('SOURCE_RETRY_AFTER'); continue; }
            // A failed/condition-incomplete observation is still a request for cooldown purposes.
            if (state?.lastAttemptAt && now - instant(state.lastAttemptAt) < 24 * 3600000) { drop('EXISTING_24H_REQUEST_COOLDOWN'); continue; }
            const changed = n.changedAt !== null && (!Number.isFinite(usable) || instant(n.changedAt) > usable);
            if (age !== null && age < input.freshHours && !changed) { drop('FRESH_COMPARABLE_CACHE'); continue; }
            const deadlineAt = (Number.isFinite(usable) ? usable : instant(n.admittedAt)) + (far ? input.farDeadlineHours : input.freshHours) * 3600000;
            const bucket = bucketForOffset(offset) ?? 'long'; // No 30/90/240/Q1 horizon cutoff.
            const score = scoreTarget(n.stayDate, bucket, p.tier, input.config, false, { offset });
            candidates.push({ key, deadlineAt, lastUsable: Number.isFinite(usable) ? usable : -Infinity,lastAttempt:state?.lastAttemptAt?instant(state.lastAttemptAt):-Infinity, impact: n.decisionImpact, changed, far,
                target: { source, property_slug: p.property_slug, canonical_property_name: p.canonical_property_name, stay_date: n.stayDate, checkin: n.stayDate,
                    bucket, tier: p.tier, priority_score: score.score, reason_codes: [...score.reasons, 'ACTUAL_ACCEPTANCE_SCOPE', age === null ? 'NO_USABLE_COMPARABLE_QUOTE' : 'COMPARABLE_QUOTE_STALE', ...(changed ? ['DECISION_EVIDENCE_CHANGED'] : []), ...(deadlineAt <= now ? ['QUOTE_DEADLINE_OVERDUE'] : [])],
                    estimated_page_count: 1, rms_critical: true, service_state: age === null ? 'never_served' : deadlineAt <= now ? 'overdue' : 'due_soon', service_age_hours: age, band_rank: deadlineAt <= now ? 0 : 1 } });
        }
    }
    candidates.sort((a, b) => Number(b.deadlineAt <= now) - Number(a.deadlineAt <= now) || a.deadlineAt - b.deadlineAt || Number(b.changed) - Number(a.changed) || b.impact - a.impact || a.lastUsable - b.lastUsable || a.key.localeCompare(b.key));
    const selected: Candidate[] = [], selectedKeys = new Set<string>(), byProperty=new Map<string,number>(),counts = { booking: 0, jalan: 0 };
    const take = (c: Candidate) => {
        const property=c.target.source+'|'+c.target.property_slug;
        if((byProperty.get(property)??0)>=propertyCap)return false;
        if (selected.length >= budget || selectedKeys.has(c.key) || counts[c.target.source] >= input.caps[c.target.source === 'booking' ? 'booking_pages_per_run' : 'jalan_pages_per_run']) return false;
        selected.push(c); selectedKeys.add(c.key); counts[c.target.source]++;byProperty.set(property,(byProperty.get(property)??0)+1); return true;
    };
    // Reserve one admitted far-date request per run when it is due and capacity permits; near-term urgency cannot starve it forever.
    if (budget > 0) { const far = candidates.filter(c => c.far && c.deadlineAt <= now && input.caps[c.target.source === 'booking' ? 'booking_pages_per_run' : 'jalan_pages_per_run'] > 0)
      .sort((a,b)=>a.lastAttempt-b.lastAttempt||a.deadlineAt-b.deadlineAt||a.key.localeCompare(b.key))[0];if(far)take(far); }
    for (const c of candidates) take(c);
    const overdueUnselected = candidates.filter(c => c.deadlineAt <= now && !selectedKeys.has(c.key)).length;
    const farSourceBlocked=farBySource.booking>0&&input.caps.booking_pages_per_run===0||farBySource.jalan>0&&input.caps.jalan_pages_per_run===0;
    const farCapacityPerDay = budget > 0&&propertyCap>0&&!farSourceBlocked ? SLOT_HOURS.length : 0; // One fair reserved far slot per run; never a success guarantee.
    const farMinimumCycleHours = farUniverse === 0 ? 0 : farCapacityPerDay > 0 ? Math.ceil(farUniverse / farCapacityPerDay) * 24 : null;
    return { version: 'USEFUL_QUOTE_REFRESH_PLAN_V1' as const, now: input.now, basisVersion: input.basisVersion, selected: selected.map(c => c.target), selectedBySource: counts,
        candidates: candidates.length, excluded, overdueUnselected, farUniverse, farMinimumCycleHours,
        configuredFarDeadlineHours: input.farDeadlineHours, farDeadlineCapacityFeasible: farMinimumCycleHours !== null && farMinimumCycleHours <= input.farDeadlineHours,
        deadlineClaim: 'PLANNED_CAPACITY_ONLY_NOT_OBSERVATION_SUCCESS' as const, requestsExecuted: 0 as const };
}
