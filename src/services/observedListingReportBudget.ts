// Finite evidence resource bounds only. No source, price or guard admission.
export const LISTING_REPORT_FILE_BYTES=2*1024*1024;
export const LISTING_REPORT_TOTAL_BYTES=32*1024*1024;
export const LISTING_REPORT_COUNT=90;
export function consumeListingReportBytes(used:number,next:number):number{
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(next)||next<0||next>LISTING_REPORT_FILE_BYTES)throw Error('LISTING_REPORT_FILE_BUDGET');
 if(used>LISTING_REPORT_TOTAL_BYTES-next)throw Error('LISTING_REPORT_TOTAL_BUDGET');
 return used+next;
}
