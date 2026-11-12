// Actual Node/tsx serialized browser callbacks; every page request is local fixture HTML.
import {chromium} from 'playwright';
import {guardedCalendarFixture} from './bookingGuardedCalendarPage.ts';
import {createAnonymousBookingCaptureContext} from '../../src/services/bookingProductObservability.ts';
import {BookingUiBlockGuard} from '../../src/services/bookingUiBlockGuard.ts';
import {captureBookingRateCells,deriveBookingRateCell} from '../../src/services/bookingRateCellEvidence.ts';
const browser=await chromium.launch({headless:true});const context=await createAnonymousBookingCaptureContext(browser,'synthetic-runtime');const page=await context.newPage();let requests=0;
await page.route('**/*',r=>{requests++;return r.fulfill({status:200,contentType:'text/html; charset=utf-8',body:guardedCalendarFixture()});});
await page.goto('https://www.booking.com/hotel/jp/external.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY');const guard=new BookingUiBlockGuard(page);
try{const cap=await captureBookingRateCells(page,{propertySlug:'external',checkin:'2027-01-15',checkout:'2027-01-16',observedAt:'2026-10-31T00:00:00Z'},3,guard);const result={cells:cap.cells.length,problems:cap.problems,bound:cap.cells.map(c=>deriveBookingRateCell(cap,c).tupleAndProductBound),calendarProof:cap.selectedCalendarEvidence?.kind??null,requests,quantity:await page.locator('select').inputValue(),guardClear:guard.stateVerified&&!guard.informationRequestRefused};if(result.cells!==1||result.problems.length||result.bound[0]!==true||result.calendarProof!=='BOOKING_SELECTED_CALENDAR_STAY_V1'||requests!==1||result.quantity!=='0'||!result.guardClear)throw Error('GUARDED_CALENDAR_TSX_INTEROP_REFUSED:'+JSON.stringify(result));process.stdout.write(JSON.stringify(result)+'\n');}
finally{await page.close();await guard.finishReadOnlyInformation();guard.dispose();await context.close();await browser.close();}
