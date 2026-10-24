import { expect, it } from 'vitest';
import { marketPropertyGroup, summarizeMarketPropertyGroups } from '../src/services/marketPropertyGroups';
it('counts the three TD starting facilities as one official operating group', () => {
    expect(summarizeMarketPropertyGroups(['hammond-takamiya', 'onsen-amp-stay-oakhill', 'rurikura-resort'].map(propertySlug => ({ source: 'booking', propertySlug }))))
        .toMatchObject({ groupedProperties: 3, independentGroups: 1, priceComparabilityEstablished: false, marketPriceAuthority: false, provenance: { legalOwnerClaim: false } });
});
it('deduplicates multiple rooms and OTA aliases without inventing independence for unknown properties', () => {
    const r = summarizeMarketPropertyGroups([{ source: 'booking', propertySlug: 'hammond-takamiya' }, { source: 'booking', propertySlug: 'hammond-takamiya' },
        { source: 'jalan', propertySlug: 'yad348320' }, { source: 'booking', propertySlug: 'xi-raku' }, { source: 'booking', propertySlug: 'unknown-property' }]);
    expect(r).toMatchObject({ inputRecords: 5, groupedProperties: 1, independentGroups: 1, excludedOwnProperties: 1, unknownSourceProperties: ['booking|unknown-property'] });
    expect(marketPropertyGroup('booking', 'made-up').groupKey).toBeNull();
    expect(marketPropertyGroup('jalan', 'yad325153')).toEqual(marketPropertyGroup('booking', 'xi-raku'));
    expect(marketPropertyGroup('jalan', 'yad327282')).toEqual(marketPropertyGroup('booking', 'ji-tian-wu-shan-xing-shi'));
});
it('bounds input and rejects raw URLs or arbitrary source identifiers', () => {
    expect(() => summarizeMarketPropertyGroups([{ source: 'booking', propertySlug: 'https://example.test/secret' }])).toThrow('INVALID');
    expect(() => summarizeMarketPropertyGroups(Array(1001).fill({ source: 'booking', propertySlug: 'hammond-takamiya' }))).toThrow('BUDGET');
});
