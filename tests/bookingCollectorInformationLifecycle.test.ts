// Execute the actual runner function, without importing its scheduled entry or any DB/API path.
// Every browser request is served by owned synthetic HTML. No external networking.
import {it,expect} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {chromium} from 'playwright';
import {createAnonymousBookingCaptureContext} from '../src/services/bookingProductObservability';
import {captureBookingRateCells,deriveBookingRateCell} from '../src/services/bookingRateCellEvidence';
import {BookingUiBlockGuard} from '../src/services/bookingUiBlockGuard';
import {classifyBlock} from '../src/services/crawlThrottlePolicy';
import {productFactsFixtureHtml} from './fixtures/bookingProductFactsPage';
import {guardedCalendarFixture} from './fixtures/bookingGuardedCalendarPage';
import {observeBookingInitialLoad} from '../src/services/bookingInitialLoadBarrier';

function actualCollector(dependencies:Record<string,unknown>){
 const path=new URL('../src/scripts/runAutoRunnerMarketRefreshRotating.ts',import.meta.url),source=readFileSync(path,'utf8');
 const parsed=ts.createSourceFile('runner.ts',source,ts.ScriptTarget.ES2022,true);
 const declaration=parsed.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='collectBookingLive');
 if(!declaration)throw Error('ACTUAL_COLLECTOR_NOT_FOUND');
 const body=ts.transpileModule(declaration.getText(parsed),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 return new Function(...Object.keys(dependencies),body+'\nreturn collectBookingLive;')(...Object.values(dependencies)) as (...args:any[])=>Promise<any[]>;
}

it('baseline screenshot resources cannot poison the strict information phase or stop later planned properties',async()=>{
 const browser=await chromium.launch({headless:true}),debug=mkdtempSync(join(tmpdir(),'booking-runner-lifecycle-'));
 let served=0,reservations=0,shots=0;
 const collect=actualCollector({chromium:{launch:async()=>browser},USER_AGENT:'synthetic-agent',
  createAnonymousBookingCaptureContext:async(b:typeof browser,agent:string)=>{
   const context=await createAnonymousBookingCaptureContext(b,agent);
   await context.route('**/*',route=>{served++;const missing=route.request().url().includes('/no-rate.ja.html');
    const body=route.request().url().includes('/baseline-shot')?'synthetic resource':missing?productFactsFixtureHtml().replace(/<table id='hprt-table'>[\s\S]*?<\/table>/u,''):productFactsFixtureHtml();
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
   });
   const newPage=context.newPage.bind(context);context.newPage=async()=>{const page=await newPage(),shot=page.screenshot.bind(page),wait=page.waitForTimeout.bind(page);
    page.waitForTimeout=async ms=>{if(ms!==5000)await wait(ms);};
    page.screenshot=(async options=>{shots++;await page.evaluate(()=>fetch('/baseline-shot'));return shot(options);}) as typeof page.screenshot;
    return page;
   };return context;
  },sleep:async()=>{},jitterDelayMs:()=>0,backoffDelayMs:()=>0,shouldEarlyStop:(n:number)=>n>=3,
  nextDay:()=> '2027-01-16',buildBookingRenderedDomUrl:({slug}:{slug:string})=>`https://www.booking.com/hotel/jp/${slug}.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY`,
  join,mkdirSync,writeFileSync,createHash,BookingUiBlockGuard,observeBookingInitialLoad,captureBookingRateCells,deriveBookingRateCell,classifyBlock,
  analyzeBookingRenderedDomSignals:()=>({synthetic:true}),buildBookingRenderedDomRow:(x:unknown)=>x,toPreviewRow:(x:unknown)=>x,
  sanitizeBookingUrl:()=> 'synthetic',toSingleLine:(x:unknown)=>String(x)});
 const targets=['no-rate','external','external-two'].map(property_slug=>({property_slug,canonical_property_name:'synthetic',checkin:'2027-01-15'})),captures:Array<Record<string,unknown>>=[];
 try{
  const rows=await collect(targets,debug,'2027-01-15T00:00:00+09:00',undefined,captures,()=>{reservations++;return true;});
  expect(rows).toHaveLength(3);expect(reservations).toBe(3);expect(shots).toBe(3);expect(served).toBe(6);
  expect(captures).toHaveLength(3);expect(captures[0]?.problems).toContain('NO_RATE_TABLE_NO_INTERACTION');
  expect(captures.slice(1).every(x=>x.cells===1&&x.pageFinalBlockStateVerified===true&&x.informationRequestRefused===false)).toBe(true);
  expect(captures.every(x=>x.marketPriceEligible===false)).toBe(true);
 }finally{await browser.close();rmSync(debug,{recursive:true,force:true});}
},30000);

