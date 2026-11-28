import type {Page} from 'playwright';
import {bookingServedTuple} from './bookingProductObservability';

/** Browser-protocol metadata only. No page-script timing value grants HTTP authority.
 * URLs, frame/loader/node identities remain bounded in RAM and are never evidence fields. */
export async function observeBookingCurrentDocument(page:Page){
 const bounded=async<T>(pending:Promise<T>,ms=1000)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('DOCUMENT_PROTOCOL_TIMEOUT')),ms);})]);}finally{if(timer)clearTimeout(timer);}};
 const session=await bounded(page.context().newCDPSession(page));
 const responses:Array<{frame:string;loader:string;status:number;url:string}>=[];
 let overflow=false,unverified=false,closed=false,mainFrameId:string|null=null;
 const received=(e:{type:string;frameId?:string;loaderId:string;response:{status:number;url:string}})=>{
  if(e.type!=='Document'||e.frameId!==mainFrameId)return;
  if(typeof e.frameId!=='string'||e.frameId.length>256||!e.loaderId||e.loaderId.length>256||typeof e.response.url!=='string'||e.response.url.length>8192||!Number.isInteger(e.response.status)||e.response.status<100||e.response.status>599){unverified=true;return;}
  if(responses.length>=16){overflow=true;return;}
  responses.push({frame:e.frameId,loader:e.loaderId,status:e.response.status,url:e.response.url});
 };
 session.on('Network.responseReceived',received);
 try{await bounded((async()=>{await session.send('Page.enable');mainFrameId=(await session.send('Page.getFrameTree')).frameTree.frame.id;await session.send('Network.enable');})());}catch{session.off('Network.responseReceived',received);await bounded(session.detach(),200).catch(()=>undefined);throw Error('DOCUMENT_PROTOCOL_UNAVAILABLE');}
 const url=(s:string)=>{const u=new URL(s);u.hash='';return u.href;};
 const snapshot=async()=>{
  if(closed||overflow||unverified)throw Error('CURRENT_DOCUMENT_UNVERIFIED');
  const a=(await session.send('Page.getFrameTree')).frameTree.frame;
  const {root}=await session.send('DOM.getDocument',{depth:1,pierce:false});
  const b=(await session.send('Page.getFrameTree')).frameTree.frame;
  const elements=(root.children??[]).filter(n=>n.nodeType===1&&n.nodeName==='HTML');
  if(a.id!==mainFrameId||a.id!==b.id||a.loaderId!==b.loaderId||a.url!==b.url||!a.loaderId||root.nodeName!=='#document'||!root.backendNodeId||!root.documentURL||elements.length!==1||!elements[0]!.backendNodeId||url(root.documentURL)!==url(b.url))throw Error('CURRENT_DOCUMENT_CHANGED');
  const matches=responses.filter(r=>r.frame===b.id&&r.loader===b.loaderId);
  if(matches.length!==1||matches[0]!.status!==200||url(matches[0]!.url)!==url(b.url)||url(page.url())!==url(b.url))throw Error('CURRENT_DOCUMENT_UNVERIFIED');
  return {frame:b.id,loader:b.loaderId,url:b.url,document:root.backendNodeId,element:elements[0]!.backendNodeId};
 };
 const read=()=>bounded(snapshot());
 return {async bind(input:{propertySlug:string;checkin:string;checkout:string}){
  let original:Awaited<ReturnType<typeof read>>;try{original=await read();}catch{return null;}
  if(bookingServedTuple(original.url,input.propertySlug,input.checkin,input.checkout)===null)return null;
  return {responseStatus:200 as const,async assertUnchanged(){const next=await read();if(next.frame!==original.frame||next.loader!==original.loader||next.url!==original.url||next.document!==original.document||next.element!==original.element)throw Error('CURRENT_DOCUMENT_CHANGED');},dispose:async()=>{}};
 },async dispose(){if(closed)return;closed=true;responses.length=0;session.off('Network.responseReceived',received);await bounded(session.detach(),200);}};
}
