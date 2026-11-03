import {it,expect,vi}from'vitest';
import http from'node:http';
import {chromium,type BrowserServer,type Request}from'playwright';
import {launchOwnedBookingBrowser,terminateOwnedBookingBrowser,ownedBookingBrowserStatus}from'../src/services/bookingOwnedBrowser';
import {createAnonymousBookingCaptureContext}from'../src/services/bookingProductObservability';
import {observeBookingInitialLoad}from'../src/services/bookingInitialLoadBarrier';
import {BookingUiBlockGuard}from'../src/services/bookingUiBlockGuard';

async function fixture(delayInitialEvent=false){
 const hits={initial:0,information:0};
 const receiver=http.createServer((req,res)=>{const p=req.url??'';if(p.startsWith('/initial'))hits.initial++;if(p.startsWith('/information'))hits.information++;res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(p==='/main'?`<html><body>owned<script>window.ready=fetch('/initial?secret=OWNER_FIXTURE').then(r=>r.text());</script></body></html>`:'owned');});
 await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));const a=receiver.address();if(!a||typeof a==='string')throw Error('OWNED_BIND');
 const launch=chromium.launchServer.bind(chromium);let server!:BrowserServer;
 const spy=vi.spyOn(chromium,'launchServer').mockImplementation(async options=>server=await launch({...options,args:[...(options?.args??[]),'--no-proxy-server']}));let browser:Awaited<ReturnType<typeof launchOwnedBookingBrowser>>;
 try{browser=await launchOwnedBookingBrowser();}catch(e){await new Promise<void>(r=>receiver.close(()=>r()));throw e;}finally{spy.mockRestore();}
 const context=await createAnonymousBookingCaptureContext(browser,'OwnedCausal/1'),page=await context.newPage(),initial=observeBookingInitialLoad(page),guard=new BookingUiBlockGuard(page,initial,true);
 const emit=(context as any).emit.bind(context);let delayed:Request|undefined;
 const emitter=vi.spyOn(context as any,'emit').mockImplementation((event:any,...args:any[])=>{if(delayInitialEvent&&event==='request'&&(args[0]as Request).url().includes('/initial?')){delayed=args[0];return false;}return emit(event,...args);});
 const kill=server.kill.bind(server);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const killer=vi.spyOn(server,'kill').mockImplementation(async()=>{entered();await gate;await kill();});
 return{hits,page,context,guard,browser,started,release,emitDelayed(){if(!delayed)throw Error('OWNED_DELAYED_REQUEST_MISSING');emit('request',delayed);},async load(){await guard.prepareInformationRoutesBeforeNavigation();await page.goto(`http://127.0.0.1:${a.port}/main`,{waitUntil:'load',timeout:5000});await page.evaluate(()=>(window as any).ready);},async dispose(){release();emitter.mockRestore();killer.mockRestore();initial.dispose();if(!ownedBookingBrowserStatus(browser).terminationStarted)await terminateOwnedBookingBrowser(browser).catch(()=>{});await new Promise<void>(r=>receiver.close(()=>r()));}};
}
const privacy=(guard:BookingUiBlockGuard)=>{const text=JSON.stringify(guard.initialRouteCausalDiagnostics);for(const x of ['OWNER_FIXTURE','127.0.0.1','/initial?','secret=','private_payload'])expect(text).not.toContain(x);};

it('correlates a real INITIAL fallback whose request notification is delayed across close, while the original unmatched request still STOPs',async()=>{
 const f=await fixture(true);try{
  await f.load();const closing=f.guard.closeReadOnlyInformationPage();await f.started;f.emitDelayed();f.release();await closing;await f.guard.finishReadOnlyInformation();
  const d=f.guard.initialRouteCausalDiagnostics,row=d.lastInformationRequests[0]!;
  expect(f.hits).toEqual({initial:1,information:0});expect(row.first.initialEvent).toBeUndefined();expect(row.counts.initialRoute).toBeGreaterThan(0);expect(row.first.initialRoute!).toBeLessThan(d.boundaries.denySwitch!);expect(row.first.informationEvent!).toBeGreaterThan(d.boundaries.denySwitch!);expect(row.informationDiagnosticId).toBe(1);expect(row.scheme).toBe('HTTP');
  expect(f.guard.informationFailureCode).toBe('UNABORTED_OBSERVED_REQUEST');expect(f.guard.informationDiagnostics.counts).toMatchObject({seen:1,abortSucceeded:0,unmatched:1});expect(f.guard.stateVerified).toBe(false);expect(d.evidenceScope).toBe('DIAGNOSTIC_ONLY_NOT_WIRE_OR_ADMISSION_PROOF');privacy(f.guard);
 }finally{await f.dispose();}
},12000);

