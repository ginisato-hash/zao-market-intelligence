// Actual Node/tsx and local browser serialization check; all requests are fulfilled by synthetic HTML.
import {chromium} from 'playwright';
import {productFactsFixtureHtml} from './bookingProductFactsPage.ts';
import {createAnonymousBookingCaptureContext,readBookingProductFacts} from '../../src/services/bookingProductObservability.ts';
import {captureBookingRateCells,deriveBookingRateCell} from '../../src/services/bookingRateCellEvidence.ts';
import {BookingUiBlockGuard} from '../../src/services/bookingUiBlockGuard.ts';
globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_FIXTURE');};
const browser=await chromium.launch({headless:true});let context,requests=0;
try{context=await createAnonymousBookingCaptureContext(browser,'synthetic-agent');const page=await context.newPage();await page.route('**/*',route=>{requests++;return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:productFactsFixtureHtml()});});
 await page.goto('https://www.booking.com/hotel/jp/external.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY');
 const guard=new BookingUiBlockGuard(page),cap=await captureBookingRateCells(page,{propertySlug:'external',checkin:'2027-01-15',checkout:'2027-01-16',observedAt:'2026-10-30T00:00:00Z'},1,guard),cell=cap.cells[0];
 if(!cell||cap.problems.length)throw Error('ACTUAL_TSX_CAPTURE_FAILED');const derived=deriveBookingRateCell(cap,cell),facts=readBookingProductFacts(cap,cell,derived);
 await page.close();await guard.finishReadOnlyInformation();guard.dispose();
 console.log(JSON.stringify({parserVersion:cap.parserVersion,cells:cap.cells.length,primitiveBound:derived.tupleAndProductBound,maximumAdults:facts.maximumAdults,publicPriceProved:facts.publicPriceProved,taxInformationCaptured:facts.allMandatoryText!==null,pageFinalStateVerified:guard.stateVerified,localRequests:requests,providerRequests:0,pricePosts:0}));
}finally{await context?.close();await browser.close();}
