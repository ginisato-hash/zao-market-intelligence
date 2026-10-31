import {it,expect,vi} from 'vitest';
import {BookingUiBlockGuard} from '../src/services/bookingUiBlockGuard';

function fixture(){
 let closed=false;
 const context:any={on:()=>{},off:()=>{},route:async()=>{},unroute:async()=>{}};
 const page:any={on:()=>{},once:()=>{},off:()=>{},context:()=>context,route:async()=>{},isClosed:()=>closed,title:async()=> 'synthetic',locator:()=>({innerText:async()=> 'synthetic'}),close:async()=>{closed=true;}};
 const guard=new BookingUiBlockGuard(page,undefined,true);
 const request:any={method:()=> 'POST',resourceType:()=> 'fetch',isNavigationRequest:()=>false};
 const abort=async()=>{await new Promise(r=>setTimeout(r,20));if(closed)throw Error('synthetic close race');};
 const seen=()=>{(guard as any).informationRequestSeen(request);};
 const route=()=> (guard as any).informationRoute({request:()=>request,abort});
 return {page,context,request,guard,seen,route};
}

it('preclose drain prevents closing an in-flight owned abort; the former close ordering fails closed',async()=>{
 for(const barrier of [false,true]){
  const x=fixture();await x.guard.armReadOnlyInformation();x.seen();const p=x.route();
  if(barrier)await x.guard.closeReadOnlyInformationPage();else await x.page.close();
  await p;await x.guard.finishReadOnlyInformation();
  expect(x.guard.stateVerified).toBe(barrier);expect(x.guard.hardStop).toBe(!barrier);
  expect(x.guard.informationFailureCode).toBe(barrier?null:'ABORT_FAILED');
 }
});

it('already observed request waits for its delayed owned-route disposition before close',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();x.seen();
 const route=new Promise<void>(resolve=>setTimeout(()=>{void x.route().then(resolve);},20));
 await x.guard.closeReadOnlyInformationPage();await route;await x.guard.finishReadOnlyInformation();
 expect(x.guard.stateVerified).toBe(true);expect(x.guard.hardStop).toBe(false);
});

it('missing request disposition still times out and stops; it is never accepted as an abort',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();x.seen();
 const clock=vi.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValue(4000);
 try{await x.guard.closeReadOnlyInformationPage();}finally{clock.mockRestore();}
 await x.guard.finishReadOnlyInformation();
 expect(x.guard.hardStop).toBe(true);expect(x.guard.stateVerified).toBe(false);
 expect(x.guard.informationFailureCode).toBe('ABORT_DRAIN_TIMEOUT');
});

it('the normal checkpoint-close-finish path is bounded even when an owned abort never settles',async()=>{
 vi.useFakeTimers();const x=fixture();await x.guard.armReadOnlyInformation();x.seen();
 void (x.guard as any).informationRoute({request:()=>x.request,abort:()=>new Promise(()=>{})});
 const lifecycle=(async()=>{await x.guard.checkpoint();await x.guard.closeReadOnlyInformationPage();await x.guard.finishReadOnlyInformation();})();
 try{await vi.advanceTimersByTimeAsync(6500);await lifecycle;expect(x.guard.stateVerified).toBe(false);expect(x.guard.hardStop).toBe(true);expect(x.guard.informationFailureCode).toBe('ABORT_DRAIN_TIMEOUT');}
 finally{vi.useRealTimers();}
});

it('unroute that never settles is also a bounded cleanup failure',async()=>{
 vi.useFakeTimers();const x=fixture();x.context.unroute=()=>new Promise(()=>{});await x.guard.armReadOnlyInformation();await x.guard.closeReadOnlyInformationPage();const finished=x.guard.finishReadOnlyInformation();
 try{await vi.advanceTimersByTimeAsync(3100);await finished;expect(x.guard.stateVerified).toBe(false);expect(x.guard.hardStop).toBe(true);expect(x.guard.informationFailureCode).toBe('ROUTE_CLEANUP_FAILED');}
 finally{vi.useRealTimers();}
});
