import type {Page,Request} from 'playwright';

// Observe the initial page load only. No request, navigation or UI operation.
// A fresh quiet interval is required after the caller enters this barrier;
// an old Playwright networkidle event cannot satisfy it. New passive timer
// traffic resets quiet time but never extends the absolute waiting budget.
export function observeBookingInitialLoad(page:Page){
 const pending=new Set<Request>();let lastActivity=performance.now(),seen=0,settled=0,failed=0,unverified=false,disposed=false;
 const start=(r:Request)=>{lastActivity=performance.now();seen++;if(pending.has(r)||seen>1000){unverified=true;return;}pending.add(r);};
 const finish=(r:Request,isFailed:boolean)=>{lastActivity=performance.now();settled++;if(isFailed)failed++;if(!pending.delete(r))unverified=true;};
 const finished=(r:Request)=>finish(r,false),failure=(r:Request)=>finish(r,true);
 page.on('request',start);page.on('requestfinished',finished);page.on('requestfailed',failure);
 return {
  async waitForFreshQuiet(){
   const began=performance.now(),quietWindowMs=500,maxWaitMs=5000;
   for(;;){
    const now=performance.now(),elapsed=now-began;
    const status=disposed||page.isClosed()||unverified?'UNVERIFIED_NO_INFORMATION':elapsed>=maxWaitMs?'TIMED_OUT_NO_INFORMATION':pending.size===0&&now-Math.max(began,lastActivity)>=quietWindowMs?'QUIET_BEFORE_INFORMATION':null;
    if(status)return {status,quietWindowMs,maxWaitMs,startedRequests:seen,settledRequests:settled,failedRequests:failed,pendingRequests:pending.size};
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(25,maxWaitMs-elapsed)));
   }
  },
  dispose(){if(disposed)return;disposed=true;page.off('request',start);page.off('requestfinished',finished);page.off('requestfailed',failure);pending.clear();}
 };
}
