import {z} from 'zod';
const hash=z.string().regex(/^[0-9a-f]{64}$/u);
const config=z.object({schema:z.literal('OBSERVED_LISTING_PUBLICATION_CONFIG_V1'),evidenceKind:z.literal('OBSERVED_LISTING_RELATIVE_V1'),acceptedProducerCodes:z.array(hash).min(1).max(10),policy:z.object({version:z.string().regex(/^[-A-Za-z0-9_.]{1,100}$/u),maxCurrentAgeHours:z.number().positive().max(72),maxComparisonAgeHours:z.number().positive().max(720),minProperties:z.number().int().min(2).max(100),validForMinutes:z.number().int().positive().max(120),productionAccepted:z.literal(false)}).strict(),quarantine:z.array(z.object({path:z.string().min(1),rawSha256:hash,entriesKey:z.enum(['entries','unknownRows'])}).strict()).max(10)}).strict();
/** Explicit finite source lineage only; parsing never admits a producer/run or price. */
export function parseObservedListingPublicationConfig(value:unknown){return config.parse(value);}
