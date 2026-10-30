import {it,expect} from 'vitest';
import {bookingPrimaryLiveGates,enabledCollectionTargets,optionalSecondaryCollection} from '../src/services/bookingPrimaryCollection';
import type {RotatingTarget} from '../src/services/rotatingCollectionScopePlanner';
const ready={ZMI_AUTORUN_ENABLED:'1',COLLECT_BOOKING:'1',ALLOW_HISTORY_APPEND:'1',HISTORY_TO_DB_SYNC:'1',BUILD_AI_CONTEXT:'1'};
it('Booking can run when every optional OTA is disabled while existing write/append guards still apply',()=>{
 expect(bookingPrimaryLiveGates({...ready,COLLECT_JALAN:'0'})).toBe(true);
 for(const key of Object.keys(ready))expect(bookingPrimaryLiveGates({...ready,[key]:'0'})).toBe(false);
});
it('disabled optional sources receive no requests and no quota is transferred to Booking',()=>{
 const targets=[{source:'booking',property_slug:'known-booking'},{source:'jalan',property_slug:'known-jalan'}] as RotatingTarget[];
 expect(enabledCollectionTargets(targets,ready)).toEqual([targets[0]]);expect(enabledCollectionTargets(targets,{...ready,COLLECT_JALAN:'1'})).toEqual(targets);
});
it('an unavailable secondary source is an explicit partial result and cannot throw through the Booking workflow',async()=>{
 const savedBooking=['actual-booking-result'];const secondary=await optionalSecondaryCollection(async()=>{throw Error('source-unavailable');});
 expect(secondary).toEqual({status:'OPTIONAL_SOURCE_UNAVAILABLE',result:null});expect(savedBooking).toEqual(['actual-booking-result']);
 expect(await optionalSecondaryCollection(async()=>['secondary-result'])).toEqual({status:'COMPLETED',result:['secondary-result']});
});
