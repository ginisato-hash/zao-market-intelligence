import type { Page, Response, Route, Request } from 'playwright';
import { classifyBlock, type BlockReason } from './crawlThrottlePolicy';

/** Sticky, page-local detection only. It never retries, navigates or solves a challenge. */
export class BookingUiBlockGuard {
  reason: BlockReason = null;
  stateVerified = true;
  informationRequestRefused = false;
  private informationArmed = false;
  private finishPromise:Promise<void>|null = null;
  private disposePending = false;
  private readonly informationRequestSeen = (request:Request):void => {
    if(!request.isNavigationRequest())return;
    this.informationRequestRefused=true;this.stateVerified=false;
  };
  private readonly navigationRoute = async (route:Route):Promise<void> => {
    if(route.request().isNavigationRequest()){
      this.informationRequestRefused=true;this.stateVerified=false;await route.abort('blockedbyclient').catch(()=>{});}
    else await route.fallback();
  };
  private readonly unexpectedPage = (other:Page):void => {
    if(other!==this.page){this.informationRequestRefused=true;this.stateVerified=false;void other.close().catch(()=>{});}
  };
  async armReadOnlyInformation():Promise<void>{
    if(this.informationArmed)return;
    const context=this.page.context();context.on('request',this.informationRequestSeen);
    try{await context.route('**/*',this.navigationRoute);await this.page.route('**/*',this.navigationRoute);}
    catch{this.stateVerified=false;context.off('request',this.informationRequestSeen);await context.unroute('**/*',this.navigationRoute).catch(()=>{});throw Error('INFORMATION_GUARD_ARM_FAILED');}
    this.informationArmed=true;context.on('page',this.unexpectedPage);
    this.page.once('close',()=>{void this.finishReadOnlyInformation().catch(()=>{this.stateVerified=false;});});
  }
  /** The normal collector calls this after page.close and before reading final guard state or opening another page. */
  async finishReadOnlyInformation():Promise<void>{
    if(!this.informationArmed)return;
    if(!this.page.isClosed()){this.stateVerified=false;throw Error('INFORMATION_PAGE_NOT_CLOSED');}
    if(this.finishPromise)return this.finishPromise;
    this.finishPromise=(async()=>{try{await this.page.context().unroute('**/*',this.navigationRoute);}catch{this.stateVerified=false;}
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

  constructor(private readonly page: Page) { page.on('response', this.onResponse); }

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
