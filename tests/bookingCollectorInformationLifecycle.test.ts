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
  join,mkdirSync,writeFileSync,createHash,BookingUiBlockGuard,captureBookingRateCells,deriveBookingRateCell,classifyBlock,
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
