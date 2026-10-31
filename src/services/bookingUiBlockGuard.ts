import type { Page, Response, Route,Request } from 'playwright';
import { classifyBlock, type BlockReason } from './crawlThrottlePolicy';
import type {BookingInitialLoadObserver,BookingInitialLoadReadiness} from './bookingInitialLoadBarrier';
export type BookingInformationFailureCode='REQUEST_BUDGET_EXCEEDED'|'ABORT_FAILED'|'UNEXPECTED_PAGE'|'GUARD_ARM_FAILED'|'POLICY_DOM_CLEANUP_UNVERIFIED'|'ABORT_DRAIN_TIMEOUT'|'PAGE_CLOSE_FAILED'|'PAGE_NOT_CLOSED'|'ROUTE_CLEANUP_FAILED'|'UNABORTED_OBSERVED_REQUEST'|'UI_STATE_UNREADABLE';
type InformationPhase='ARMING'|'ARMED_IDLE'|'CALENDAR_OPEN'|'CALENDAR_READ'|'CALENDAR_CLOSE'|'CALENDAR_CLOSED'|'RATE_INFORMATION';

/** Sticky, page-local detection only. It never retries, navigates or solves a challenge. */
export class BookingUiBlockGuard {
  reason: BlockReason = null;
  stateVerified = true;
  informationRequestRefused = false;
  informationDeniedRequest:{method:string;resourceType:string;navigation:boolean;abortOutcome:'SUCCEEDED'|'FAILED'}|null=null;
  observedDeniedRequestPhase:InformationPhase|null=null;
  initialLoadReadiness:BookingInitialLoadReadiness|null=null;
  initialLoadHandoffVerified:boolean|null=null;
  private informationPhase:InformationPhase='ARMING';
  private informationArmed = false;
  private finishPromise:Promise<void>|null = null;
  private disposePending = false;
  hardStop=false;
  informationFailureCode:BookingInformationFailureCode|null=null;
  private informationFailure(code:BookingInformationFailureCode):void{this.informationFailureCode??=code;this.stateVerified=false;this.hardStop=true;}
  private readonly seen=new Set<Request>();
  private readonly safelyAborted=new Set<Request>();
  private readonly aborts=new Set<Promise<void>>();
  // Information is read from the already loaded DOM. There is no accepted
  // allowlist or extra network budget, including for GET/HEAD and analytics.
  private readonly informationRequestSeen = (request:Request):void => {
    this.informationRequestRefused=true;
    if(this.seen.size>=1000&&!this.seen.has(request)){this.informationFailure('REQUEST_BUDGET_EXCEEDED');return;}
    this.seen.add(request);
    if(!this.evidencePolicyV2)this.stateVerified=false;
  };
  private readonly informationRoute = async (route:Route):Promise<void> => {
    this.informationRequestRefused=true;if(!this.evidencePolicyV2)this.stateVerified=false;
    const phase=this.informationPhase;
    const request=route.request();let outcome:'SUCCEEDED'|'FAILED'='FAILED';
    const abort=route.abort('blockedbyclient').then(()=>{outcome='SUCCEEDED';if(this.safelyAborted.size<1000)this.safelyAborted.add(request);else{this.informationFailure('REQUEST_BUDGET_EXCEEDED');}},()=>{this.informationFailure('ABORT_FAILED');});
    if(this.aborts.size<1000)this.aborts.add(abort);else{this.informationFailure('REQUEST_BUDGET_EXCEEDED');}
    await abort;this.aborts.delete(abort);
    // Closed diagnostics only. No URL, headers, request body, identifiers or free text.
    try{const request=route.request(),method=request.method().toUpperCase(),resourceType=request.resourceType();
      if(this.informationDeniedRequest===null){this.informationDeniedRequest={method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method)?method:'OTHER',
        resourceType:['document','xhr','fetch','image','stylesheet','script','font','websocket'].includes(resourceType)?resourceType:'other',
        navigation:request.isNavigationRequest(),abortOutcome:outcome};
        this.observedDeniedRequestPhase=phase;}
    }catch{/* Optional diagnostics must not interfere with the already attempted abort. */}
  };
  private readonly unexpectedPage = (other:Page):void => {
    if(other!==this.page){this.informationRequestRefused=true;this.informationFailure('UNEXPECTED_PAGE');void other.close().catch(()=>{this.hardStop=true;});}
  };
  async armReadOnlyInformation():Promise<void>{
    if(this.informationArmed)return;
    // One fresh wait at the actual arm boundary, after passive DOM prechecks.
    // Keep the initial observer until both ALL-HTTP routes are installed.
    if(this.initialLoad){
      this.initialLoadReadiness=await this.initialLoad.waitForFreshQuiet();
      if(this.initialLoadReadiness.status!=='QUIET_BEFORE_INFORMATION')throw Error('INITIAL_LOAD_NOT_QUIESCENT_NO_INFORMATION');
    }
    const context=this.page.context();context.on('request',this.informationRequestSeen);
    try{await context.route('**/*',this.informationRoute);await this.page.route('**/*',this.informationRoute);}
    catch{this.informationFailure('GUARD_ARM_FAILED');context.off('request',this.informationRequestSeen);await context.unroute('**/*',this.informationRoute).catch(()=>{});throw Error('INFORMATION_GUARD_ARM_FAILED');}
    this.informationArmed=true;context.on('page',this.unexpectedPage);
    this.page.once('close',()=>{void this.finishReadOnlyInformation().catch(()=>{this.stateVerified=false;});});
    if(this.initialLoad){this.initialLoadHandoffVerified=this.initialLoad.finishQuietHandoff();if(!this.initialLoadHandoffVerified){this.stateVerified=false;throw Error('INITIAL_LOAD_CHANGED_DURING_INFORMATION_ARM');}}
    this.informationPhase='ARMED_IDLE';
  }
  failInformationCleanup():void{this.informationFailure('POLICY_DOM_CLEANUP_UNVERIFIED');}
  private async boundedInformationWait(pending:Promise<unknown>,code:BookingInformationFailureCode,deadline:number):Promise<boolean>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const settled=pending.then(()=>true,()=>{this.informationFailure(code);return false;});
    try{return await Promise.race([settled,new Promise<boolean>(resolve=>{timer=setTimeout(()=>{this.informationFailure(code);resolve(false);},Math.max(0,deadline-Date.now()));})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  /** Settle already observed guarded requests before normal close. This is not an initial-load quiet wait. */
  async closeReadOnlyInformationPage():Promise<void>{
    if(this.informationArmed){
      const deadline=Date.now()+3000;
      while(!this.hardStop&&(this.aborts.size>0||[...this.seen].some(r=>!this.safelyAborted.has(r)))){
        if(Date.now()>=deadline){this.informationFailure('ABORT_DRAIN_TIMEOUT');break;}
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }
    }
    if(!await this.boundedInformationWait(this.page.close(),'PAGE_CLOSE_FAILED',Date.now()+3000))throw Error('INFORMATION_PAGE_CLOSE_FAILED');
  }
  /** Closed diagnostic only; never changes request admission or guard state. */
  setInformationPhase(phase:InformationPhase):void{this.informationPhase=phase;}
  /** The normal collector calls this after page.close and before reading final guard state or opening another page. */
  async finishReadOnlyInformation():Promise<void>{
    if(!this.informationArmed)return;
    if(!this.page.isClosed()){this.informationFailure('PAGE_NOT_CLOSED');throw Error('INFORMATION_PAGE_NOT_CLOSED');}
    if(this.finishPromise)return this.finishPromise;
    this.finishPromise=(async()=>{const deadline=Date.now()+3000;await this.boundedInformationWait(Promise.all([...this.aborts]),'ABORT_DRAIN_TIMEOUT',deadline);
      await this.boundedInformationWait(this.page.context().unroute('**/*',this.informationRoute),'ROUTE_CLEANUP_FAILED',deadline);
      // The closed page cannot issue new requests, but an owned route callback
      // may settle during unroute. Drain it before the final verified readback.
      while(this.aborts.size){if(!await this.boundedInformationWait(Promise.all([...this.aborts]),'ABORT_DRAIN_TIMEOUT',deadline))break;}
      if(this.evidencePolicyV2&&[...this.seen].some(r=>!this.safelyAborted.has(r))){this.informationFailure('UNABORTED_OBSERVED_REQUEST');}
      this.page.context().off('page',this.unexpectedPage);this.page.context().off('request',this.informationRequestSeen);if(this.disposePending)this.page.off('response',this.onResponse);
    })();return this.finishPromise;
  }
  private readonly onResponse = (response: Response): void => {
    const status = response.status();
    if (status !== 403 && status !== 429) return;
    try {
      const host = new URL(response.url()).hostname;
      if (host === 'booking.com' || host.endsWith('.booking.com')) {
        this.reason ??= classifyBlock(status, '');
        this.hardStop=true;
      }
    } catch { /* No URL or response content is retained. */ }
  };

  constructor(private readonly page: Page,private readonly initialLoad?:BookingInitialLoadObserver,readonly evidencePolicyV2=false) { page.on('response', this.onResponse); }

  async checkpoint(): Promise<boolean> {
    if(this.aborts.size&&!await this.boundedInformationWait(Promise.all([...this.aborts]),'ABORT_DRAIN_TIMEOUT',Date.now()+3000))return false;
    if (this.reason !== null || !this.stateVerified) return false;
    try {
      const title = await this.page.title();
      const body = await this.page.locator('body').innerText({ timeout: 3000 });
      this.reason ??= classifyBlock(null, `${title}\n${body}`);
      if(this.reason!==null)this.hardStop=true;
    } catch { this.stateVerified = false;this.informationFailureCode??='UI_STATE_UNREADABLE'; }
    return this.reason === null && this.stateVerified;
  }

  async requireClear(): Promise<void> {
    if (!await this.checkpoint()) throw Error('BOOKING_UI_BLOCKED_OR_UNVERIFIED');
  }

  dispose(): void { if(this.informationArmed&&!this.page.isClosed()){this.disposePending=true;return;}this.page.off('response',this.onResponse); }
}
