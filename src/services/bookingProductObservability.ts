// Observational facts only. No price authority, browser navigation, reservation selection or authentication.
import type {Browser,BrowserContext,Page,Locator} from 'playwright';
import {scrubExcerpt} from './marketEvidenceSidecar';
import type {BookingUiBlockGuard} from './bookingUiBlockGuard';
const anonymousContexts=new WeakSet<BrowserContext>();
export async function createAnonymousBookingCaptureContext(browser:Browser,userAgent:string){
 if(!userAgent||userAgent.length>700)throw Error('BOOKING_CONTEXT_OPTIONS');
 const context=await browser.newContext({userAgent,locale:'ja-JP'});anonymousContexts.add(context);return context;
}
export function bookingInformationTextSafe(text:string,max:number):boolean{
 if(typeof text!=='string'||text.length>max)return false;const s=text.normalize('NFKC'),phone=s.replace(/[()\s\u2010-\u2015\u2212\u30fc-]/gu,'');
 return !/https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:password|bearer|api[_ -]?key|(?:access|refresh)[_ -]?token|token|cookie)\b|パスワード|認証情報|住所|電話/iu.test(s)
  &&!/(?:^|[^0-9])(?:0\d{9,10}|\+?81\d{9,12}|\+\d{9,15})(?:$|[^0-9])/u.test(phone);
}
async function visibleInformationText(panel:Locator):Promise<string>{
 return panel.evaluate(e=>{
  const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT),parts:string[]=[];let node:Node|null;
  while((node=walker.nextNode())!==null){const p=node.parentElement;if(!p||p.closest('button,input,select,script,style,template,[aria-hidden="true"]')||p.getBoundingClientRect().width===0||p.getBoundingClientRect().height===0)continue;
   parts.push(node.textContent??'');if(parts.join('\n').length>4500)throw Error('INFORMATION_TEXT_BUDGET');
  }
  return parts.join('\n');
 });
}
function capacityInformationText(text:string):string{
 const lines=text.normalize('NFKC').split(/[。;；\n]/u).map(s=>s.trim()).filter(Boolean),out:string[]=[];
 for(let i=0;i<lines.length;i++){let s=lines[i]!;if(/^(?:最大宿泊人数|最大収容人数|最大大人人数|大人の定員|大人定員|定員|Maximum adults|Maximum occupancy)\s*[:：]?$/iu.test(s)&&/^\d{1,2}\s*(?:名|人)?$/u.test(lines[i+1]??''))s+=lines[++i]!;
  if(/最大(?:宿泊|収容|大人)|大人(?:の)?定員|定員|maximum (?:adult|occup)/iu.test(s))out.push(s);
 }
 return out.join('\n');
}
export interface BookingProductFacts {
 schema:'BOOKING_SELECTED_PRODUCT_FACTS_V1';blockId:string;
 anonymousPublicContext:{freshUnauthenticatedContext:true;signedOutControlVisible:true}|null;
 roomCapacity:{controlId:string;containerId:string;roomId:string;roomName:string;maximumAdults:number;explicitText:string}|null;
 taxTotal:{controlId:string;containerId:string;explicitText:string}|null;
}
export function explicitMaximumAdults(text:string):number|null{
 const xs=text.normalize('NFKC').split(/[。;；\n]/u).map(s=>s.trim()).filter(s=>/最大(?:宿泊|収容|大人)|大人(?:の)?定員|定員|maximum (?:adult|occup)/iu.test(s));
 const matches=xs.map(s=>/^(?:(?:最大宿泊人数|最大収容人数|最大大人人数|大人の定員|大人定員|定員)\s*[:：]?\s*(\d{1,2})\s*(?:名|人)|Maximum (?:adults|occupancy)\s*:\s*(\d{1,2}))$/iu.exec(s));
 if(!xs.length||matches.some(x=>!x))return null;const v=[...new Set(matches.map(x=>Number(x![1]??x![2])))];return v.length===1&&v[0]!>0&&v[0]!<=30?v[0]!:null;
}
export function roomKindFromName(name:string):'DOUBLE'|'TWIN'|null{
 const n=name.normalize('NFKC');if(/suite|family|triple|スイート|スィート|ファミリー|トリプル/iu.test(n))return null;
 const twin=/twin|ツイン/iu.test(n),double=/double|ダブル/iu.test(n);return twin!==double?twin?'TWIN':'DOUBLE':null;
}
/** Discovery ranks evidence quality, never a lower price. A fixed accepted product is selected elsewhere without replacement. */
export function rankBookingDiscoveryRows<T extends {blockId:string;roomName:string;priceText:string;conditionsText:string;oneRoomOptionText:string}>(rows:readonly T[]):T[]{
 const score=(r:T)=>[roomKindFromName(r.roomName)!==null?0:1,/ログインして.*会員限定|Genius|会員限定/iu.test(r.priceText)?1:0,/税・手数料込/u.test(r.priceText)?0:1,/^1\s*[（(]/u.test(r.oneRoomOptionText.trim())?0:1,/返金不可|non.refundable/iu.test(r.conditionsText)?0:1];
 return rows.map((r,i)=>({r,i,s:score(r)})).sort((a,b)=>{for(let i=0;i<a.s.length;i++)if(a.s[i]!==b.s[i])return a.s[i]!-b.s[i]!;return a.i-b.i;}).map(x=>x.r);
}
const token=(s:string|null):s is string=>typeof s==='string'&&/^[-A-Za-z0-9_:]{1,160}$/u.test(s);
/** Additional information controls only; unsupported markup stays UNKNOWN rather than using party/bed count. */
export async function captureBookingProductFacts(page:Page,guard:BookingUiBlockGuard,row:{blockId:string;roomName:string}):Promise<BookingProductFacts>{
 const out:BookingProductFacts={schema:'BOOKING_SELECTED_PRODUCT_FACTS_V1',blockId:row.blockId,anonymousPublicContext:null,roomCapacity:null,taxTotal:null};
 if(!anonymousContexts.has(page.context())||!/^\d+_\d+_2_0_0$/u.test(row.blockId))return out;
 await guard.requireClear();
 const signedOut=page.locator('header [data-testid="header-sign-in-button"],header a').filter({hasText:/^(?:ログイン|Sign in)$/u});
 if(await signedOut.count()===1&&await signedOut.isVisible().catch(()=>false))out.anonymousPublicContext={freshUnauthenticatedContext:true,signedOutControlVisible:true};
 const roomId=row.blockId.split('_')[0]!,anchor=page.locator(`[id="room_type_id_${roomId}"]`);
 if(await anchor.count()===1){
  const controls=await anchor.getAttribute('aria-controls'),href=await anchor.getAttribute('href'),id=href===`#RD${roomId}`&&(controls===null||controls===`RD${roomId}`)?`RD${roomId}`:null;
  if(id){const container=page.locator(`[id="${id}"]:visible`);if(await container.count()!==0)throw Error('ROOM_PANEL_ALREADY_OPEN');let opened=false,identified=false;
   try{
    await guard.requireClear();opened=true;await anchor.click({timeout:2000});await guard.requireClear();await container.waitFor({state:'visible',timeout:2000});identified=true;
    const text=await visibleInformationText(container);if(!bookingInformationTextSafe(text,4000)||!text.normalize('NFKC').replace(/\s+/gu,' ').includes(row.roomName.normalize('NFKC').replace(/\s+/gu,' ')))throw Error('ROOM_FACTS_SCOPE');
    const explicitText=capacityInformationText(text),maximumAdults=explicitMaximumAdults(explicitText);
    if(explicitText.length<=300&&maximumAdults!==null)out.roomCapacity={controlId:id,containerId:id,roomId,roomName:row.roomName,maximumAdults,explicitText};
   }catch{/* Missing or ambiguous room details remain unknown. */}
   finally{if(opened&&!identified&&await guard.checkpoint())throw Error('ROOM_INFORMATION_UNBOUND_STOP');
    if(opened&&await guard.checkpoint()&&await container.isVisible()){
    const close=container.getByRole('button',{name:/^(?:閉じる|Close)$/u});if(await close.count()!==1){out.roomCapacity=null;throw Error('ROOM_PANEL_CLOSE_UNVERIFIED');}await close.click({timeout:2000});await guard.requireClear();if(await container.isVisible()){out.roomCapacity=null;throw Error('ROOM_PANEL_CLOSE_UNVERIFIED');}
   }}
  }
 }
 await guard.requireClear();
 const taxButtons=page.locator(`#hprt-table tr[data-block-id="${row.blockId}"] .hprt-table-cell-price button[aria-controls]`).filter({hasText:/税|手数料|Taxes|fees/iu});
 if(await taxButtons.count()===1){const id=await taxButtons.getAttribute('aria-controls');if(token(id)){
  const panel=page.locator(`[id="${id}"]:visible`);if(await panel.count()!==0)throw Error('TAX_PANEL_ALREADY_OPEN');let opened=false,identified=false;
  try{await guard.requireClear();opened=true;await taxButtons.click({timeout:2000});await guard.requireClear();await panel.waitFor({state:'visible',timeout:2000});identified=true;
   const text=(await visibleInformationText(panel)).trim();if(!bookingInformationTextSafe(text,1000))throw Error('TAX_TEXT_BUDGET_OR_SENSITIVE');out.taxTotal={controlId:id,containerId:id,explicitText:scrubExcerpt(text,1000)};
  }catch{/* A row label never implies all mandatory charges. */}
  finally{if(opened&&!identified&&await guard.checkpoint())throw Error('TAX_INFORMATION_UNBOUND_STOP');
   if(opened&&await guard.checkpoint()&&await panel.isVisible()){
   const close=panel.getByRole('button',{name:/^(?:閉じる|Close)$/u});if(await close.count()!==1){out.taxTotal=null;throw Error('TAX_PANEL_CLOSE_UNVERIFIED');}await close.click({timeout:2000});await guard.requireClear();if(await panel.isVisible()){out.taxTotal=null;throw Error('TAX_PANEL_CLOSE_UNVERIFIED');}
  }}
 }}
 return out;
}
export function usesFreshAnonymousBookingContext(page:Page):boolean{return typeof page.context==='function'&&anonymousContexts.has(page.context());}
/** Sealed v4 row evidence only. It cannot reinterpret or enrich a historical v2/v3 capture. */
export function readBookingProductFacts(cap:{parserVersion:string},cell:{blockId:string;roomName:string;productFacts?:BookingProductFacts},derived:{tupleAndProductBound:boolean;memberConditional:boolean;currentDisplayedJpy:number|null}){
 const no={maximumAdults:null as number|null,roomCapacityProved:false,publicPriceProved:false,allMandatoryText:null as string|null};
 if(cap.parserVersion!=='booking-rate-cell-v4')return no;
 const f=cell.productFacts;if(!f||f.schema!=='BOOKING_SELECTED_PRODUCT_FACTS_V1'||f.blockId!==cell.blockId)return no;
 const r=f.roomCapacity,roomId=cell.blockId.split('_')[0];
 const roomOk=!!r&&typeof r.explicitText==='string'&&bookingInformationTextSafe(r.explicitText,300)&&r.controlId===`RD${roomId}`&&r.containerId===r.controlId&&r.roomId===roomId&&r.roomName===cell.roomName&&explicitMaximumAdults(r.explicitText)===r.maximumAdults;
 const a=f.anonymousPublicContext,publicOk=a?.freshUnauthenticatedContext===true&&a.signedOutControlVisible===true&&derived.tupleAndProductBound&&!derived.memberConditional&&derived.currentDisplayedJpy!==null;
 const t=f.taxTotal,taxOk=!!t&&token(t.controlId)&&t.containerId===t.controlId&&typeof t.explicitText==='string'&&bookingInformationTextSafe(t.explicitText,1000);
 return {maximumAdults:roomOk?r!.maximumAdults:null,roomCapacityProved:roomOk,publicPriceProved:publicOk,allMandatoryText:taxOk?t!.explicitText:null};
}
export async function readBookingMaterialRow(page:Page,blockId:string){
 if(!/^\d+_\d+_2_0_0$/u.test(blockId))throw Error('MATERIAL_ROW_ID');
 const row=page.locator(`#hprt-table tr[data-block-id="${blockId}"]`);if(await row.count()!==1)throw Error('MATERIAL_ROW_NOT_UNIQUE');
 return row.evaluate((e,id)=>{
  const anchors=Array.from(document.querySelectorAll('[id="room_type_id_'+id+'"]')).filter(a=>a.getBoundingClientRect().width>0&&a.getBoundingClientRect().height>0);
  if(anchors.length!==1)throw Error('MATERIAL_ROOM_ID_NOT_UNIQUE');const anchor=anchors[0] as HTMLElement;
  return {rowVisible:e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0,
   roomName:anchor.innerText.slice(0,4001),roomText:((anchor.closest('th') as HTMLElement|null)?.innerText??'').slice(0,4001),occupancyText:((e.querySelector('.hprt-table-cell-occupancy') as HTMLElement|null)?.innerText??'').slice(0,4001),
   priceText:((e.querySelector('.hprt-table-cell-price') as HTMLElement|null)?.innerText??'').slice(0,4001),priceRoleText:((e.querySelector('.hprt-table-cell-price .prco-wrapper') as HTMLElement|null)?.innerText??'').slice(0,4001),
   conditionsText:((e.querySelector('.hprt-table-cell-conditions') as HTMLElement|null)?.innerText??'').slice(0,4001),
   taxDetails:Array.from(e.querySelectorAll('.hprt-table-cell-price .hptr-taxinfo-block')).filter(t=>t.getBoundingClientRect().width>0&&t.getBoundingClientRect().height>0).slice(0,6).map(t=>{const label=((t.querySelector('.hptr-taxinfo-label') as HTMLElement|null)?.innerText??'').trim(),all=(t as HTMLElement).innerText.trim();return {label:label.slice(0,51),details:(all.startsWith(label)&&label!==''?all.slice(label.length).trim():'').slice(0,1001)};}),
   oneRoomOptionText:(Array.from(e.querySelectorAll('select option')).find(x=>(x as HTMLOptionElement).value==='1')?.textContent??'').slice(0,4001),
   oneRoomOptionEnabled:Array.from(e.querySelectorAll('select option')).some(x=>(x as HTMLOptionElement).value==='1'&&!(x as HTMLOptionElement).disabled&&(x.closest('select') as HTMLSelectElement|null)?.disabled===false&&(x.closest('select')?.getBoundingClientRect().width??0)>0&&(x.closest('select')?.getBoundingClientRect().height??0)>0&&x.closest('select')?.getAttribute('aria-disabled')!=='true'&&!(x.closest('optgroup') as HTMLOptGroupElement|null)?.disabled),
   selectedValues:Array.from(e.querySelectorAll('select')).slice(0,6).map(x=>(x as HTMLSelectElement).value),policyControlId:e.querySelector('.hprt-table-cell-conditions button[aria-controls]')?.getAttribute('aria-controls')??null,
   roomHref:anchor.getAttribute('href'),roomControls:anchor.getAttribute('aria-controls')};
 },blockId.split('_')[0]!);
}
export async function readBookingHeaderSnapshot(page:Page){
 const date=page.locator('#hp_availability_style_changes').getByTestId('searchbox-dates-container'),party=page.locator('#hp_availability_style_changes').getByRole('button',{name:/宿泊人数と部屋数/}),login=page.locator('header [data-testid="header-sign-in-button"],header a').filter({hasText:/^(?:ログイン|Sign in)$/u});
 return {dateText:await date.innerText({timeout:2000}),dateAria:await date.getAttribute('aria-label'),expanded:await date.getAttribute('aria-expanded'),party:await party.getAttribute('aria-label'),signedOutControlVisible:await login.count()===1&&await login.isVisible()};
}
