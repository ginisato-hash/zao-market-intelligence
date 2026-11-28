// At most90 raw files, each <=2MiB; one raw file is consumed at a time.
// Retained final-guard projections remain <=32MiB total, each <=2MiB.
// Every raw file remains SHA-bound through final reread. No source/price admission.
export const LISTING_REPORT_FILE_BYTES=2*1024*1024;
export const LISTING_REPORT_TOTAL_BYTES=32*1024*1024;
export const LISTING_REPORT_COUNT=90;
export function consumeListingReportBytes(used:number,next:number):number{
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(next)||next<0||next>LISTING_REPORT_FILE_BYTES)throw Error('LISTING_REPORT_FILE_BUDGET');
 if(used>LISTING_REPORT_TOTAL_BYTES-next)throw Error('LISTING_REPORT_TOTAL_BUDGET');
 return used+next;
}
