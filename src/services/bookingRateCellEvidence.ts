// Bounded, selected-product evidence from the public page already loaded by the collector.
// No booking selection/submission, price API, credentials or whole-page text export.
import type { Page } from 'playwright';
import { BookingUiBlockGuard } from './bookingUiBlockGuard';
import type { BlockReason } from './crawlThrottlePolicy';
import { createHash } from 'node:crypto';
import { scrubExcerpt,canonicalJson,K27_T04_REFERENCE } from './marketEvidenceSidecar';
export interface BookingRateCell {
  blockId:string;roomName:string;roomText:string;occupancyText:string;priceText:string;conditionsText:string;
  oneRoomOptionText:string;policyControlId:string|null;policyContainerId:string|null;policyText:string|null;
  priceRoleText?:string;taxDetails?:Array<{label:string;details:string}>;
}
export interface BookingRateCellCapture {
  schema:'ZMI_BOOKING_RATE_CELLS_V1';parserVersion:'booking-rate-cell-v2'|'booking-rate-cell-v3';propertySlug:string;observedAt:string;
  request:{checkin:string;checkout:string;adults:2;children:0;rooms:1;currency:'JPY'};
  requestUrlMatches:boolean;displayedCheckin:string|null;displayedCheckout:string|null;displayedParty:string;
  cells:BookingRateCell[];problems:string[];blockReason:BlockReason;blockStateVerified:boolean;captureSha256:string;
}
const isoDate=(s:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(s)&&Number.isFinite(Date.parse(s+'T00:00:00Z'))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const yen=(s:string)=>[...s.matchAll(/[￥¥]\s*([\d,]+)/gu)].map(m=>Number(m[1]!.replace(/,/gu,''))).filter(Number.isSafeInteger);
export function deriveBookingRateCell(cap:BookingRateCellCapture,cell:BookingRateCell){
  const reasons:string[]=[],m=/^(\d+)_(\d+)_(\d+)_(\d+)_(\d+)$/u.exec(cell.blockId);
  if(cap.schema!=='ZMI_BOOKING_RATE_CELLS_V1'||!['booking-rate-cell-v2','booking-rate-cell-v3'].includes(cap.parserVersion))reasons.push('CAPTURE_SCHEMA_UNKNOWN');
  const {captureSha256,...unsigned}=cap;
  if(captureSha256!==createHash('sha256').update(canonicalJson(unsigned)).digest('hex'))reasons.push('CAPTURE_SEAL_INVALID');
  const ownCells=cap.cells.filter(c=>c.blockId===cell.blockId);
  if(ownCells.length!==1||canonicalJson(ownCells[0])!==canonicalJson(cell))reasons.push('CELL_NOT_UNIQUE_IN_CAPTURE');
  if(!m||Number(m[3])!==2||Number(m[4])!==0||Number(m[5])!==0)reasons.push('NOT_EXACT_TWO_ADULT_RATE_CELL');
  if(!cap.requestUrlMatches||cap.displayedCheckin!==cap.request.checkin||cap.displayedCheckout!==cap.request.checkout
    ||!/大人\s*2名.*子供\s*0名.*1部屋/u.test(cap.displayedParty))reasons.push('SERVED_TUPLE_NOT_CONFIRMED');
  if(!cell.roomName||!cell.roomText.includes(cell.roomName)||!/人数:\s*2\b/u.test(cell.occupancyText))reasons.push('ROOM_OR_OCCUPANCY_UNBOUND');
  const roleText=cap.parserVersion==='booking-rate-cell-v3'?cell.priceRoleText??'':cell.priceText;
  const pair=/元の料金\s*[￥¥]\s*([\d,]+)\s*現在の料金\s*[￥¥]\s*([\d,]+)/u.exec(roleText);
  const values=[...new Set(yen(roleText))],original=pair?Number(pair[1]!.replace(/,/gu,'')):null;
  const current=pair?Number(pair[2]!.replace(/,/gu,'')):values.length===1?values[0]!:null;
  if(current===null||current<=0||current>2_000_000||original!==null&&(original<current||original>2_000_000))reasons.push('PRICE_ROLE_AMBIGUOUS_OR_INVALID');
  const quantity=/^1\s*[（(]\s*[￥¥]\s*([\d,]+)\s*[)）]/u.exec(cell.oneRoomOptionText.trim());
  if(!quantity||Number(quantity[1]!.replace(/,/gu,''))!==current)reasons.push('ONE_ROOM_PRICE_NOT_CONFIRMED');
  if(cap.blockReason!==null||!cap.blockStateVerified)reasons.push('UI_BLOCKED_OR_UNVERIFIED');
  const policy=cell.policyText;
  if(!policy||!cell.policyControlId||cell.policyControlId!==`policyModal_${cell.blockId}`||cell.policyContainerId!==cell.policyControlId)reasons.push('SELECTED_POLICY_NOT_CAPTURED');
  const meal=policy&&/お食事は含まれておりません|食事は含まれていません|No meals are included/iu.test(policy)?'ROOM_ONLY' as const:'UNKNOWN' as const;
  const refundKinds=[policy&&/返金不可|払い戻し不可|non[- ]?refundable/iu.test(policy)?'NON_REFUNDABLE':null,
    policy&&/一部返金可|partially refundable/iu.test(policy)?'PARTIAL_REFUNDABLE':null,
    policy&&/キャンセル無料|無料でキャンセル|free cancellation/iu.test(policy)?'CONDITIONAL_REFUNDABLE':null].filter((v):v is string=>v!==null);
  const refund=refundKinds.length===1?refundKinds[0]!:'UNKNOWN';
  const tax=/税・手数料込/u.test(cell.priceText)?'DISPLAYED_TAX_FEES_INCLUDED' as const:'UNKNOWN' as const;
  const member=/ログインして.*会員限定料金|Genius|会員限定/u.test(cell.priceText);
  if(meal==='UNKNOWN')reasons.push('MEAL_UNKNOWN');if(refund==='UNKNOWN')reasons.push('CANCELLATION_UNKNOWN');if(tax==='UNKNOWN')reasons.push('TAX_BASIS_UNKNOWN');
  // An absent sale marker NEVER proves no discount. Preserve both explicit roles and the eligibility text.
  const promotion=pair?member?'MEMBER_CONDITIONAL_PAIR' as const:'EXPLICIT_PRICE_PAIR' as const:'UNCLASSIFIED' as const;
  const localTax=deriveLocalTaxDetail(cap.parserVersion==='booking-rate-cell-v3'?cell.taxDetails:undefined);
  return {blockId:cell.blockId,roomId:m?.[1]??null,ratePlanId:m?.[2]??null,adults:2 as const,
    currentDisplayedJpy:current,prePromotionPlanJpy:original,memberConditional:member,meal,refund,tax,promotion,
    ...localTax,cancellationTerms:policy,priceTerms:cell.priceText,
    tupleAndProductBound:reasons.length===0,reasons,
    // Commercial comparison policy and independent ownership are separate accepted inputs, never inferred here.
    marketPriceEligible:false as const};
}
/** Only an explicit selected-row label and a per-person/per-night amount establish local-tax treatment. */
export function deriveLocalTaxDetail(rows:BookingRateCell['taxDetails']){
  const scope={localTaxKind:'ONSEN_TAX' as const,taxScope:'SELECTED_ROW_DECLARED_ITEMS_ONLY' as const};
  const unknown={...scope,localTaxTreatment:'UNKNOWN' as const,localTaxPerAdultNightJpy:null as number|null};
  if(!rows||rows.length>5||rows.some(r=>typeof r.label!=='string'||typeof r.details!=='string'||r.label.length>50||r.details.length>1000))return unknown;
  const taxes=rows.filter(r=>/入湯税/u.test(r.details));if(taxes.length!==1)return unknown;
  const row=taxes[0]!,text=row.details.normalize('NFKC'),matches=[...text.matchAll(/1名\s*[/／]\s*1泊につき\s*[¥￥]\s*([\d,]+)\s*の入湯税/gu)];
  const amounts=[...new Set(matches.map(m=>Number(m[1]!.replace(/,/gu,''))))],amount=amounts.length===1?amounts[0]!:NaN;
  if(!Number.isSafeInteger(amount)||amount<0||amount>10000||/ただし|別途|追加|含まれな|子供|子ども|歳|免除|場合|年齢|以上|以下|対象/iu.test(text))return unknown;
  if(['込','含まれるもの'].includes(row.label.trim()))return {...scope,localTaxTreatment:'EXPLICIT_INCLUDED' as const,localTaxPerAdultNightJpy:amount};
  if(['別','含まれないもの'].includes(row.label.trim()))return {...scope,localTaxTreatment:'EXPLICIT_EXCLUDED' as const,localTaxPerAdultNightJpy:amount};
  return unknown;
}
export function sealBookingRateCellCapture(x:Omit<BookingRateCellCapture,'captureSha256'>):BookingRateCellCapture{
  return {...x,captureSha256:createHash('sha256').update(canonicalJson(x)).digest('hex')};
}
/** Only date/policy information controls are used. Blocked pages receive no further interaction. */
export async function captureBookingRateCells(page:Page,input:{propertySlug:string;checkin:string;checkout:string;observedAt:string},maxProducts=3,externalGuard?:BookingUiBlockGuard,fixedProducts?:readonly {productId:string;ratePlanId:string}[]):Promise<BookingRateCellCapture>{
  if(!/^[a-z0-9-]+$/u.test(input.propertySlug)||!isoDate(input.checkin)||!isoDate(input.checkout)
    ||Date.parse(input.checkout)-Date.parse(input.checkin)!==86400000||!Number.isSafeInteger(maxProducts)||maxProducts<1||maxProducts>5||fixedProducts!==undefined&&(fixedProducts.length>5||fixedProducts.some(p=>!/^\d{1,20}$/u.test(p.productId)||!/^\d{1,20}$/u.test(p.ratePlanId))))throw Error('RATE_CELL_CAPTURE_SCOPE');
  const problems:string[]=[],request={checkin:input.checkin,checkout:input.checkout,adults:2 as const,children:0 as const,rooms:1 as const,currency:'JPY' as const};
  const served=new URL(page.url());
  const requestUrlMatches=served.hostname==='www.booking.com'&&served.pathname===`/hotel/jp/${input.propertySlug}.ja.html`
    &&Object.entries({checkin:input.checkin,checkout:input.checkout,group_adults:'2',group_children:'0',no_rooms:'1',selected_currency:'JPY'}).every(([k,v])=>served.searchParams.get(k)===v);
  let displayedCheckin:string|null=null,displayedCheckout:string|null=null,displayedParty='';
  const empty=(problem:string)=>sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v3',propertySlug:input.propertySlug,observedAt:input.observedAt,request,requestUrlMatches,displayedCheckin,displayedCheckout,displayedParty:'',cells:[],problems:[...problems,problem],blockReason:null,blockStateVerified:true});
  if(!requestUrlMatches)return empty('SERVED_URL_TUPLE_MISMATCH_NO_INTERACTION');
  const guard=externalGuard??new BookingUiBlockGuard(page);
  let result:BookingRateCellCapture;
  try{
  await guard.requireClear();
  if(await page.locator('#hprt-table tr[data-block-id]').count()===0)throw Error('NO_RATE_TABLE_NO_INTERACTION');
  const dateButton=page.locator('#hp_availability_style_changes').getByTestId('searchbox-dates-container');
  let dateOpened=false;
  try{
    displayedParty=(await page.locator('#hp_availability_style_changes').getByRole('button',{name:/宿泊人数と部屋数/}).getAttribute('aria-label',{timeout:3000}))??'';
    if(await dateButton.getAttribute('aria-expanded',{timeout:3000})!=='false')throw Error('DATE_PANEL_ALREADY_OPEN');
    await guard.requireClear();await dateButton.click({timeout:3000});dateOpened=true;await guard.requireClear();
    const dates=await page.locator('[role="gridcell"][aria-selected="true"] [data-date]').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).slice(0,4).map(e=>({date:e.getAttribute('data-date')?.slice(0,40)??null,label:(e.getAttribute('aria-label')??'').slice(0,300)})));
    const starts=dates.filter(d=>d.label.includes('チェックイン日')),ends=dates.filter(d=>d.label.includes('チェックアウト日'));
    if(starts.length===1)displayedCheckin=starts[0]!.date;if(ends.length===1)displayedCheckout=ends[0]!.date;
  }catch{problems.push('DISPLAYED_DATE_OR_PARTY_UNVERIFIED');}
  finally{if(dateOpened&&await guard.checkpoint()&&await dateButton.getAttribute('aria-expanded',{timeout:3000}).catch(()=>null)==='true')await dateButton.click({timeout:3000}).catch(()=>{problems.push('DATE_PANEL_CLOSE_FAILED');});}
  if(problems.includes('DATE_PANEL_CLOSE_FAILED'))throw Error('NO_RATE_INTERACTION_AFTER_PANEL_FAILURE');
  await guard.requireClear();
  const rows=await page.locator('#hprt-table tr[data-block-id]').evaluateAll(es=>{
    const visible=es.filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0),clipped=visible.slice(0,200),names=new Map<string,{name:string;text:string}>();
    for(const e of clipped){const a=e.querySelector('[id^="room_type_id_"]');if(a){const id=a.id.slice('room_type_id_'.length);names.set(id,{name:(a as HTMLElement).innerText.slice(0,4001),text:((a.closest('th') as HTMLElement|null)?.innerText??'').slice(0,4001)});}}
    return {overflow:visible.length>200,rows:clipped.map(e=>{const blockId=(e.getAttribute('data-block-id')??'').slice(0,200),id=blockId.split('_')[0]??'',room=names.get(id),get=(s:string)=>((e.querySelector(s) as HTMLElement|null)?.innerText??'').slice(0,4001);
      const btn=e.querySelector('.hprt-table-cell-conditions button[aria-controls]');
      return {blockId,roomName:room?.name??'',roomText:room?.text??'',occupancyText:get('.hprt-table-cell-occupancy'),priceText:get('.hprt-table-cell-price'),conditionsText:get('.hprt-table-cell-conditions'),
        priceRoleText:get('.hprt-table-cell-price .prco-wrapper'),
        taxDetails:Array.from(e.querySelectorAll('.hprt-table-cell-price .hptr-taxinfo-block')).filter(t=>t.getBoundingClientRect().width>0&&t.getBoundingClientRect().height>0).slice(0,6).map(t=>{
          const label=((t.querySelector('.hptr-taxinfo-label') as HTMLElement|null)?.innerText??'').trim(),all=(t as HTMLElement).innerText.trim();
          return {label:label.slice(0,51),details:(all.startsWith(label)&&label!==''?all.slice(label.length).trim():'').slice(0,1001)};
        }),
        oneRoomOptionText:(Array.from(e.querySelectorAll('select option')).find(x=>(x as HTMLOptionElement).value==='1')?.textContent??'').slice(0,4001),policyControlId:btn?.getAttribute('aria-controls')?.slice(0,200)??null};})};
  });
  if(rows.overflow)problems.push('RATE_ROW_BUDGET_EXCEEDED');
  // Keep distinct room/rate products; explicit refundable and non-refundable rows remain separate.
  const selected=rows.rows.filter(r=>/^\d+_\d+_2_0_0$/u.test(r.blockId)
    &&(input.propertySlug!==K27_T04_REFERENCE.ownSlug||r.blockId.startsWith(K27_T04_REFERENCE.bookingRoomId+'_'))
    &&(fixedProducts===undefined||fixedProducts.some(p=>r.blockId===`${p.productId}_${p.ratePlanId}_2_0_0`))).slice(0,maxProducts),cells:BookingRateCell[]=[];
  for(const row of selected){
    await guard.requireClear();
    let policyText:string|null=null,policyContainerId:string|null=null;
    const expectedControlId=`policyModal_${row.blockId}`;
    const button=page.locator(`#hprt-table tr[data-block-id="${row.blockId}"] button[aria-controls="${expectedControlId}"]`);
    // Booking also has a hidden TEMPLATE with this ID. Only the visible controlled
    // container containing this dialog is evidence; a globally named dialog is not.
    const dialog=page.locator(`[id="${expectedControlId}"]:visible`).getByRole('dialog',{name:'食事およびキャンセルポリシーと前払いポリシーに関する詳細',exact:true});
    let opened=false;
    try{
      if(row.policyControlId!==expectedControlId)throw Error('POLICY_ID_INVALID');
      if(await page.getByRole('dialog',{name:'食事およびキャンセルポリシーと前払いポリシーに関する詳細',exact:true}).isVisible())throw Error('POLICY_PANEL_ALREADY_OPEN');
      await guard.requireClear();await button.click({timeout:3000});opened=true;await guard.requireClear();
      await dialog.waitFor({state:'visible',timeout:3000});
      policyContainerId=await dialog.evaluate(e=>e.closest('[id^="policyModal_"]')?.id??null);
      if(policyContainerId!==expectedControlId)throw Error('POLICY_CONTAINER_MISMATCH');
      const text=await dialog.innerText({timeout:3000});
      if(text.length>2400)problems.push('POLICY_TEXT_BUDGET_EXCEEDED');else policyText=scrubExcerpt(text,2400);
    }catch{problems.push('RATE_POLICY_UNVERIFIED');}
    finally{if(opened&&await guard.checkpoint()&&await dialog.isVisible().catch(()=>false))await dialog.getByRole('button',{name:'閉じる',exact:true}).click({timeout:3000}).catch(()=>{problems.push('POLICY_PANEL_CLOSE_FAILED');});}
    await guard.requireClear();
    if(Object.values(row).some(v=>typeof v==='string'&&v.length>4000)){problems.push('RATE_CELL_TEXT_BUDGET_EXCEEDED');continue;}
    cells.push({...row,roomName:scrubExcerpt(row.roomName,200),roomText:scrubExcerpt(row.roomText,1600),occupancyText:scrubExcerpt(row.occupancyText,160),priceText:scrubExcerpt(row.priceText,1600),priceRoleText:scrubExcerpt(row.priceRoleText,1600),taxDetails:row.taxDetails.map(t=>({label:scrubExcerpt(t.label,51),details:scrubExcerpt(t.details,1001)})),conditionsText:scrubExcerpt(row.conditionsText,1600),oneRoomOptionText:scrubExcerpt(row.oneRoomOptionText,200),policyContainerId,policyText});
    if(problems.includes('POLICY_PANEL_CLOSE_FAILED'))break;
  }
  if(!cells.length)problems.push('NO_EXACT_RATE_CELL_CAPTURED');
  result=sealBookingRateCellCapture({schema:'ZMI_BOOKING_RATE_CELLS_V1',parserVersion:'booking-rate-cell-v3',propertySlug:input.propertySlug,observedAt:input.observedAt,request,requestUrlMatches,displayedCheckin,displayedCheckout,displayedParty:scrubExcerpt(displayedParty,200),cells,problems:[...new Set(problems)],blockReason:null,blockStateVerified:true});
  }catch{result=empty('CAPTURE_UNVERIFIED');}
  finally{await guard.checkpoint();if(!externalGuard)guard.dispose();}
  const {captureSha256,...unsigned}=result;
  if(guard.reason!==null||!guard.stateVerified)return sealBookingRateCellCapture({...unsigned,cells:[],blockReason:guard.reason,blockStateVerified:guard.stateVerified,problems:[...new Set([...result.problems,'UI_BLOCKED_OR_UNVERIFIED'])]});
  return result;
}
