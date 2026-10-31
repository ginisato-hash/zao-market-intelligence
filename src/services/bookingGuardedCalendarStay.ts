import {createHash} from 'node:crypto';
// Selected dates only. No navigation, date selection, price authority or network allowlist.
import type {Page} from 'playwright';
import type {BookingUiBlockGuard} from './bookingUiBlockGuard';
import {canonicalJson} from './marketEvidenceSidecar';
import {bookingInformationTextSafe,readBookingHeaderSnapshot,parseExplicitBookingStayLabels} from './bookingProductObservability';
export interface BookingSelectedCalendarEvidence {
 kind:'BOOKING_SELECTED_CALENDAR_STAY_V1';scope:'HP_AVAILABILITY';calendarTestId:'searchbox-datepicker-calendar';
 outerText:string;startText:string;endText:string;party:string;
 selected:{ariaLabel:string;dateAttribute:string;gridHeading:string;headingId:string}[];
 openedFromClosed:true;closedAfterRead:true;headerUnchanged:true;informationGuardClear:true;availabilityUnchanged:true;materialBeforeSha256:string;materialAfterSha256:string;
}
export function parseBookingSelectedCalendarEvidence(value:unknown):{checkin:string;checkout:string}|null{
 if(!value||typeof value!=='object')return null;const e=value as BookingSelectedCalendarEvidence;
 if(e.kind!=='BOOKING_SELECTED_CALENDAR_STAY_V1'||e.scope!=='HP_AVAILABILITY'||e.calendarTestId!=='searchbox-datepicker-calendar'||e.openedFromClosed!==true||e.closedAfterRead!==true||e.headerUnchanged!==true||e.informationGuardClear!==true||e.availabilityUnchanged!==true||typeof e.materialBeforeSha256!=='string'||!/^[0-9a-f]{64}$/u.test(e.materialBeforeSha256)||e.materialAfterSha256!==e.materialBeforeSha256||!Array.isArray(e.selected)||e.selected.length!==2)return null;
 if(![e.outerText,e.startText,e.endText,e.party].every(s=>typeof s==='string'&&bookingInformationTextSafe(s,200)))return null;
 if(!/^宿泊人数と部屋数[。:]?\s*(?:選択済みの内容[:]?\s*)?大人\s*2名\s*(?:[·・,、]\s*)?子供\s*0名\s*(?:[·・,、]\s*)?1部屋[。.]?$/u.test(e.party.normalize('NFKC').trim().replace(/\s+/gu,' ')))return null;
 const roles=new Map<string,{date:string;fullLabel:string}>();
 for(const cell of e.selected){
  if(!cell||![cell.ariaLabel,cell.dateAttribute,cell.gridHeading,cell.headingId].every(s=>typeof s==='string'&&bookingInformationTextSafe(s,180)))return null;
  const m=/^(\d{4}年\d{1,2}月\d{1,2}日[日月火水木金土]曜日),\s*(チェックイン日|チェックアウト日)$/u.exec(cell.ariaLabel.normalize('NFKC').trim());
  if(!m||roles.has(m[2]!)||!/^\d{4}-\d{2}-\d{2}$/u.test(cell.dateAttribute))return null;
  const full=/^(\d{4})年(\d{1,2})月(\d{1,2})日/u.exec(m[1]!)!,year=full[1]!,month=Number(full[2]),day=Number(full[3]);
  // The year comes from the full, role-labelled ARIA text. data-date and the
  // visible owning grid heading are redundant agreement checks, never fallbacks.
  if(cell.dateAttribute!==year+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0')||cell.gridHeading.normalize('NFKC').trim()!==year+'年'+month+'月'||![`bui-calendar-month-${year}-${month}`,`bui-calendar-month-${year}-${String(month).padStart(2,'0')}`].includes(cell.headingId))return null;
  roles.set(m[2]!,{date:cell.dateAttribute,fullLabel:m[1]!});
 }
 const start=roles.get('チェックイン日'),end=roles.get('チェックアウト日');if(!start||!end)return null;
 const full=start.fullLabel+' — '+end.fullLabel,stay=parseExplicitBookingStayLabels(full,null);
 if(!stay||stay.checkin!==start.date||stay.checkout!==end.date||!parseExplicitBookingStayLabels(e.outerText,full)||!parseExplicitBookingStayLabels(e.startText+' — '+e.endText,full))return null;
 return stay;
}
async function availabilityMaterial(page:Page){
 const table=page.locator('#hprt-table');if(await table.count()!==1)throw Error('AVAILABILITY_MATERIAL_NOT_UNIQUE');
 return table.evaluate(e=>{
  if(!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||e.getBoundingClientRect().width===0||e.getBoundingClientRect().height===0||e.closest('[hidden],[aria-hidden="true"]'))throw Error('AVAILABILITY_MATERIAL_NOT_VISIBLE');
  const html=e.outerHTML,rows=e.querySelectorAll('tr[data-block-id]'),selects=Array.from(e.querySelectorAll('select'));
  if(html.length>512000||rows.length<1||rows.length>200||selects.length<1||selects.length>200)throw Error('AVAILABILITY_MATERIAL_BUDGET');
  const quantities=selects.map(s=>(s as HTMLSelectElement).value);if(quantities.some(v=>v!=='0'))throw Error('PRESELECTED_ROOM_QUANTITY');
  return {html,quantities}; // RAM-only comparison. No HTML is retained in the sealed capture.
 });
}
export async function readBookingGuardedCalendarStay(page:Page,guard:BookingUiBlockGuard,expected:{checkin:string;checkout:string}){
 const header=await readBookingHeaderSnapshot(page),partial=header.dateText.normalize('NFKC').trim().replace(/^日付を選択\s+/u,'');
 const parts=/^(\d{1,2}月\d{1,2}日\([日月火水木金土]\))\s*[–—〜~−-]\s*(\d{1,2}月\d{1,2}日\([日月火水木金土]\))$/u.exec(partial);
 // Limit this path to the observed yearless markup. Ambiguous, conflicting or
 // partially explicit fields keep their existing no-interaction denial.
 if(header.dateCount!==1||header.partyCount!==1||!header.dateVisible||!header.partyVisible||header.expanded!=='false'||header.dateAria!==null||header.dateFields.length!==2||!parts||parts[1]===parts[2])return null;
 if(header.dateFields.some((f,i)=>f.id!==`date-display-field-${i===0?'start':'end'}`||f.count!==1||!f.visible||f.aria!==null||f.title!==null||f.times.length!==0||f.unapprovedEmbeddedState!==false||!/^\d{1,2}月\d{1,2}日\([日月火水木金土]\)$/u.test(f.text.normalize('NFKC').trim())))return null;
 if(header.dateFields.some((f,i)=>f.text.normalize('NFKC').trim()!==parts[i+1]))return null;
 // Requested dates are an early rejection check only. They never provide a
 // missing year: the positive witness still requires both full selected ARIA dates.
 for(const [i,date]of [expected?.checkin,expected?.checkout].entries()){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(date))return null;const at=new Date(date+'T00:00:00Z');
  if(!Number.isFinite(at.getTime())||at.toISOString().slice(0,10)!==date||parts[i+1]!==`${at.getUTCMonth()+1}月${at.getUTCDate()}日(${'日月火水木金土'[at.getUTCDay()]})`)return null;
 }
 const party=header.party?.normalize('NFKC').trim().replace(/\s+/gu,' ');
 if(!party||!bookingInformationTextSafe(party,200)||!/^宿泊人数と部屋数[。:]?\s*(?:選択済みの内容[:]?\s*)?大人\s*2名\s*(?:[·・,、]\s*)?子供\s*0名\s*(?:[·・,、]\s*)?1部屋[。.]?$/u.test(party))return null;
 const scope=page.locator('#hp_availability_style_changes'),button=scope.getByTestId('searchbox-dates-container'),calendar=scope.getByTestId('searchbox-datepicker-calendar');
 if(await button.getAttribute('type')!=='button'||await page.locator('[data-testid="searchbox-datepicker-calendar"]:visible').count()!==0)return null;
 const beforeMaterial=canonicalJson(await availabilityMaterial(page));
 await guard.requireClear();if(canonicalJson(await readBookingHeaderSnapshot(page))!==canonicalJson(header))throw Error('CALENDAR_HEADER_CHANGED_BEFORE_ARM');
 // The unchanged context-wide guard rejects ALL new HTTP, including GET/HEAD,
 // analytics and datepicker fetch. It remains armed until page.close.
 await guard.armReadOnlyInformation();await guard.requireClear();
 let opened=false,identified=false,selected:BookingSelectedCalendarEvidence['selected']=[];
 try{
  if(canonicalJson(await readBookingHeaderSnapshot(page))!==canonicalJson(header))throw Error('CALENDAR_HEADER_CHANGED_BEFORE_CLICK');
  opened=true;await button.click({timeout:2000});await guard.requireClear();
  if(await button.getAttribute('aria-expanded')!=='true'||await calendar.count()!==1||!await calendar.isVisible()||await page.locator('[data-testid="searchbox-datepicker-calendar"]:visible').count()!==1)throw Error('CONTROLLED_CALENDAR_NOT_UNIQUE');identified=true;
  selected=await calendar.evaluate(root=>{
   if(!root.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||root.closest('[hidden],[aria-hidden="true"]'))throw Error('CALENDAR_NOT_VISIBLE');
   const cells=Array.from(root.querySelectorAll('[role="gridcell"][aria-selected="true"]')).filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&!e.closest('[hidden],[aria-hidden="true"]'));
   if(cells.length!==2)throw Error('SELECTED_DATE_ROLES_NOT_TWO');
   return cells.map(cell=>{
    const spans=Array.from(cell.querySelectorAll('[data-date]')).filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0&&!e.closest('[hidden],[aria-hidden="true"]'));
    const grid=cell.closest('[role="grid"]'),id=grid?.getAttribute('aria-labelledby')??'';
    if(spans.length!==1||!grid||!root.contains(grid)||!/^bui-calendar-month-\d{4}-\d{1,2}$/u.test(id))throw Error('SELECTED_DATE_SCOPE');
    const headings=root.querySelectorAll(`[id="${id}"]`),heading=headings[0];
    if(headings.length!==1||!heading||!heading.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||heading.getBoundingClientRect().width===0||heading.getBoundingClientRect().height===0||heading.closest('[hidden],[aria-hidden="true"]'))throw Error('DATE_HEADING_NOT_VISIBLE_UNIQUE');
    const label=cell.getAttribute('aria-label')??'';
    if(label!==spans[0]!.getAttribute('aria-label'))throw Error('SELECTED_DATE_LABEL_CONFLICT');
    return {ariaLabel:label.slice(0,181),dateAttribute:(spans[0]!.getAttribute('data-date')??'').slice(0,41),gridHeading:(heading as HTMLElement).innerText.slice(0,81),headingId:id};
   });
  });await guard.requireClear();
 }finally{
  if(opened&&!identified&&await guard.checkpoint())throw Error('CALENDAR_INFORMATION_UNBOUND_STOP');
  if(opened&&identified&&await guard.checkpoint()){
   if(await button.getAttribute('aria-expanded')!=='true')throw Error('CALENDAR_STATE_CHANGED');
   await button.click({timeout:2000});await guard.requireClear();
   if(await button.getAttribute('aria-expanded')!=='false'||await calendar.isVisible())throw Error('CALENDAR_CLOSE_UNVERIFIED');
  }
 }
 await guard.requireClear();if(canonicalJson(await readBookingHeaderSnapshot(page))!==canonicalJson(header))throw Error('CALENDAR_HEADER_CHANGED_AFTER_CLOSE');
 const afterMaterial=canonicalJson(await availabilityMaterial(page));if(afterMaterial!==beforeMaterial)throw Error('CALENDAR_AVAILABILITY_MATERIAL_CHANGED');
 const materialBeforeSha256=createHash('sha256').update(beforeMaterial).digest('hex'),materialAfterSha256=createHash('sha256').update(afterMaterial).digest('hex');
 const evidence:BookingSelectedCalendarEvidence={kind:'BOOKING_SELECTED_CALENDAR_STAY_V1',scope:'HP_AVAILABILITY',calendarTestId:'searchbox-datepicker-calendar',outerText:header.dateText,startText:header.dateFields[0]!.text,endText:header.dateFields[1]!.text,party,selected,openedFromClosed:true,closedAfterRead:true,headerUnchanged:true,informationGuardClear:true,availabilityUnchanged:true,materialBeforeSha256,materialAfterSha256};
 const stay=parseBookingSelectedCalendarEvidence(evidence);return stay?{header,stay,party,evidence}:null;
}
