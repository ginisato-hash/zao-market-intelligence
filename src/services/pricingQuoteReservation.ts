export interface PricingQuoteReservation { kind:'QUOTE_REQUEST_RESERVED_V1'; source:'booking'; propertySlug:string; stayDate:string; attemptAt:string }
export const isPricingQuoteReservation=(r:PricingQuoteReservation)=>r?.kind==='QUOTE_REQUEST_RESERVED_V1'&&r.source==='booking'&&/^[a-z0-9-]{1,120}$/u.test(r.propertySlug)
 &&/^\d{4}-\d{2}-\d{2}$/u.test(r.stayDate)&&new Date(r.stayDate+'T00:00:00Z').toISOString().slice(0,10)===r.stayDate
 &&typeof r.attemptAt==='string'&&/(Z|[+-]\d\d:\d\d)$/u.test(r.attemptAt)&&Number.isFinite(Date.parse(r.attemptAt))
 &&Object.keys(r).sort().join('|')==='attemptAt|kind|propertySlug|source|stayDate';
