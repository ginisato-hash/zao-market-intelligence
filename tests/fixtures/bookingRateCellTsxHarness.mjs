// Offline browser-realm serialization regression using the actual production tsx loader. No browser/network.
import {runInNewContext} from 'node:vm';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {captureBookingRateCells,deriveBookingRateCell}=await import(pathToFileURL(resolve('src/services/bookingRateCellEvidence.ts')).href);
const block='111_222_2_0_0',policyId='policyModal_'+block,serialized=[];
const strings={'.hprt-table-cell-occupancy':'人数: 2','.hprt-table-cell-price':'￥10,000 税・手数料込',
 '.hprt-table-cell-price .prco-wrapper':'￥10,000 税・手数料込','.hprt-table-cell-conditions':'キャンセル無料'};
const row={getBoundingClientRect:()=>({width:1,height:1}),getAttribute:k=>k==='data-block-id'?block:null,
 querySelector:s=>s==='[id^="room_type_id_"]'?{id:'room_type_id_111',innerText:'ツインルーム',closest:()=>({innerText:'ツインルーム 定員2名'})}:
 s==='.hprt-table-cell-conditions button[aria-controls]'?{getAttribute:k=>k==='aria-controls'?policyId:null}:strings[s]?{innerText:strings[s]}:null,
 querySelectorAll:s=>s==='select option'?[{value:'1',textContent:'1 (￥10,000)'}]:[]};
let expanded=false;
const dateButton={getAttribute:async()=>String(expanded),click:async()=>{expanded=!expanded;}};
const dialog={waitFor:async()=>{},evaluate:async()=>policyId,innerText:async()=>'お食事は含まれておりません。キャンセル無料。',isVisible:async()=>true,getByRole:()=>({click:async()=>{}})};
const page={on(){},off(){},url:()=> 'https://www.booking.com/hotel/jp/fixture-hotel.ja.html?checkin=2027-01-15&checkout=2027-01-16&group_adults=2&group_children=0&no_rooms=1&selected_currency=JPY',title:async()=> 'Fixture hotel',
 getByRole:()=>({isVisible:async()=>false}),
 locator:s=>{
  if(s==='body')return {innerText:async()=> 'Fixture hotel'};
  if(s==='#hprt-table tr[data-block-id]')return {count:async()=>1,evaluateAll:async fn=>{serialized.push(fn.toString());return runInNewContext('('+fn.toString()+')',{}, {timeout:1000})([row]);}};
  if(s==='#hp_availability_style_changes')return {getByTestId:()=>dateButton,getByRole:()=>({getAttribute:async()=> '宿泊人数と部屋数。選択済みの内容：大人2名 · 子供0名 · 1部屋'})};
  if(s==='[role="gridcell"][aria-selected="true"] [data-date]')return {evaluateAll:async()=>[{date:'2027-01-15',label:'チェックイン日'},{date:'2027-01-16',label:'チェックアウト日'}]};
  if(s===`[id="${policyId}"]:visible`)return {getByRole:()=>dialog};
  if(s.startsWith('#hprt-table tr[data-block-id="'))return {click:async()=>{}};
  throw Error('UNEXPECTED_OFFLINE_SELECTOR:'+s);
 }};
const capture=await captureBookingRateCells(page,{propertySlug:'fixture-hotel',checkin:'2027-01-15',checkout:'2027-01-16',observedAt:'2026-10-29T00:00:00Z'});
console.log(JSON.stringify({cells:capture.cells.length,problems:capture.problems,bound:capture.cells.map(c=>deriveBookingRateCell(capture,c).tupleAndProductBound),browserCallbacksHaveNodeHelper:serialized.some(s=>s.includes('__name')),browser:0,network:0}));
