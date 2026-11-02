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

it('correlates route-before-request and reports registration and cleanup order without widening admission',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();await x.route();x.seen();await x.guard.closeReadOnlyInformationPage();await x.guard.finishReadOnlyInformation();
 const d=x.guard.informationDiagnostics,r=d.lastRequests[0]!;
 expect(x.guard.stateVerified).toBe(true);expect(d.counts).toMatchObject({seen:1,routeStarted:1,routeCompleted:1,abortSucceeded:1,abortFailed:0,abortPending:0,unmatched:0});
 expect(r.routeStarted!).toBeLessThan(r.seen!);expect(r.id).toBe(1);expect(d.registration.PAGE_ROUTE_READY!).toBeLessThan(d.boundaries.ACTIVE!);expect(d.registration.UNROUTE_BEGIN!).toBeLessThan(d.registration.UNROUTE_END!);expect(d.boundaries.FINAL!).toBeGreaterThan(d.registration.REQUEST_LISTENER_OFF!);
});

it('keeps the first successful abort separate from the last unmatched request',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();x.seen();await x.route();
 const later:any={method:()=> 'GET',resourceType:()=> 'xhr',isNavigationRequest:()=>false};(x.guard as any).informationRequestSeen(later);
 await x.page.close();await x.guard.finishReadOnlyInformation();const d=x.guard.informationDiagnostics;
 expect(x.guard.informationDeniedRequest?.abortOutcome).toBe('SUCCEEDED');expect(x.guard.informationFailureCode).toBe('UNABORTED_OBSERVED_REQUEST');expect(d.counts).toMatchObject({seen:2,abortSucceeded:1,unmatched:1});expect(d.lastUnmatched[0]).toMatchObject({id:2,method:'GET',resourceType:'xhr',routeStarted:null,abortSucceeded:null});expect(d.failure?.lifecycle).toBe('UNROUTING');
});

it('identifies an unmatched request at the context-route installation boundary and refuses it',async()=>{
 const x=fixture();x.context.route=async()=>{x.seen();};await x.guard.armReadOnlyInformation();await x.page.close();await x.guard.finishReadOnlyInformation();
 const d=x.guard.informationDiagnostics,r=d.lastUnmatched[0]!;expect(x.guard.stateVerified).toBe(false);expect(r.lifecycleAtSeen).toBe('INSTALLING');expect(r.seen!).toBeGreaterThan(d.registration.CONTEXT_ROUTE_BEGIN!);expect(r.seen!).toBeLessThan(d.registration.CONTEXT_ROUTE_READY!);expect(r.routeStarted).toBeNull();
});

it('drains a late owned callback during unroute and records that closed-page ordering',async()=>{
 const x=fixture();x.context.unroute=async()=>{x.seen();await (x.guard as any).informationRoute({request:()=>x.request,abort:async()=>{await Promise.resolve();}});};
 await x.guard.armReadOnlyInformation();await x.guard.closeReadOnlyInformationPage();await x.guard.finishReadOnlyInformation();const d=x.guard.informationDiagnostics,r=d.lastRequests[0]!;
 expect(x.guard.stateVerified).toBe(true);expect(r.lifecycleAtRoute).toBe('UNROUTING');expect(r.routeStarted!).toBeGreaterThan(d.boundaries.CLOSED!);expect(r.routeCompleted!).toBeLessThan(d.boundaries.FINAL!);expect(d.counts.unmatched).toBe(0);
});

it('records synchronous abort failure as failed, with no successful disposition or exception content',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();x.seen();await (x.guard as any).informationRoute({request:()=>x.request,abort:()=>{throw Error('secret must not appear');}});await x.page.close();await x.guard.finishReadOnlyInformation();
 expect(x.guard.informationFailureCode).toBe('ABORT_FAILED');expect(x.guard.informationDiagnostics.counts).toMatchObject({abortFailed:1,abortSucceeded:0,unmatched:1});expect(JSON.stringify(x.guard.informationDiagnostics)).not.toContain('secret');
});

it('retains only bounded, closed request classes, never URLs or arbitrary method/resource strings',async()=>{
 const x=fixture();await x.guard.armReadOnlyInformation();
 for(let i=0;i<1005;i++)(x.guard as any).informationRequestSeen({method:()=> 'secret-token',resourceType:()=> 'secret-url',isNavigationRequest:()=>false,url:()=> 'https://secret.invalid/?credential=secret'});
 await x.page.close();await x.guard.finishReadOnlyInformation();const d=x.guard.informationDiagnostics,s=JSON.stringify(d);
 expect(x.guard.stateVerified).toBe(false);expect(x.guard.informationFailureCode).toBe('REQUEST_BUDGET_EXCEEDED');expect(d.overflow).toBe(true);expect(d.counts.seen).toBe(1000);expect(d.lastRequests).toHaveLength(8);expect(d.lastUnmatched).toHaveLength(8);expect(d.lastRequests.every(r=>r.method==='OTHER'&&r.resourceType==='other')).toBe(true);expect(s).not.toMatch(/secret|https|credential/);
});
