import {it,expect,vi} from 'vitest';
import http from 'node:http';
import {chromium,type BrowserServer} from 'playwright';
import {launchOwnedBookingBrowser,terminateOwnedBookingBrowser,ownedBookingBrowserStatus} from '../src/services/bookingOwnedBrowser';
import {createAnonymousBookingCaptureContext} from '../src/services/bookingProductObservability';
import {observeBookingInitialLoad} from '../src/services/bookingInitialLoadBarrier';
import {BookingUiBlockGuard} from '../src/services/bookingUiBlockGuard';

// Owned loopback receiving server only. These are mechanism fixtures, never OTA
// wire evidence. Preparing Playwright routing disables its HTTP cache.
async function owned(){
 const hits={document:0,baseline:0,information:0};let port=0;
 const receiver=http.createServer((req,res)=>{
  const path=req.url??'';let body='owned',type='text/html';
  if(path==='/main'){hits.document++;body=`<html><body>owned<iframe src="http://frame.prepared.test:${port}/frame"></iframe><script>window.w=new Worker('/worker');window.ready=new Promise(r=>w.onmessage=r);window.baseline=fetch('/baseline',{method:'POST'}).then(r=>r.text());</script></body></html>`;}
  else if(path==='/worker'){type='text/javascript';body=`postMessage('ready');onmessage=()=>fetch('/information-worker',{method:'POST'}).catch(()=>{});`;}
  else if(path==='/baseline'){hits.baseline++;setTimeout(()=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('settled');},40);return;}
  else if(path.startsWith('/information'))hits.information++;
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
 });
 await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const address=receiver.address();if(!address||typeof address==='string')throw Error('OWNED_BIND');port=address.port;
 const original=chromium.launchServer.bind(chromium);let server!:BrowserServer;
 const launch=vi.spyOn(chromium,'launchServer').mockImplementation(async options=>server=await original({...options,args:[...(options?.args??[]),'--no-proxy-server','--site-per-process','--host-resolver-rules=MAP root.prepared.test 127.0.0.1, MAP frame.prepared.test 127.0.0.1']}));
 let browser:Awaited<ReturnType<typeof launchOwnedBookingBrowser>>;
 try{browser=await launchOwnedBookingBrowser();}catch(error){await new Promise<void>(r=>receiver.close(()=>r()));throw error;}finally{launch.mockRestore();}
 const context=await createAnonymousBookingCaptureContext(browser,'OwnedPrepared/1'),page=await context.newPage(),initial=observeBookingInitialLoad(page),guard=new BookingUiBlockGuard(page,initial,true);
 return {hits,context,page,guard,browser,server,url:`http://root.prepared.test:${port}/main`,async close(){initial.dispose();if(!ownedBookingBrowserStatus(browser).terminationStarted)await terminateOwnedBookingBrowser(browser).catch(()=>{});await new Promise<void>(r=>receiver.close(()=>r()));}};
}

it('prepares both routes before sole goto, settles the original POST, then aborts main/OOPIF/worker HTTP with no receiving-server arrival',async()=>{
 const f=await owned();try{
  await f.guard.prepareInformationRoutesBeforeNavigation();expect(f.hits.document).toBe(0);
  const ready=f.guard.informationDiagnostics.registration;expect(ready.CONTEXT_ROUTE_READY).toBeGreaterThan(ready.REQUEST_LISTENER_ON!);expect(ready.PAGE_ROUTE_READY).toBeGreaterThan(ready.CONTEXT_ROUTE_READY!);
  await f.page.goto(f.url,{waitUntil:'load',timeout:5000});await f.page.evaluate(()=>Promise.all([(window as any).ready,(window as any).baseline]));
  expect(f.hits.baseline).toBe(1);expect(f.page.frames()).toHaveLength(2);
  await f.guard.armReadOnlyInformation();expect(f.guard.initialLoadHandoffVerified).toBe(true);
  await f.page.evaluate(()=>{queueMicrotask(()=>{void fetch('/information-main',{method:'POST'}).catch(()=>{});});void fetch('/information-head',{method:'HEAD'}).catch(()=>{});(window as any).w.postMessage('send');});
  await f.page.frames()[1]!.evaluate(()=>{void fetch('/information-frame').catch(()=>{});});
  const until=performance.now()+2000;while(f.guard.informationDiagnostics.counts.abortSucceeded<4&&performance.now()<until)await new Promise(r=>setTimeout(r,10));
  expect(f.guard.informationDiagnostics.counts).toMatchObject({seen:4,abortSucceeded:4,abortFailed:0,abortPending:0,unmatched:0});expect(f.hits).toEqual({document:1,baseline:1,information:0});
  await f.guard.closeReadOnlyInformationPage();await f.guard.finishReadOnlyInformation();expect(f.guard.stateVerified).toBe(true);expect(f.guard.informationDiagnostics.lifecycle).toBe('FINAL');expect(f.guard.informationDiagnostics.termination.verified).toBe(true);
 }finally{await f.close();}
},15000);

