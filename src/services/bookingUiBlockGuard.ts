import type { Page, Response, Route } from 'playwright';
import { classifyBlock, type BlockReason } from './crawlThrottlePolicy';
import type {BookingInitialLoadObserver,BookingInitialLoadReadiness} from './bookingInitialLoadBarrier';
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
  // Information is read from the already loaded DOM. There is no accepted
  // allowlist or extra network budget, including for GET/HEAD and analytics.
  private readonly informationRequestSeen = ():void => {
    this.informationRequestRefused=true;this.stateVerified=false;
  };
  private readonly informationRoute = async (route:Route):Promise<void> => {
    this.informationRequestRefused=true;this.stateVerified=false;
    const phase=this.informationPhase;
    const outcome=await route.abort('blockedbyclient').then(()=>'SUCCEEDED' as const,()=>'FAILED' as const);
    // Closed diagnostics only. No URL, headers, request body, identifiers or free text.
    try{const request=route.request(),method=request.method().toUpperCase(),resourceType=request.resourceType();
      if(this.informationDeniedRequest===null){this.informationDeniedRequest={method:['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method)?method:'OTHER',
        resourceType:['document','xhr','fetch','image','stylesheet','script','font','websocket'].includes(resourceType)?resourceType:'other',
        navigation:request.isNavigationRequest(),abortOutcome:outcome};
        this.observedDeniedRequestPhase=phase;}
    }catch{/* Optional diagnostics must not interfere with the already attempted abort. */}
  };
  private readonly unexpectedPage = (other:Page):void => {
    if(other!==this.page){this.informationRequestRefused=true;this.stateVerified=false;void other.close().catch(()=>{});}
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
    catch{this.stateVerified=false;context.off('request',this.informationRequestSeen);await context.unroute('**/*',this.informationRoute).catch(()=>{});throw Error('INFORMATION_GUARD_ARM_FAILED');}
    this.informationArmed=true;context.on('page',this.unexpectedPage);
    this.page.once('close',()=>{void this.finishReadOnlyInformation().catch(()=>{this.stateVerified=false;});});
    if(this.initialLoad){this.initialLoadHandoffVerified=this.initialLoad.finishQuietHandoff();if(!this.initialLoadHandoffVerified){this.stateVerified=false;throw Error('INITIAL_LOAD_CHANGED_DURING_INFORMATION_ARM');}}
    this.informationPhase='ARMED_IDLE';
  }
  /** Closed diagnostic only; never changes request admission or guard state. */
  setInformationPhase(phase:InformationPhase):void{this.informationPhase=phase;}
  /** The normal collector calls this after page.close and before reading final guard state or opening another page. */
  async finishReadOnlyInformation():Promise<void>{
    if(!this.informationArmed)return;
    if(!this.page.isClosed()){this.stateVerified=false;throw Error('INFORMATION_PAGE_NOT_CLOSED');}
    if(this.finishPromise)return this.finishPromise;
    this.finishPromise=(async()=>{try{await this.page.context().unroute('**/*',this.informationRoute);}catch{this.stateVerified=false;}
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
      }
    } catch { /* No URL or response content is retained. */ }
  };

  constructor(private readonly page: Page,private readonly initialLoad?:BookingInitialLoadObserver) { page.on('response', this.onResponse); }

  async checkpoint(): Promise<boolean> {
    if (this.reason !== null || !this.stateVerified) return false;
    try {
      const title = await this.page.title();
      const body = await this.page.locator('body').innerText({ timeout: 3000 });
      this.reason ??= classifyBlock(null, `${title}\n${body}`);
    } catch { this.stateVerified = false; }
    return this.reason === null && this.stateVerified;
  }

  async requireClear(): Promise<void> {
    if (!await this.checkpoint()) throw Error('BOOKING_UI_BLOCKED_OR_UNVERIFIED');
  }

  dispose(): void { if(this.informationArmed&&!this.page.isClosed()){this.disposePending=true;return;}this.page.off('response',this.onResponse); }
}
