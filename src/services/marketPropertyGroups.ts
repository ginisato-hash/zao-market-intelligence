// Correlation grouping, not a claim that the facilities have the same legal title holder.
// Official operating-group directory verified 2026-10-25:
// https://meito-takamiya.com/hotels/ (HAMMOND, OAKHILL, RURIKURA and Yoshidaya).
// Existing verified source-to-property aliases: marketRefreshTargetUniverse.ts.
export const MARKET_PROPERTY_GROUP_VERSION = 'TAKAMIYA_OPERATING_GROUP_20261025_V1';
export const MARKET_PROPERTY_GROUP_PROVENANCE = Object.freeze({ verifiedAt: '2026-10-25T05:14:11+09:00',
    source: 'https://meito-takamiya.com/hotels/', basis: 'OFFICIAL_OPERATING_GROUP_DIRECTORY', legalOwnerClaim: false });
const aliases = new Map<string, string>([
    ['booking|hammond-takamiya', 'hammond'], ['jalan|yad348320', 'hammond'],
    ['booking|onsen-amp-stay-oakhill', 'oakhill'], ['jalan|yad388065', 'oakhill'],
    ['booking|rurikura-resort', 'rurikura'], ['booking|ji-tian-wu-shan-xing-shi', 'yoshidaya'], ['jalan|yad327282', 'yoshidaya']
]);
export function marketPropertyGroup(source: string, propertySlug: string) {
    if (source === 'booking' && propertySlug === 'xi-raku' || source === 'jalan' && propertySlug === 'yad325153') return { role: 'OWN' as const, propertyKey: 'kiraku', groupKey: null };
    const propertyKey = aliases.get(source + '|' + propertySlug);
    return propertyKey ? { role: 'COMPARISON_CANDIDATE' as const, propertyKey, groupKey: 'TAKAMIYA_OPERATING_GROUP' }
        : { role: 'UNKNOWN' as const, propertyKey: null, groupKey: null };
}
/** Distinct rooms/OTAs/facilities are not independent votes. Unknown ownership is never a new independent group. */
export function summarizeMarketPropertyGroups(rows: readonly { source: string; propertySlug: string }[]) {
    if (rows.length > 1000) throw Error('MARKET_GROUP_INPUT_BUDGET');
    const groups = new Map<string, Set<string>>(), own = new Set<string>(), unknown = new Set<string>();
    for (const row of rows) {
        if (!['booking', 'jalan'].includes(row.source) || !/^[a-z0-9-]{1,100}$/u.test(row.propertySlug)) throw Error('MARKET_GROUP_INPUT_INVALID');
        const c = marketPropertyGroup(row.source, row.propertySlug), key = row.source + '|' + row.propertySlug;
        if (c.role === 'OWN') { own.add(c.propertyKey); continue; }
        if (c.role === 'UNKNOWN') { unknown.add(key); continue; }
        const members = groups.get(c.groupKey!) ?? new Set<string>(); members.add(c.propertyKey!); groups.set(c.groupKey!, members);
    }
    return { version: MARKET_PROPERTY_GROUP_VERSION, provenance: MARKET_PROPERTY_GROUP_PROVENANCE,
        inputRecords: rows.length, groupedProperties: [...groups.values()].reduce((n, g) => n + g.size, 0), independentGroups: groups.size,
        groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([groupKey, members]) => ({ groupKey, propertyKeys: [...members].sort() })),
        excludedOwnProperties: own.size, unknownSourceProperties: [...unknown].sort(),
        priceComparabilityEstablished: false as const, marketPriceAuthority: false as const };
}
