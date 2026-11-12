import type { Page } from "playwright";
import { analyzeBookingRenderedDomSignals, classifyBookingRenderedDom, type BookingRenderedDomTarget } from "./bookingRenderedDomProbe";
import { classifyBlock, sleep, type BlockReason } from "./crawlThrottlePolicy";

interface ListingText { pageTitle: string; bodyText: string }
interface ComparisonBaseline {
  page: Page;
  target: BookingRenderedDomTarget;
  checkin: string;
  checkout: string;
  finalUrl: string;
  assertSameDocument: () => Promise<void>;
  guardClear: () => boolean;
}

// This runs only on an already bound, public same-stay revisit. Keep the
// original DOM-read deadline. An empty listing at expiry supplies no price.
export async function readComparisonBaseline(input: ComparisonBaseline, first: ListingText, deadline: number) {
  let text = first;
  let lastInTime = first;
  let samples = 1;
  let block: BlockReason = null;
  for (;;) {
    const signals = analyzeBookingRenderedDomSignals({
      target: input.target, checkin: input.checkin, checkout: input.checkout, finalUrl: input.finalUrl,
      loaded: true, httpStatus: 200, ...text
    });
    block = classifyBlock(200, text.pageTitle + "\n" + text.bodyText);
    if (signals.captchaOrSecurityDetected || (signals.loginRequiredDetected && signals.bodyTextLength < 1000)) {
      block ??= "captcha_or_login_wall";
    }
    if (performance.now() >= deadline || !input.guardClear()) break;
    lastInTime = text;
    if (block || signals.soldOutOrUnavailableDetected || signals.notFoundDetected ||
        classifyBookingRenderedDom(signals) !== "booking_rendered_empty_or_near_empty") break;

    if (deadline - performance.now() <= 250) break;
    await sleep(250);
    if (!input.guardClear() || performance.now() >= deadline) break;
    await input.assertSameDocument();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0 || !input.guardClear()) break;
    text = await input.page.locator("body").evaluate(body => ({
      pageTitle: body.ownerDocument.title, bodyText: (body as HTMLElement).innerText
    }), undefined, { timeout: remaining });
    await input.assertSameDocument();
    samples++;
  }
  return { ...lastInTime, block, samples };
}
