// Selected-policy text only. A future payment deadline or an option to pay now is not required prepayment.
export function deriveBookingPrepayment(text:string|null):'REQUIRED'|'NOT_REQUIRED'|'UNKNOWN'{
 if(!text||text.length>2400)return 'UNKNOWN';
 const clauses=text.normalize('NFKC').split(/[。.!！\n]/u).map(c=>c.trim())
  .filter(c=>/前払|事前.*支払|予約時|宿泊料金の全額が|(?:翌日|後日|\d+[年月日]|\d+\/\d+).*請求/u.test(c))
  .map(c=>c.replace(/^前払い(?:\s*[•:：]\s*|\s+)(?:オンライン決済\s+)?/u,''));
 const required=/^(?:宿泊料金の全額が予約時に請求されます|予約時に(?:宿泊料金の)?全額(?:を)?支払い(?:が必要です|が必要)?|事前に(?:宿泊料金の)?全額(?:を)?支払う必要があります)$/u;
 const notRequired=/^(?:事前(?:の)?支払い(?:は)?不要|前払い(?:は)?不要)$/u;
 const facts=clauses.map(c=>required.test(c)?'REQUIRED':notRequired.test(c)?'NOT_REQUIRED':'UNKNOWN');
 // Full positive clauses only; a qualifier, choice, negation or conflicting clause cannot inherit a substring's meaning.
 return facts.length>0&&facts.every(f=>f===facts[0])?facts[0]!:'UNKNOWN';
}
/** V2 keeps cancellation-penalty sentences separate from payment timing. */
export function deriveBookingPrepaymentV2(text:string|null){if(!text)return 'UNKNOWN' as const;const clauses=text.normalize('NFKC').split(/[。.!！\n]/u).filter(c=>!(/キャンセル|取消|ノーショー/u.test(c)&&!/前払|予約時|事前.*支払/u.test(c)));return deriveBookingPrepayment(clauses.join('。'));}
/** Semantic comparison series, preserving material deadline/penalty/timing changes. */
export function bookingSemanticTermsV2(text:string|null,refund:string){
 const prepayment=deriveBookingPrepaymentV2(text);if(!text||prepayment==='UNKNOWN')return null;
 const n=text.normalize('NFKC').replace(/\s+/gu,' ').trim();
 if(/条件により|一部返金|特別な場合|may apply|depending on/iu.test(n))return null;
 const timing=prepayment==='NOT_REQUIRED'?'NO_PREPAYMENT':/予約時に|予約時に請求/u.test(n)?'FULL_AT_BOOKING':null;
 if(timing===null)return null;
 if(refund==='NON_REFUNDABLE'){
  const clauses=n.split(/[。.!！]/u).filter(c=>/キャンセル|違約金|取消料|ノーショー|返金/u.test(c)),penalty=clauses.join('。');
  if(/ただし|但し|免除|例外|条件|ではありません|でない|ではない|不要|除く|unless|except|waiv/iu.test(penalty))return null;
  if(clauses.some(c=>/場合/u.test(c)&&!/^\s*(?:(?:キャンセル|予約のキャンセル|変更|ノーショー|、|または|および|や|・|\s)+)の場合[、,:：]?\s*(?:宿泊料金の合計|宿泊料金の全額|全額|100\s*%)(?:が|を)?(?:請求されます|お支払いいただきます|支払う必要があります)\s*$/u.test(c)))return null;
  if([...penalty.matchAll(/(\d+(?:\.\d+)?)\s*%/gu)].some(m=>Number(m[1])!==100)||/[¥￥]\s*[\d,]+|\d+円|\d+日前|\d{4}年|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d+泊分|半額|一部返金/u.test(penalty))return null;
  if(clauses.some(c=>!/^\s*(?:返金不可|払い戻し不可|キャンセルポリシー)\s*$/u.test(c)&&!/(?:100\s*%|全額|宿泊料金の合計)/u.test(c)))return null;
  return {version:'BOOKING_SEMANTIC_TERMS_V2',meal:'ROOM_ONLY',cancellation:'ANYTIME_NON_REFUNDABLE',prepayment:timing};
 }
 if(refund!=='CONDITIONAL_REFUNDABLE')return null;
 const clauses=n.split(/[。.!！]/u).filter(c=>/キャンセル|キャンセル料|請求|返金|ノーショー/u.test(c));
 if(!clauses.some(c=>/(?:\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|\d+日前)/u.test(c))||!clauses.some(c=>/全額|100\s*%|\d+\s*%|[¥￥]\s*[\d,]+/u.test(c)))return null;
 return {version:'BOOKING_SEMANTIC_TERMS_V2',meal:'ROOM_ONLY',cancellation:clauses.map(c=>c.replace(/無料でキャンセル|キャンセル無料/gu,'無料キャンセル').replace(/\s/gu,'')).sort(),prepayment:timing};
}

/** In-page stability retains every observed clause, including meals and exceptions.
 * Comparison-series identity still uses bookingSemanticTermsV2 separately. */
export function bookingPolicyObservationKey(text:string){return text.normalize('NFKC').replace(/\s+/gu,' ').trim();}
