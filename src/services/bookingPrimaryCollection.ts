import type {RotatingTarget} from './rotatingCollectionScopePlanner';
/** Owner: Booking is primary; an optional secondary source must not gate a valid Booking run. */
export function bookingPrimaryLiveGates(env:Record<string,string|undefined>){
 return ['ZMI_AUTORUN_ENABLED','COLLECT_BOOKING','ALLOW_HISTORY_APPEND','HISTORY_TO_DB_SYNC','BUILD_AI_CONTEXT'].every(k=>env[k]==='1');
}
export function enabledCollectionTargets(targets:readonly RotatingTarget[],env:Record<string,string|undefined>){
 return targets.filter(t=>t.source==='booking'?env['COLLECT_BOOKING']==='1':t.source==='jalan'&&env['COLLECT_JALAN']==='1');
}
/** Failure is reported as unavailable, never a price, hotel-full inference or retry request. */
export async function optionalSecondaryCollection<T>(collect:()=>Promise<T>){
 try{return {status:'COMPLETED' as const,result:await collect()};}
 catch{return {status:'OPTIONAL_SOURCE_UNAVAILABLE' as const,result:null};}
}