for(const mode of ['context-rejection','page-timeout'] as const)it(`route preparation ${mode} refuses navigation and keeps the owned kill bounded`,async()=>{
 const f=await owned(),goto=vi.spyOn(f.page,'goto');
 const route=mode==='context-rejection'?vi.spyOn(f.context,'route').mockRejectedValue(Error('owned prepare failure')):vi.spyOn(f.page,'route').mockImplementation(()=>new Promise(()=>{}));
 try{
  await expect(f.guard.prepareInformationRoutesBeforeNavigation()).rejects.toThrow('INFORMATION_GUARD_PREPARE_FAILED');expect(goto).not.toHaveBeenCalled();expect(f.hits.document).toBe(0);expect(f.guard.hardStop).toBe(true);expect(f.guard.stateVerified).toBe(false);
  const began=performance.now();await f.guard.closeReadOnlyInformationPage();await f.guard.finishReadOnlyInformation();expect(performance.now()-began).toBeLessThan(3000);expect(f.guard.informationDiagnostics.lifecycle).toBe('FINAL');expect(f.guard.stateVerified).toBe(false);expect(ownedBookingBrowserStatus(f.browser).processExited).toBe(true);
 }finally{route.mockRestore();goto.mockRestore();await f.close();}
},12000);

it('a pending initial route continuation refuses the handoff even when the passive quiet snapshot is clear',async()=>{
 const f=await owned();let release!:()=>void;
 try{
  await f.guard.prepareInformationRoutesBeforeNavigation();await f.page.goto(f.url,{waitUntil:'load',timeout:5000});await f.page.evaluate(()=>Promise.all([(window as any).ready,(window as any).baseline]));
  // The route-protocol callback can remain unsettled after the passive request
  // observer has gone quiet. It must have its own disposition boundary.
  const pending=(f.guard as any).informationRoute({fallback:()=>new Promise<void>(r=>release=r)});
  await expect(f.guard.armReadOnlyInformation()).rejects.toThrow('INITIAL_LOAD_CHANGED_DURING_INFORMATION_ARM');expect(f.guard.initialLoadHandoffVerified).toBe(false);expect(f.guard.informationFailureCode).toBe('GUARD_ARM_FAILED');expect(f.guard.hardStop).toBe(true);expect(f.hits.information).toBe(0);
  release();await pending;await f.guard.closeReadOnlyInformationPage();await f.guard.finishReadOnlyInformation();expect(f.guard.stateVerified).toBe(false);expect(f.guard.informationDiagnostics.lifecycle).toBe('FINAL');
 }finally{release?.();await f.close();}
},15000);

it('NoInfo close switches synchronously to DENY before awaiting its owned kill, without forging a quiet handoff',async()=>{
 const f=await owned();const kill=f.server.kill.bind(f.server);let release!:()=>void,entered!:()=>void;
 const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);
 const spy=vi.spyOn(f.server,'kill').mockImplementation(async()=>{entered();await blocked;await kill();});
 try{
  await f.guard.prepareInformationRoutesBeforeNavigation();await f.page.goto(f.url,{waitUntil:'load',timeout:5000});await f.page.evaluate(()=>Promise.all([(window as any).ready,(window as any).baseline]));
  // No armReadOnlyInformation call: the no-information branch is the subject.
  const closing=f.guard.closeReadOnlyInformationPage();await started;
  await f.page.evaluate(()=>{void fetch('/information-during-kill',{method:'POST'}).catch(()=>{});});
  const until=performance.now()+1000;while(f.guard.informationDiagnostics.counts.abortSucceeded<1&&performance.now()<until)await new Promise(r=>setTimeout(r,10));
  expect(f.hits.information).toBe(0);expect(f.guard.initialLoadHandoffVerified).toBeNull();expect(f.guard.informationDiagnostics.counts).toMatchObject({seen:1,routeStarted:1,abortSucceeded:1,unmatched:0});
  release();await closing;await f.guard.finishReadOnlyInformation();expect(f.guard.informationDiagnostics.lifecycle).toBe('FINAL');expect(f.guard.informationDiagnostics.termination.verified).toBe(true);
 }finally{release?.();spy.mockRestore();await f.close();}
},12000);
