// Phase ZMI-MKT-OBS01 — CORE competitor target registry (pure).
//
// The 3 CORE competitors named by Refine V2 (§0/§19/§23): HAMMOND / 吉田屋 /
// ONSEN & STAY OAKHILL. Slugs/IDs are the same verified-live mappings already
// confirmed in marketRefreshTargetUniverse.ts / priorityCompetitors.ts. Split
// into its own module (rather than living in the collector script) so it can
// be imported by tests/other services without triggering the script's
// top-level run() side effect.
//
// No I/O, no network.

export interface CoreCompetitorTarget {
  propertyId: string;
  propertyName: string;
  bookingSlug: string;
  jalanYadId: string;
}

export const CORE_COMPETITORS: readonly CoreCompetitorTarget[] = [
  { propertyId: "hammond", propertyName: "HAMMOND", bookingSlug: "hammond-takamiya", jalanYadId: "yad348320" },
  { propertyId: "yoshidaya", propertyName: "吉田屋", bookingSlug: "ji-tian-wu-shan-xing-shi", jalanYadId: "yad327282" },
  { propertyId: "oakhill", propertyName: "ONSEN & STAY OAKHILL", bookingSlug: "onsen-amp-stay-oakhill", jalanYadId: "yad388065" }
] as const;
