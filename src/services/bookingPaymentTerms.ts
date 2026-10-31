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
