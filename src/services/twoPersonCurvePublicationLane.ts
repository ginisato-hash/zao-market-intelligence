// Existing normal collector only. Default OFF means no filesystem/git/DB access.
import {readBoundedStableFile} from './boundedStableFile';
import {readRmsQuoteRequest} from './rmsQuoteRequest';
import {assertAcceptedTwoPersonProducer} from './twoPersonMarketAdmissionLane';
import {startCurvePublication,guardCurveAttempt,finishCurvePublication,closeCurvePublication,type CurvePublicationSession} from './twoPersonCurvePublication';
export function beginNormalCurvePublication(env:Record<string,string|undefined>,input:{runId:string;root:string}){
 if(env['ZMI_2P_CURVE_PUBLICATION_ENABLED']!=='1')return {status:'DISABLED' as const,session:null};
 try{
  if(env['ZMI_2P_QUALITY_ENABLED']!=='1'||env['ZMI_USEFUL_QUOTES_ENABLED']!=='1')throw Error('NORMAL_QUALITY_AND_SCOPE_REQUIRED');
  const {codeSha256}=assertAcceptedTwoPersonProducer(env),now=new Date().toISOString();
  const request=readRmsQuoteRequest(env['ZMI_RMS_QUOTE_REQUEST_PATH']??'',now,{releaseGitSha:env['ZMI_RMS_QUOTE_SOURCE_RELEASE']??'',bundleSha256:env['ZMI_RMS_QUOTE_BUNDLE_SHA256']??'',graphSha256:env['ZMI_RMS_QUOTE_GRAPH_SHA256']??''});
  const session=startCurvePublication({...input,producerCodeSha256:codeSha256,request,
   configBytes:readBoundedStableFile(env['ZMI_2P_CURVE_CONFIG_PATH']??'',512*1024),expectedConfigSha256:env['ZMI_2P_CURVE_CONFIG_SHA256']??'',
   assertSource:()=>{if(assertAcceptedTwoPersonProducer(env).codeSha256!==codeSha256)throw Error('PRODUCER_CHANGED');}});
  return {status:'READY' as const,session};
 }catch{return {status:'HELD_SOURCE_OR_PUBLICATION_UNVERIFIED' as const,session:null};}
}
export function normalCurveAttempt(session:CurvePublicationSession|null,sourcePropertyId:string,stayDate:string){return session===null||guardCurveAttempt(session,sourcePropertyId,stayDate);}
export function finishNormalCurvePublication(session:CurvePublicationSession|null,admission:{status:string;admissionSha256?:string}){
 if(session===null)return {status:'DISABLED_OR_HELD'};
 try{if(admission.status!=='CANONICAL_ADMISSION_RECORDED'||!admission.admissionSha256)throw Error('NORMAL_ADMISSION_NOT_VERIFIED');return finishCurvePublication(session,admission.admissionSha256);}
 catch{return {status:'CURVE_UNVERIFIED_GUARDED_DATES_Y_ONLY'};}
}
export function closeNormalCurvePublication(session:CurvePublicationSession|null){if(session!==null)closeCurvePublication(session);}
