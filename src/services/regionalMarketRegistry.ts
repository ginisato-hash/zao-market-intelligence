// Regional population != OTA mappings != comparable 2P products. No new IDs/slugs/addresses inferred.
import {ZAO_ONSEN_EXPANDED_PROPERTY_MASTER} from './zaoOnsenPropertyMaster';
import {VERIFIED_LIVE_TARGETS,CANDIDATE_ONLY_TARGETS,type MarketRefreshPropertyTarget} from './marketRefreshTargetUniverse';
import {isOwnPropertyName} from './ownPropertyTargets';
import {digest} from './marketRowPriceQuality';
export const REGION_VERSION='ZAO_ONSEN_OFFICIAL_CLASSIFICATION_V1';
export const REGION_BASIS={source:'https://zaomountainresort.com/stay/',scope:'Official Zao Onsen destination lodging classification; not all Yamagata city or Miyagi Zao',legalLodgingCompleteness:false};
const norm=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[\s・･]+/gu,'');
export interface DiscoveryListing {source:string;observedAt:string;sourceSha256:string;pageEndSeen:boolean;names:string[];paginationComplete:boolean}
export interface RegionalProperty {
 physicalId:string;canonicalName:string;aliases:string[];category:string;regionVersion:string;
 regionStatus:'EXISTING_VERIFIED_REGION'|'OFFICIAL_REGION_CLASSIFIED'|'REGION_PENDING';regionEvidence:string[];
 own:boolean;businessStatus:'UNKNOWN';twoPerson:'UNKNOWN'|'ELIGIBLE'|'NO_VALID_2P_PRODUCT';
 mappings:MarketRefreshPropertyTarget[];identityPending:string[];
 primarySource:'booking'|null;unavailableReason:string|null;
}
/** Only exact canonical/explicit unambiguous aliases. A canonical name wins over somebody else's erroneous alias. */
export function buildRegionalRegistry(listings:readonly DiscoveryListing[]=[],targets:readonly MarketRefreshPropertyTarget[]= [...VERIFIED_LIVE_TARGETS,...CANDIDATE_ONLY_TARGETS]){
 if(listings.length>20||targets.length>1000)throw Error('REGISTRY_BUDGET');
 const map=new Map<string,RegionalProperty>();
 const get=(name:string,category='unknown')=>{const k=norm(name);let p=map.get(k);if(!p){p={physicalId:'zao_'+digest(k).slice(0,24),canonicalName:name,aliases:[],category,regionVersion:REGION_VERSION,regionStatus:'REGION_PENDING',regionEvidence:[],own:isOwnPropertyName(name),businessStatus:'UNKNOWN',twoPerson:'UNKNOWN',mappings:[],identityPending:[],primarySource:null,unavailableReason:null};map.set(k,p);}return p;};
 for(const p of ZAO_ONSEN_EXPANDED_PROPERTY_MASTER){const r=get(p.canonical_property_name,p.category);r.aliases=[...p.aliases];}
 // Official display names are candidates; ambiguous rename joins stay visible for identity review.
 for(const l of listings){if(!/^https:\/\//u.test(l.source)||!/^[0-9a-f]{64}$/u.test(l.sourceSha256)||l.names.length>500)throw Error('REGISTRY_LISTING');
  for(const name of l.names){const p=get(name);p.regionStatus='OFFICIAL_REGION_CLASSIFIED';p.regionEvidence.push(l.source+'#sha256='+l.sourceSha256);}}
 for(const t of targets){
  const exact=map.get(norm(t.canonical_property_name));
  const aliases=[...map.values()].filter(p=>p.aliases.some(a=>norm(a)===norm(t.canonical_property_name)));
  const p=exact??(aliases.length===1?aliases[0]!:get(t.canonical_property_name));
  if(!exact&&aliases.length>1){p.identityPending.push('AMBIGUOUS_CANONICAL_ALIAS');continue;}
  if(t.enabled_for_live&&t.verified_mapping&&t.property_slug&&['booking','jalan'].includes(t.source)){
   if(p.mappings.some(x=>x.source===t.source&&x.property_slug!==t.property_slug))p.identityPending.push('MULTIPLE_SOURCE_IDENTITIES');
   p.mappings.push(t);p.own ||= ['xi-raku','japanese-hostel-miuraya','yad325153'].includes(t.property_slug);p.regionStatus='EXISTING_VERIFIED_REGION';p.regionEvidence.push(t.verification_note);
  }else p.identityPending.push('SOURCE_IDENTITY_PENDING');
 }
 for(const p of map.values()){
  const bk=p.mappings.filter(x=>x.source==='booking');
  p.primarySource=bk.length===1&&!p.identityPending.includes('MULTIPLE_SOURCE_IDENTITIES')?'booking':null;
  p.unavailableReason=p.primarySource?null:'BOOKING_MAPPING_NOT_VERIFIED';
 }
 const properties=[...map.values()].sort((a,b)=>a.physicalId.localeCompare(b.physicalId));
 const body={schema:'ZMI_REGIONAL_PROPERTY_REGISTRY_V1' as const,regionVersion:REGION_VERSION,regionBasis:REGION_BASIS,properties,
  discoverySources:listings.map(l=>({source:l.source,observedAt:l.observedAt,sourceSha256:l.sourceSha256,pageEndSeen:l.pageEndSeen,paginationComplete:l.paginationComplete,listedCandidates:l.names.length})),
  allLegalFacilitiesDiscovered:false as const,unresolvedNameJoins:properties.filter(p=>p.identityPending.length>0||p.mappings.length===0).length,
  counts:{registeredCandidates:properties.length,own:properties.filter(p=>p.own).length,externalCandidates:properties.filter(p=>!p.own).length,
   verifiedPhysicalRecords:properties.filter(p=>p.mappings.length>0).length,nameOnlyCandidates:properties.filter(p=>p.mappings.length===0).length,bookingMappingVerified:properties.filter(p=>!p.own&&p.primarySource==='booking').length,twoPersonVerified:0,actualNewLaneCollected:0,actualNewLanePriceEligible:0}};
 return {...body,registrySha256:digest(body)};
}