it('distinguishes new navigation/fetch during kill from INITIAL requests and retains real abort receipts with receiver0',async()=>{
 const f=await fixture();try{
  await f.load();const closing=f.guard.closeReadOnlyInformationPage();await f.started;
  await f.page.evaluate(()=>{void fetch('/information-fetch').catch(()=>{});});await f.page.goto(new URL('/information-navigation',f.page.url()).href,{timeout:1000}).catch(()=>{});
  const until=performance.now()+1000;while(f.guard.informationDiagnostics.counts.abortSucceeded<2&&performance.now()<until)await new Promise(r=>setTimeout(r,10));
  const d=f.guard.initialRouteCausalDiagnostics;expect(d.lastInformationRequests).toHaveLength(2);for(const row of d.lastInformationRequests){expect(row.first.initialRoute).toBeUndefined();expect(row.first.informationEvent!).toBeGreaterThan(d.boundaries.denySwitch!);expect(row.informationDiagnosticId).not.toBeNull();}
  expect(f.hits.information).toBe(0);expect(f.guard.informationDiagnostics.counts).toMatchObject({seen:2,abortSucceeded:2,unmatched:0});f.release();await closing;await f.guard.finishReadOnlyInformation();expect(f.guard.stateVerified).toBe(true);expect(f.guard.initialLoadHandoffVerified).toBeNull();privacy(f.guard);
 }finally{await f.dispose();}
},12000);

it('records a pending initial callback and a separate abort rejection without converting either completion or failed-event into an abort receipt',async()=>{
 const f=await fixture();let settle!:()=>void;
 try{
  await f.load();const request=(name:string):any=>({method:()=> 'GET',resourceType:()=> 'fetch',isNavigationRequest:()=>false,url:()=>`https://owned.invalid/${name}?secret=private_payload`,failure:()=>({errorText:'private_payload'})}),old=request('initial'),fresh=request('fresh');
  const pending=(f.guard as any).informationRoute({request:()=>old,fallback:()=>new Promise<void>(r=>settle=r)});expect(f.guard.initialRouteCausalDiagnostics.pendingInitialCallbacks).toBe(1);
  const closing=f.guard.closeReadOnlyInformationPage();await f.started;(f.guard as any).informationRequestSeen(fresh);await(f.guard as any).informationRoute({request:()=>fresh,abort:()=>Promise.reject(Error('private_payload'))});(f.context as any).emit('requestfailed',fresh);settle();await pending;
  const d=f.guard.initialRouteCausalDiagnostics,prior=d.lastRequests.find(x=>x.first.initialRoute!==undefined&&x.scheme==='HTTPS')!,now=d.lastInformationRequests[0]!;
  expect(prior.first.fallbackStarted!).toBeLessThan(d.boundaries.denySwitch!);expect(prior.last.fallbackSettled!).toBeGreaterThan(d.boundaries.denySwitch!);expect(prior.id).not.toBe(now.id);expect(now.failureClass).toBe('OTHER');expect(f.guard.informationDiagnostics.counts).toMatchObject({seen:1,abortSucceeded:0,abortFailed:1,unmatched:1});
  f.release();await closing;await f.guard.finishReadOnlyInformation();expect(f.guard.informationFailureCode).toBe('ABORT_FAILED');expect(f.guard.stateVerified).toBe(false);expect(f.guard.informationDiagnostics.lifecycle).toBe('FINAL');privacy(f.guard);
 }finally{settle?.();await f.dispose();}
},12000);

it('bounds the separate diagnostic namespace and keeps overflow out of price or wire proof',()=>{
 const context:any={browser:()=>null,on:()=>{},off:()=>{}},page:any={on:()=>{},context:()=>context},guard=new BookingUiBlockGuard(page,undefined,true);
 for(let i=0;i<1005;i++)(guard as any).causalMark({method:()=> 'PRIVATE',resourceType:()=> 'PRIVATE',url:()=> 'https://owned.invalid/?secret=private_payload',isNavigationRequest:()=>false},'initialEvent');
 const d=guard.initialRouteCausalDiagnostics;expect(d.trackedRequests).toBe(1000);expect(d.overflow).toBe(true);expect(d.lastRequests).toHaveLength(8);expect(d.lastRequests.every(x=>x.method==='OTHER'&&x.resourceType==='other'&&x.scheme==='HTTPS')).toBe(true);expect(guard.informationDiagnostics.counts).toMatchObject({seen:0,abortSucceeded:0,unmatched:0});privacy(guard);
});