async function runFreshLoadFixture(mode:'delayed-baseline'|'click-post'|'timeout'|'without-barrier'|'precheck-baseline'|'during-arm'|'quantity-change'|'header-change'){
 const browser=await chromium.launch({headless:true}),debug=mkdtempSync(join(tmpdir(),'booking-fresh-load-'));
 let documents=0,baselinePosts=0,reservations=0,barrierEntries=0,armed=0,informationClicks=0;
 let fixturePage:any;
 class ObservedGuard extends BookingUiBlockGuard {private injected=false;async armReadOnlyInformation(){if(['precheck-baseline','quantity-change','header-change'].includes(mode)&&!this.injected){this.injected=true;await fixturePage.evaluate((m:string)=>{setTimeout(()=>{if(m==='precheck-baseline')void fetch('/precheck-delayed',{method:'POST'}).catch(()=>{});else if(m==='quantity-change')(document.querySelector('#hprt-table select') as HTMLSelectElement).value='1';else document.querySelector('[data-testid="searchbox-dates-container"]')!.setAttribute('aria-label','2027年1月17日(日) — 2027年1月18日(月)');},250);},mode);}await super.armReadOnlyInformation();armed++;}}
 const readiness=mode==='timeout'?()=>({waitForFreshQuiet:async()=>{barrierEntries++;return {status:'TIMED_OUT_NO_INFORMATION'};},finishQuietHandoff:()=>false,dispose:()=>{}}):mode==='without-barrier'?()=>({waitForFreshQuiet:async()=>({status:'QUIET_BEFORE_INFORMATION'}),finishQuietHandoff:()=>true,dispose:()=>{}}):(page:any)=>{const b=observeBookingInitialLoad(page);return {...b,waitForFreshQuiet:async()=>{barrierEntries++;return b.waitForFreshQuiet();}};};
 const collect=actualCollector({chromium:{launch:async()=>browser},USER_AGENT:'synthetic-agent',observeBookingInitialLoad:readiness,
  createAnonymousBookingCaptureContext:async(b:typeof browser,agent:string)=>{
   const context=await createAnonymousBookingCaptureContext(b,agent);
   await context.route('**/*',route=>{if(route.request().isNavigationRequest())documents++;else if(route.request().method()==='POST')baselinePosts++;
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:mode==='header-change'?productFactsFixtureHtml():guardedCalendarFixture(mode==='click-post'?'http-POST':'normal')});});
   if(mode==='during-arm'){const route=context.route.bind(context);context.route=(async(...args:Parameters<typeof context.route>)=>{const installed=await route(...args);await fixturePage.evaluate(()=>fetch('/during-arm',{method:'POST'}).catch(()=>{}));return installed;}) as typeof context.route;}
   const newPage=context.newPage.bind(context);context.newPage=async()=>{const page=await newPage(),wait=page.waitForTimeout.bind(page);
    fixturePage=page;
    await page.addInitScript(()=>{(window as any).fixtureInformationClicks=0;document.addEventListener('click',e=>{if(e.target instanceof Element&&e.target.closest('[data-testid="searchbox-dates-container"],[id^="room_type_id_"],button[aria-controls]'))(window as any).fixtureInformationClicks++;},true);});
    const close=page.close.bind(page);page.close=(async options=>{informationClicks+=await page.evaluate(()=>(window as any).fixtureInformationClicks??0).catch(()=>0);return close(options);}) as typeof page.close;
    page.waitForTimeout=async ms=>{if(ms!==5000)await wait(ms);};
    page.screenshot=(async()=>{if(mode==='delayed-baseline'||mode==='without-barrier')await page.evaluate(()=>{setTimeout(()=>{void fetch('/baseline-delayed',{method:'POST'}).catch(()=>{});},250);});return Buffer.alloc(0);}) as typeof page.screenshot;
    return page;
   };return context;
  },sleep:async()=>{},jitterDelayMs:()=>0,backoffDelayMs:()=>0,shouldEarlyStop:(n:number)=>n>=3,
  nextDay:()=> '2027-01-16',buildBookingRenderedDomUrl:({slug}:{slug:string})=>`https://www.booking.com/hotel/jp/${slug}.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY`,
  join,mkdirSync,writeFileSync,createHash,BookingUiBlockGuard:ObservedGuard,captureBookingRateCells,deriveBookingRateCell,classifyBlock,
  analyzeBookingRenderedDomSignals:()=>({synthetic:true}),buildBookingRenderedDomRow:(x:unknown)=>x,toPreviewRow:(x:unknown)=>x,
  sanitizeBookingUrl:()=> 'synthetic',toSingleLine:(x:unknown)=>String(x)});
 const targets=['external','external-two'].map(property_slug=>({property_slug,canonical_property_name:'synthetic',checkin:'2027-01-15'})),captures:Array<Record<string,unknown>>=[];
 try{const rows=await collect(targets,debug,'2027-01-15T00:00:00+09:00',undefined,captures,()=>{reservations++;return true;});return {rows,captures,documents,baselinePosts,reservations,barrierEntries,armed,informationClicks};}
 finally{await browser.close();rmSync(debug,{recursive:true,force:true});}
}
it('waits for a fresh passive window after screenshots; delayed baseline POST never enters the information guard',async()=>{const r=await runFreshLoadFixture('delayed-baseline');expect(r.rows).toHaveLength(2);expect(r.documents).toBe(2);expect(r.baselinePosts).toBe(2);expect(r.barrierEntries).toBe(2);expect(r.captures.every(c=>c.cells===1&&c.informationRequestRefused===false&&c.pageFinalBlockStateVerified===true)).toBe(true);expect(r.captures.every(c=>(c.initialLoadReadiness as any).status==='QUIET_BEFORE_INFORMATION')).toBe(true);},30000);
it('a click-triggered POST is still aborted and globally stops the actual collector',async()=>{const r=await runFreshLoadFixture('click-post');expect(r.rows).toHaveLength(1);expect(r.reservations).toBe(1);expect(r.documents).toBe(1);expect(r.baselinePosts).toBe(0);expect(r.captures[0]).toMatchObject({cells:0,informationRequestRefused:true,pageFinalBlockStateVerified:false});},30000);
it('a never-quiet page receives no information interaction or retry',async()=>{const r=await runFreshLoadFixture('timeout');expect(r.rows).toHaveLength(2);expect(r.armed).toBe(0);expect(r.barrierEntries).toBe(2);expect(r.captures.every(c=>c.status==='INITIAL_LOAD_NOT_QUIESCENT_NO_INFORMATION')).toBe(true);expect(r.baselinePosts).toBe(0);},30000);
it('reproduces the delayed baseline race when the fresh barrier is synthetically omitted',async()=>{const r=await runFreshLoadFixture('without-barrier');expect(r.rows).toHaveLength(1);expect(r.baselinePosts).toBe(0);expect(r.captures[0]).toMatchObject({cells:0,informationRequestRefused:true,pageFinalBlockStateVerified:false});},30000);
it('checks quiet at the arm boundary after passive prechecks, before any information click',async()=>{const r=await runFreshLoadFixture('precheck-baseline');expect(r.rows).toHaveLength(2);expect(r.baselinePosts).toBe(2);expect(r.barrierEntries).toBe(2);expect(r.captures.every(c=>c.cells===1&&c.initialLoadHandoffVerified===true&&c.informationRequestRefused===false&&c.initialLoadReadinessPhase==='IMMEDIATELY_BEFORE_INFORMATION_ARM')).toBe(true);},30000);
it('traffic during guard installation stays denied and cannot inherit the earlier quiet snapshot',async()=>{const r=await runFreshLoadFixture('during-arm');expect(r.rows).toHaveLength(1);expect(r.baselinePosts).toBe(0);expect(r.captures[0]).toMatchObject({cells:0,initialLoadHandoffVerified:false,informationRequestRefused:true,pageFinalBlockStateVerified:false,observedDeniedRequestPhase:'ARMING'});},30000);
it('quantity changes during the fresh wait prevent the first calendar click',async()=>{const r=await runFreshLoadFixture('quantity-change');expect(r.rows).toHaveLength(2);expect(r.informationClicks).toBe(0);expect(r.captures.every(c=>c.cells===0&&c.initialLoadHandoffVerified===true)).toBe(true);},30000);
it('passive-year header changes during the fresh wait prevent all room, tax and policy clicks',async()=>{const r=await runFreshLoadFixture('header-change');expect(r.rows).toHaveLength(2);expect(r.informationClicks).toBe(0);expect(r.captures.every(c=>c.cells===0&&c.initialLoadHandoffVerified===true)).toBe(true);},30000);
