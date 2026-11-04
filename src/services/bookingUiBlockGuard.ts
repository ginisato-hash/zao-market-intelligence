import type { Page, Response, Route,Request } from 'playwright';
import { classifyBlock, type BlockReason } from './crawlThrottlePolicy';
import type {BookingInitialLoadObserver,BookingInitialLoadReadiness} from './bookingInitialLoadBarrier';
import {isOwnedBookingBrowser,ownedBookingBrowserStatus,terminateOwnedBookingBrowser} from './bookingOwnedBrowser';
export type BookingInformationFailureCode='REQUEST_BUDGET_EXCEEDED'|'ABORT_FAILED'|'UNEXPECTED_PAGE'|'GUARD_ARM_FAILED'|'POLICY_DOM_CLEANUP_UNVERIFIED'|'ABORT_DRAIN_TIMEOUT'|'PAGE_CLOSE_FAILED'|'PAGE_NOT_CLOSED'|'ROUTE_CLEANUP_FAILED'|'UNABORTED_OBSERVED_REQUEST'|'UI_STATE_UNREADABLE'|'OWNED_BROWSER_TERMINATION_FAILED'|'OWNED_BROWSER_DISCONNECTED';
type InformationPhase='ARMING'|'ARMED_IDLE'|'CALENDAR_OPEN'|'CALENDAR_READ'|'CALENDAR_CLOSE'|'CALENDAR_CLOSED'|'RATE_INFORMATION';
type LifecyclePhase='BEFORE_ARM'|'INSTALLING'|'ACTIVE'|'PRECLOSE'|'CLOSING'|'CLOSED'|'DRAINING'|'UNROUTING'|'FINAL';
type RequestDiagnostic={id:number;method:string;resourceType:string;navigation:boolean;seen:number|null;routeStarted:number|null;routeCompleted:number|null;abortSucceeded:number|null;abortFailed:number|null;seenPhase:InformationPhase|null;routePhase:InformationPhase|null;lifecycleAtSeen:LifecyclePhase|null;lifecycleAtRoute:LifecyclePhase|null};
type CausalEvent='initialEvent'|'initialRoute'|'fallbackStarted'|'fallbackSettled'|'fallbackFailed'|'informationEvent'|'informationRoute'|'finished'|'failed';
type CausalRequest={id:number;method:string;resourceType:string;navigation:boolean;scheme:'HTTP'|'HTTPS'|'OTHER'|'UNREADABLE';informationDiagnosticId:number|null;first:Partial<Record<CausalEvent,number>>;last:Partial<Record<CausalEvent,number>>;counts:Partial<Record<CausalEvent,number>>;failureClass:'NET_ERR_ABORTED'|'NET_ERR_BLOCKED_BY_CLIENT'|'OTHER'|'UNAVAILABLE'|null};

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
  private routingPreparedOrPreparing=false;
  private routingPrepared=false;
  private routePreparation:Promise<void>|null=null;
  private informationSwitched=false;
  private readonly initialContinuations=new Set<Promise<void>>();
  // Separate diagnostic namespace: it never changes V2 admission, seen/abort
  // sets, quiet timing or the meaning of a successful route.abort receipt.
  private causalSequence=0;
  private causalOverflow=false;
  private causalUnreadable=false;
  private readonly causalRequests=new Map<Request,CausalRequest>();
  private readonly causalBoundaries:Partial<Record<'prepareStarted'|'contextReady'|'pageReady'|'denySwitch'|'closeCalled'|'killCalled'|'ownedTerminationVerified'|'final',number>>={};
  private causalDenyReason:'INFORMATION_ARM'|'NO_INFO_CLOSE'|'PREPARE_FAILED'|'PREPARE_INCOMPLETE'|'INITIAL_ROUTE_BUDGET'|null=null;
  private causalOrder():number{if(this.causalSequence>=1_000_000)this.causalOverflow=true;return this.causalSequence=Math.min(1_000_000,this.causalSequence+1);}
  private recordCausalDeny(reason:NonNullable<BookingUiBlockGuard['causalDenyReason']>):void{if(this.causalBoundaries.denySwitch===undefined){this.causalBoundaries.denySwitch=this.causalOrder();this.causalDenyReason=reason;}}
  private causalMark(request:Request,event:CausalEvent,informationId:number|null=null):void{
    try{
      let row=this.causalRequests.get(request);
      if(!row){
        if(this.causalRequests.size>=1000){this.causalOverflow=true;return;}
        let method='OTHER',resourceType='other',navigation=false,scheme:CausalRequest['scheme']='UNREADABLE';
        try{const m=request.method().toUpperCase(),r=request.resourceType();method=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(m)?m:'OTHER';resourceType=['document','xhr','fetch','image','stylesheet','script','font','websocket'].includes(r)?r:'other';navigation=request.isNavigationRequest()===true;const protocol=new URL(request.url()).protocol;scheme=protocol==='http:'?'HTTP':protocol==='https:'?'HTTPS':'OTHER';}catch{this.causalUnreadable=true;}
        row={id:this.causalRequests.size+1,method,resourceType,navigation,scheme,informationDiagnosticId:null,first:{},last:{},counts:{},failureClass:null};this.causalRequests.set(request,row);
      }
      const order=this.causalOrder();row.first[event]??=order;row.last[event]=order;row.counts[event]=Math.min(1_000_000,(row.counts[event]??0)+1);if(informationId!==null)row.informationDiagnosticId=informationId;
      if(event==='failed'){try{const error=request.failure()?.errorText;row.failureClass=error==='net::ERR_ABORTED'?'NET_ERR_ABORTED':error==='net::ERR_BLOCKED_BY_CLIENT'?'NET_ERR_BLOCKED_BY_CLIENT':typeof error==='string'?'OTHER':'UNAVAILABLE';}catch{row.failureClass='UNAVAILABLE';this.causalUnreadable=true;}}
    }catch{this.causalUnreadable=true;}
  }
  private readonly causalFinished=(request:Request):void=>{this.causalMark(request,'finished');};
  private readonly causalFailed=(request:Request):void=>{this.causalMark(request,'failed');};
  get initialRouteCausalDiagnostics(){
    const rows=[...this.causalRequests.values()],copy=(r:CausalRequest)=>({...r,first:{...r.first},last:{...r.last},counts:{...r.counts}}),sum=(event:CausalEvent)=>rows.reduce((n,r)=>n+(r.counts[event]??0),0);
    return {schema:'BOOKING_INITIAL_ROUTE_CAUSAL_DIAGNOSTICS_V1',evidenceScope:'DIAGNOSTIC_ONLY_NOT_WIRE_OR_ADMISSION_PROOF',sequence:this.causalSequence,overflow:this.causalOverflow,unreadable:this.causalUnreadable,prepared:this.routingPrepared,boundaries:{...this.causalBoundaries},denyReason:this.causalDenyReason,trackedRequests:rows.length,counts:{initialEvents:sum('initialEvent'),initialRoutes:sum('initialRoute'),fallbackStarted:sum('fallbackStarted'),fallbackSettled:sum('fallbackSettled'),fallbackFailed:sum('fallbackFailed'),informationEvents:sum('informationEvent'),informationRoutes:sum('informationRoute'),finished:sum('finished'),failed:sum('failed')},pendingInitialCallbacks:this.initialContinuations.size,lastRequests:rows.slice(-8).map(copy),lastInformationRequests:rows.filter(r=>r.first.informationEvent!==undefined||r.first.informationRoute!==undefined).slice(-8).map(copy)};
  }
  private finishPromise:Promise<void>|null = null;
  private ownedTerminationPlanned=false;
  private ownedTerminationVerified=false;
  private disposePending = false;
  hardStop=false;
  informationFailureCode:BookingInformationFailureCode|null=null;
  private informationFailure(code:BookingInformationFailureCode):void{if(this.informationFailureCode===null)this.failureDiagnostic={order:this.order(),phase:this.informationPhase,lifecycle:this.lifecycle};this.informationFailureCode??=code;this.stateVerified=false;this.hardStop=true;}
  private readonly seen=new Set<Request>();
  private readonly safelyAborted=new Set<Request>();
  private readonly aborts=new Set<Promise<void>>();
  private diagnosticOrder=0;
  private lifecycle:LifecyclePhase='BEFORE_ARM';
  private readonly boundaries:Partial<Record<LifecyclePhase,number>>={};
  private readonly registration:Partial<Record<'REQUEST_LISTENER_ON'|'CONTEXT_ROUTE_BEGIN'|'CONTEXT_ROUTE_READY'|'PAGE_ROUTE_BEGIN'|'PAGE_ROUTE_READY'|'UNROUTE_BEGIN'|'UNROUTE_END'|'UNROUTE_FAILED'|'REQUEST_LISTENER_OFF',number>>={};
  private readonly requestDiagnostics=new Map<Request,RequestDiagnostic>();
  private diagnosticOverflow=false;
  private failureDiagnostic:{order:number;phase:InformationPhase;lifecycle:LifecyclePhase}|null=null;
  private order():number{return this.diagnosticOrder=Math.min(1_000_000,this.diagnosticOrder+1);}
  private boundary(phase:LifecyclePhase):void{this.lifecycle=phase;this.boundaries[phase]??=this.order();}
  private diagnostic(request:Request):RequestDiagnostic|null{
    const existing=this.requestDiagnostics.get(request);if(existing)return existing;
    if(this.requestDiagnostics.size>=1000){this.diagnosticOverflow=true;return null;}
    let method='OTHER',resourceType='other',navigation=false;
    try{const m=request.method().toUpperCase(),r=request.resourceType();method=['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(m)?m:'OTHER';resourceType=['document','xhr','fetch','image','stylesheet','script','font','websocket'].includes(r)?r:'other';navigation=request.isNavigationRequest()===true;}catch{/* Closed fallback only; never retain exception text. */}
    const d:RequestDiagnostic={id:this.requestDiagnostics.size+1,method,resourceType,navigation,seen:null,routeStarted:null,routeCompleted:null,abortSucceeded:null,abortFailed:null,seenPhase:null,routePhase:null,lifecycleAtSeen:null,lifecycleAtRoute:null};this.requestDiagnostics.set(request,d);return d;
  }
  /** Finite page-local ordering only. Never includes URL, payload, headers, error text or cross-run identifiers. */
  get informationDiagnostics(){
    const rows=[...this.requestDiagnostics.values()],unmatched=rows.filter(x=>x.seen!==null&&x.abortSucceeded===null);
    return {schema:isOwnedBookingBrowser(this.page.context().browser())?'BOOKING_INFORMATION_LIFECYCLE_DIAGNOSTICS_V2':'BOOKING_INFORMATION_LIFECYCLE_DIAGNOSTICS_V1',sequence:this.diagnosticOrder,overflow:this.diagnosticOverflow,lifecycle:this.lifecycle,boundaries:{...this.boundaries},failure:this.failureDiagnostic?{...this.failureDiagnostic}:null,
      termination:{mode:isOwnedBookingBrowser(this.page.context().browser())?'OWNED_PROCESS_KILL':'LEGACY_PAGE_CLOSE',planned:this.ownedTerminationPlanned,verified:this.ownedTerminationVerified,...ownedBookingBrowserStatus(this.page.context().browser())},
      registration:{...this.registration},counts:{seen:this.seen.size,routeStarted:rows.filter(x=>x.routeStarted!==null).length,routeCompleted:rows.filter(x=>x.routeCompleted!==null).length,abortSucceeded:this.safelyAborted.size,abortFailed:rows.filter(x=>x.abortFailed!==null).length,abortPending:this.aborts.size,unmatched:[...this.seen].filter(r=>!this.safelyAborted.has(r)).length},
      lastUnmatched:unmatched.slice(-8).map(x=>({...x})),lastRequests:rows.slice(-8).map(x=>({...x}))};
  }
  // Information is read from the already loaded DOM. There is no accepted
  // allowlist or extra network budget, including for GET/HEAD and analytics.
  private readonly informationRequestSeen = (request:Request):void => {
    if(this.routingPreparedOrPreparing&&!this.informationSwitched){this.causalMark(request,'initialEvent');return;}
    this.informationRequestRefused=true;
    if(this.seen.size>=1000&&!this.seen.has(request)){this.diagnosticOverflow=true;this.informationFailure('REQUEST_BUDGET_EXCEEDED');return;}
    this.seen.add(request);
    const d=this.diagnostic(request);if(d){d.seen??=this.order();d.seenPhase??=this.informationPhase;d.lifecycleAtSeen??=this.lifecycle;}
    this.causalMark(request,'informationEvent',d?.id??null);
    if(!this.evidencePolicyV2)this.stateVerified=false;
  };
  private readonly informationRoute = async (route:Route):Promise<void> => {
    // INITIAL retains the existing request and earlier routing handlers. Routing
    // disables HTTP cache, so this is not a claim of identical initial traffic.
    if(this.routingPreparedOrPreparing&&!this.informationSwitched&&!this.hardStop&&this.initialContinuations.size>=1000){this.recordCausalDeny('INITIAL_ROUTE_BUDGET');this.informationSwitched=true;this.informationFailure('REQUEST_BUDGET_EXCEEDED');}
    if(this.routingPreparedOrPreparing&&!this.informationSwitched&&!this.hardStop){
      let request:Request|null=null;try{request=route.request();this.causalMark(request,'initialRoute');this.causalMark(request,'fallbackStarted');}catch{this.causalUnreadable=true;}
      let pending:Promise<void>;try{pending=route.fallback();}catch{if(request)this.causalMark(request,'fallbackFailed');this.informationFailure('GUARD_ARM_FAILED');return;}
      this.initialContinuations.add(pending);
      try{await pending;if(request)this.causalMark(request,'fallbackSettled');}catch{if(request)this.causalMark(request,'fallbackFailed');if(!this.ownedTerminationPlanned)this.informationFailure('GUARD_ARM_FAILED');}
      finally{this.initialContinuations.delete(pending);}return;
    }
    this.informationRequestRefused=true;if(!this.evidencePolicyV2)this.stateVerified=false;
    const phase=this.informationPhase;
    const request=route.request();let outcome:'SUCCEEDED'|'FAILED'='FAILED';
    const d=this.diagnostic(request);if(d){d.routeStarted??=this.order();d.routePhase??=phase;d.lifecycleAtRoute??=this.lifecycle;}
    this.causalMark(request,'informationRoute',d?.id??null);
    let pending:Promise<void>;try{pending=route.abort('blockedbyclient');}catch{pending=Promise.reject(new Error('ABORT_FAILED'));}
    const abort=pending.then(()=>{outcome='SUCCEEDED';if(d)d.abortSucceeded=this.order();if(this.safelyAborted.size<1000)this.safelyAborted.add(request);else{this.informationFailure('REQUEST_BUDGET_EXCEEDED');}},()=>{if(d)d.abortFailed=this.order();this.informationFailure('ABORT_FAILED');});
    if(this.aborts.size<1000)this.aborts.add(abort);else{this.informationFailure('REQUEST_BUDGET_EXCEEDED');}
    await abort;this.aborts.delete(abort);if(d)d.routeCompleted=this.order();
    // Closed diagnostics only. No URL, headers, request body, identifiers or free text.
    try{const request=route.request(),method=request.method().toUpperCase(),resourceType=request.resourceType();
      if(this.informationDeniedRequest===null){this.informationDeniedRequest={method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method)?method:'OTHER',
        resourceType:['document','xhr','fetch','image','stylesheet','script','font','websocket'].includes(resourceType)?resourceType:'other',
        navigation:request.isNavigationRequest(),abortOutcome:outcome};
        this.observedDeniedRequestPhase=phase;}
    }catch{/* Optional diagnostics must not interfere with the already attempted abort. */}
  };
  private readonly unexpectedPage = (other:Page):void => {
    if(other!==this.page){this.informationRequestRefused=true;this.informationFailure('UNEXPECTED_PAGE');const browser=this.page.context().browser();if(isOwnedBookingBrowser(browser))void terminateOwnedBookingBrowser(browser!).catch(()=>{});else void other.close().catch(()=>{this.hardStop=true;});}
  };
  /** Owned V2 normal collector only: prepare both routes before the sole goto.
   * No navigation/request is issued here; failure never falls back to late setup. */
  async prepareInformationRoutesBeforeNavigation():Promise<void>{
    if(this.routePreparation)return this.routePreparation;
    if(!this.evidencePolicyV2||!this.initialLoad||!isOwnedBookingBrowser(this.page.context().browser())||this.page.url()!=='about:blank'||this.informationArmed||this.hardStop){this.informationFailure('GUARD_ARM_FAILED');throw Error('INFORMATION_GUARD_PREPARE_REFUSED');}
    this.routingPreparedOrPreparing=true;
    this.causalBoundaries.prepareStarted=this.causalOrder();
    const context=this.page.context(),deadline=performance.now()+1000;
    const bounded=async(pending:Promise<unknown>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([pending,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(Error('GUARD_PREPARE_TIMEOUT')),Math.max(0,deadline-performance.now()));})]);if(performance.now()>deadline)throw Error('GUARD_PREPARE_TIMEOUT');}finally{if(timer!==undefined)clearTimeout(timer);}};
    this.routePreparation=(async()=>{
      context.on('request',this.informationRequestSeen);this.registration.REQUEST_LISTENER_ON=this.order();
      context.on('requestfinished',this.causalFinished);context.on('requestfailed',this.causalFailed);
      try{this.registration.CONTEXT_ROUTE_BEGIN=this.order();await bounded(context.route('**/*',this.informationRoute));this.registration.CONTEXT_ROUTE_READY=this.order();this.causalBoundaries.contextReady=this.causalOrder();this.registration.PAGE_ROUTE_BEGIN=this.order();await bounded(this.page.route('**/*',this.informationRoute));this.registration.PAGE_ROUTE_READY=this.order();this.causalBoundaries.pageReady=this.causalOrder();this.routingPrepared=true;}
      catch{this.recordCausalDeny('PREPARE_FAILED');this.informationSwitched=true;this.informationFailure('GUARD_ARM_FAILED');throw Error('INFORMATION_GUARD_PREPARE_FAILED');}
    })();return this.routePreparation;
  }
  async armReadOnlyInformation():Promise<void>{
    if(this.informationArmed)return;
    this.boundary('INSTALLING');
    // One fresh wait at the actual arm boundary, after passive DOM prechecks.
    // Keep the initial observer until both ALL-HTTP routes are installed.
    if(this.initialLoad){
      this.initialLoadReadiness=await this.initialLoad.waitForFreshQuiet();
      if(this.initialLoadReadiness.status!=='QUIET_BEFORE_INFORMATION')throw Error('INITIAL_LOAD_NOT_QUIESCENT_NO_INFORMATION');
    }
    const context=this.page.context();
    if(this.routingPreparedOrPreparing&&!this.routingPrepared){this.recordCausalDeny('PREPARE_INCOMPLETE');this.informationSwitched=true;this.informationFailure('GUARD_ARM_FAILED');throw Error('INFORMATION_GUARD_NOT_PREPARED');}
    if(!this.routingPrepared){
      context.on('request',this.informationRequestSeen);this.registration.REQUEST_LISTENER_ON=this.order();
      try{this.registration.CONTEXT_ROUTE_BEGIN=this.order();await context.route('**/*',this.informationRoute);this.registration.CONTEXT_ROUTE_READY=this.order();this.registration.PAGE_ROUTE_BEGIN=this.order();await this.page.route('**/*',this.informationRoute);this.registration.PAGE_ROUTE_READY=this.order();}
      catch{this.informationFailure('GUARD_ARM_FAILED');context.off('request',this.informationRequestSeen);await context.unroute('**/*',this.informationRoute).catch(()=>{});throw Error('INFORMATION_GUARD_ARM_FAILED');}
    }
    // Both handlers already exist on the owned path. There is no await from
    // switching every HTTP request to DENY through the quiet handoff check.
    this.recordCausalDeny('INFORMATION_ARM');this.informationSwitched=true;this.informationArmed=true;context.on('page',this.unexpectedPage);
    this.page.once('close',()=>{if(isOwnedBookingBrowser(this.page.context().browser())){if(!this.ownedTerminationPlanned)this.informationFailure('PAGE_CLOSE_FAILED');return;}void this.finishReadOnlyInformation().catch(()=>{this.stateVerified=false;});});
    if(this.initialLoad){const continuationPending=this.initialContinuations.size>0;this.initialLoadHandoffVerified=this.initialLoad.finishQuietHandoff()&&!continuationPending;if(continuationPending)this.informationFailure('GUARD_ARM_FAILED');if(!this.initialLoadHandoffVerified){
      // A request already seen during installation without any route callback
      // has no abort receipt to drain. Keep it unmatched and stop immediately,
      // preserving the existing owned-termination budget instead of using it up.
      if([...this.seen].some(request=>this.requestDiagnostics.get(request)?.routeStarted===null))this.informationFailure('UNABORTED_OBSERVED_REQUEST');
      this.stateVerified=false;throw Error('INITIAL_LOAD_CHANGED_DURING_INFORMATION_ARM');
    }}
    this.informationPhase='ARMED_IDLE';
    this.boundary('ACTIVE');
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
    this.causalBoundaries.closeCalled??=this.causalOrder();
    // No-information exits also keep every new HTTP callback in DENY while the
    // owned process is terminating. This does not manufacture a quiet handoff.
    if(this.routingPreparedOrPreparing){this.recordCausalDeny('NO_INFO_CLOSE');this.informationSwitched=true;}
    this.boundary('PRECLOSE');
    const browser=this.page.context().browser();
    if(isOwnedBookingBrowser(browser)){
      this.ownedTerminationPlanned=true;
      const deadline=performance.now()+3000;
      if(ownedBookingBrowserStatus(browser).unexpectedDisconnect)this.informationFailure('OWNED_BROWSER_DISCONNECTED');
      while(!this.hardStop&&(this.aborts.size>0||[...this.seen].some(r=>!this.safelyAborted.has(r)))){
        if(performance.now()>=deadline){this.informationFailure('ABORT_DRAIN_TIMEOUT');break;}
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }
      this.boundary('CLOSING');
      this.causalBoundaries.killCalled??=this.causalOrder();
      try{await terminateOwnedBookingBrowser(browser!,deadline);this.ownedTerminationVerified=true;this.causalBoundaries.ownedTerminationVerified=this.causalOrder();}
      catch{this.informationFailure('OWNED_BROWSER_TERMINATION_FAILED');throw Error('OWNED_BROWSER_TERMINATION_FAILED');}
      this.boundaries.CLOSED??=this.order();return;
    }
    if(this.informationArmed){
      const deadline=Date.now()+3000;
      while(!this.hardStop&&(this.aborts.size>0||[...this.seen].some(r=>!this.safelyAborted.has(r)))){
        if(Date.now()>=deadline){this.informationFailure('ABORT_DRAIN_TIMEOUT');break;}
        await new Promise<void>(resolve=>setTimeout(resolve,10));
      }
    }
    this.boundary('CLOSING');
    if(!await this.boundedInformationWait(this.page.close(),'PAGE_CLOSE_FAILED',Date.now()+3000))throw Error('INFORMATION_PAGE_CLOSE_FAILED');
    // page.close may trigger the owned finish callback before this promise resolves.
    this.boundaries.CLOSED??=this.order();
  }
  /** Closed diagnostic only; never changes request admission or guard state. */
  setInformationPhase(phase:InformationPhase):void{this.informationPhase=phase;}
  /** The normal collector calls this after page.close and before reading final guard state or opening another page. */
  async finishReadOnlyInformation():Promise<void>{
    const browser=this.page.context().browser();
    if(isOwnedBookingBrowser(browser)){
      if(!this.ownedTerminationVerified){this.informationFailure('OWNED_BROWSER_TERMINATION_FAILED');throw Error('OWNED_BROWSER_TERMINATION_UNVERIFIED');}
      if(this.finishPromise)return this.finishPromise;
      this.finishPromise=(async()=>{
        this.boundary('DRAINING');
        // SIGKILL is no abort receipt. Every observed request still needs its
        // original successful disposition; process death never fills a gap.
        if(this.aborts.size)this.informationFailure('ABORT_DRAIN_TIMEOUT');
        if([...this.seen].some(r=>!this.safelyAborted.has(r)))this.informationFailure('UNABORTED_OBSERVED_REQUEST');
        // The whole owned process is gone. No unroute command is sent to a
        // disconnected browser; routes remain installed until that verified exit.
        this.page.context().off('page',this.unexpectedPage);this.page.context().off('request',this.informationRequestSeen);this.page.context().off('requestfinished',this.causalFinished);this.page.context().off('requestfailed',this.causalFailed);this.registration.REQUEST_LISTENER_OFF=this.order();this.boundary('FINAL');this.causalBoundaries.final=this.causalOrder();
      })();return this.finishPromise;
    }
    if(!this.informationArmed)return;
    if(!this.page.isClosed()){this.informationFailure('PAGE_NOT_CLOSED');throw Error('INFORMATION_PAGE_NOT_CLOSED');}
    if(this.finishPromise)return this.finishPromise;
    this.boundaries.CLOSED??=this.order();
    this.finishPromise=(async()=>{this.boundary('DRAINING');const deadline=Date.now()+3000;await this.boundedInformationWait(Promise.all([...this.aborts]),'ABORT_DRAIN_TIMEOUT',deadline);
      this.boundary('UNROUTING');
      this.registration.UNROUTE_BEGIN=this.order();
      const cleanup=this.page.context().unroute('**/*',this.informationRoute).then(()=>{this.registration.UNROUTE_END=this.order();},()=>{this.registration.UNROUTE_FAILED=this.order();throw Error('ROUTE_CLEANUP_FAILED');});
      await this.boundedInformationWait(cleanup,'ROUTE_CLEANUP_FAILED',deadline);
      // The closed page cannot issue new requests, but an owned route callback
      // may settle during unroute. Drain it before the final verified readback.
      while(this.aborts.size){if(!await this.boundedInformationWait(Promise.all([...this.aborts]),'ABORT_DRAIN_TIMEOUT',deadline))break;}
      if(this.evidencePolicyV2&&[...this.seen].some(r=>!this.safelyAborted.has(r))){this.informationFailure('UNABORTED_OBSERVED_REQUEST');}
      this.page.context().off('page',this.unexpectedPage);this.page.context().off('request',this.informationRequestSeen);this.registration.REQUEST_LISTENER_OFF=this.order();if(this.disposePending)this.page.off('response',this.onResponse);
      this.boundary('FINAL');
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
    if(this.hardStop)return false;
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
