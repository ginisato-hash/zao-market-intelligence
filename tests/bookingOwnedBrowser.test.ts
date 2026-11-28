import {it,expect,vi} from 'vitest';
import http from 'node:http';
import {chromium,type BrowserServer} from 'playwright';
import {launchOwnedBookingBrowser,terminateOwnedBookingBrowser,ownedBookingBrowserStatus} from '../src/services/bookingOwnedBrowser';
import {createAnonymousBookingCaptureContext} from '../src/services/bookingProductObservability';
import {BookingUiBlockGuard} from '../src/services/bookingUiBlockGuard';

// Only owned loopback HTML/JS. The independent receiving server detects traffic
// that Playwright route/request observations miss; no OTA/production API is used.
async function fixture(){
 const hits={closing:0,queued:0,workers:0};let port=0;
 const server=http.createServer((request,response)=>{
  const path=request.url??'';let body='owned',type='text/html';
  if(path==='/main')body=`<html><body><iframe src="http://frame.other-synthetic.test:${port}/frame"></iframe><script>
   addEventListener('pagehide',()=>fetch('/closing-main',{keepalive:true}).catch(()=>{}));
   addEventListener('unload',()=>navigator.sendBeacon('/closing-beacon','owned'));
   window.w=new Worker('/worker.js');window.sharedBlocked=false;
   window.ready=Promise.all([new Promise(r=>w.onmessage=r),new Promise(r=>{try{window.s=new SharedWorker('/shared.js');s.port.start();s.port.onmessage=r;s.onerror=()=>{window.sharedBlocked=true;r();};}catch{window.sharedBlocked=true;r();}})]);
  </script></body></html>`;
  else if(path==='/frame')body=`<html><body>owned<script>addEventListener('pagehide',()=>navigator.sendBeacon('/closing-frame','owned'));</script></body></html>`;
  else if(path==='/worker.js'){type='text/javascript';body=`postMessage('ready');onmessage=()=>fetch('/queued-worker',{keepalive:true}).catch(()=>{});`;hits.workers++;}
  else if(path==='/shared.js'){type='text/javascript';body=`onconnect=e=>{const p=e.ports[0];p.start();p.postMessage('ready');p.onmessage=()=>fetch('/queued-shared',{keepalive:true}).catch(()=>{});};`;hits.workers++;}
  else if(path.startsWith('/closing'))hits.closing++;
  else if(path.startsWith('/queued'))hits.queued++;
  response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});response.end(body);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('OWNED_BIND');port=address.port;
 return {hits,url:`http://root.synthetic.test:${port}/main`,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
const args=['--no-proxy-server','--site-per-process','--host-resolver-rules=MAP root.synthetic.test 127.0.0.1, MAP frame.other-synthetic.test 127.0.0.1'];
async function ownFixture(mode:'normal'|'disconnect'|'abort-timeout'|'kill-reject'|'kill-timeout'|'client-disconnect-timeout'|'capture-exception'){
 const f=await fixture(),realLaunch=chromium.launchServer.bind(chromium);let server!:BrowserServer,killCalls=0;
 const launch=vi.spyOn(chromium,'launchServer').mockImplementation(async options=>{
  server=await realLaunch({...options,args:[...(options?.args??[]),...args]});const kill=server.kill.bind(server);
  server.kill=async()=>{killCalls++;await kill();if(mode==='kill-reject')throw Error('owned synthetic rejection');if(mode==='kill-timeout')await new Promise<void>(()=>{});};return server;
 });
 const realConnect=chromium.connect.bind(chromium);
 const connect=vi.spyOn(chromium,'connect').mockImplementation(async(...params:Parameters<typeof chromium.connect>)=>{
  const browser=await realConnect(...params);if(mode==='client-disconnect-timeout'){const once=browser.once.bind(browser);browser.once=((name:any,listener:any)=>name==='disconnected'?browser:once(name,listener)) as typeof browser.once;}return browser;
 });
 const browser=await launchOwnedBookingBrowser();connect.mockRestore();launch.mockRestore();const context=await createAnonymousBookingCaptureContext(browser,'OwnedFixture/1'),page=await context.newPage();
 const guard=new BookingUiBlockGuard(page,undefined,true);
 try{
  await page.goto(f.url,{waitUntil:'load',timeout:5000});await page.evaluate(()=>(window as any).ready);
  expect(await page.evaluate(()=>(window as any).sharedBlocked)).toBe(true);
  expect(page.frames()).toHaveLength(2);const cdp=await context.newCDPSession(page.frames()[1]!);await cdp.detach(); // True OOPIF, not merely another origin.
  await guard.armReadOnlyInformation();
  if(mode==='normal'){
   await page.evaluate(()=>{void fetch('/queued-main',{keepalive:true}).catch(()=>{});(window as any).w.postMessage('send');(window as any).s?.port.postMessage('send');});
   const until=performance.now()+2000;while(guard.informationDiagnostics.counts.seen<2&&performance.now()<until)await new Promise(r=>setTimeout(r,10));
   console.log('OWNED_QUEUED_DIAGNOSTIC',JSON.stringify({hits:f.hits,counts:guard.informationDiagnostics.counts}));
   expect(guard.informationDiagnostics.counts.seen).toBe(2);await guard.checkpoint();
  }
  if(mode==='abort-timeout'){
   const request:any={method:()=> 'GET',resourceType:()=> 'fetch',isNavigationRequest:()=>false};
   (guard as any).informationRequestSeen(request);void (guard as any).informationRoute({request:()=>request,abort:()=>new Promise(()=>{})});
  }
  if(mode==='disconnect')await browser.close(); // Public client disconnect; server auto-disposes its contexts.
  if(mode==='capture-exception'){
   try{throw Error('owned capture exception');}catch{await terminateOwnedBookingBrowser(browser);}
  }else{
   await guard.closeReadOnlyInformationPage().catch(()=>{});await guard.finishReadOnlyInformation().catch(()=>{});
  }
  await new Promise(r=>setTimeout(r,200));
  expect(f.hits).toEqual({closing:0,queued:0,workers:1});expect(killCalls).toBe(1);
  expect(server.process().exitCode!==null||server.process().signalCode!==null).toBe(true);
  expect(ownedBookingBrowserStatus(browser)).toMatchObject({terminationStarted:true,processExited:true,serverClosed:true});
  if(mode==='normal'){
   expect(guard.stateVerified).toBe(true);expect(guard.informationDiagnostics.termination).toMatchObject({mode:'OWNED_PROCESS_KILL',verified:true});
   expect(guard.informationDiagnostics.counts).toMatchObject({seen:2,abortSucceeded:2,unmatched:0,abortPending:0});
  }else if(mode!=='capture-exception'){expect(guard.hardStop).toBe(true);expect(guard.stateVerified).toBe(false);}
  return guard.informationFailureCode;
 }finally{
  // Never gracefully close a live fixture during assertion failure either.
  if(!ownedBookingBrowserStatus(browser).terminationStarted)await terminateOwnedBookingBrowser(browser).catch(()=>{});
  await f.close();
 }
}

it('positive control: graceful page close sends an unobserved owned keepalive; this is not actual OTA evidence',async()=>{
 const f=await fixture(),browser=await chromium.launch({headless:true,args}),context=await createAnonymousBookingCaptureContext(browser,'OwnedControl/1'),page=await context.newPage();
 try{await page.goto(f.url,{waitUntil:'load'});await page.evaluate(()=>(window as any).ready);const guard=new BookingUiBlockGuard(page,undefined,true);await guard.armReadOnlyInformation();await guard.closeReadOnlyInformationPage();await guard.finishReadOnlyInformation();await new Promise(r=>setTimeout(r,200));expect(f.hits.closing).toBeGreaterThan(0);expect(guard.informationDiagnostics.counts.seen).toBe(0);}
 finally{await browser.close();await f.close();}
},15000);
it('owned process exit blocks main/OOPIF unload traffic; shared workers are denied and main/dedicated worker queued requests retain real abort receipts',async()=>{await ownFixture('normal');},15000);
it('unexpected client disconnect is sticky STOP and kills its owner without another target',async()=>{expect(await ownFixture('disconnect')).toBeTruthy();},15000);
it('drain timeout still issues owned kill once and never manufactures a successful abort',async()=>{expect(await ownFixture('abort-timeout')).toBe('ABORT_DRAIN_TIMEOUT');},15000);
it('kill rejection is not verified even if the process actually exited',async()=>{expect(await ownFixture('kill-reject')).toBe('OWNED_BROWSER_TERMINATION_FAILED');},15000);
it('kill cleanup timeout is bounded and never falls back to graceful close',async()=>{expect(await ownFixture('kill-timeout')).toBe('OWNED_BROWSER_TERMINATION_FAILED');},15000);
it('process/server exit alone cannot verify termination before client protocol disconnect',async()=>{expect(await ownFixture('client-disconnect-timeout')).toBe('OWNED_BROWSER_TERMINATION_FAILED');},15000);
it('an intermediate capture exception also terminates its own process without unload dispatch',async()=>{await ownFixture('capture-exception');},15000);
