import { describe, expect, it } from "vitest";
import {
  classifyGoogleHotelsFreeDirectProbe,
  GOOGLE_HOTELS_PROBE_SCOPE,
  type GoogleHotelsFreeDirectSignals
} from "../src/feasibility/googleHotelsFreeDirectProbe";

function signals(overrides: Partial<GoogleHotelsFreeDirectSignals> = {}): GoogleHotelsFreeDirectSignals {
  const bodyText = overrides.bodyText ?? "a".repeat(1000);
  return {
    loaded: true,
    bodyText,
    bodyTextLength: overrides.bodyTextLength ?? bodyText.trim().length,
    finalUrl: GOOGLE_HOTELS_PROBE_SCOPE.propertyUrl,
    ...overrides
  };
}

describe("googleHotelsFreeDirectProbe", () => {
  it("targets the public Google Travel entity page only (no API host)", () => {
    expect(GOOGLE_HOTELS_PROBE_SCOPE.propertyUrl).toBe(
      "https://www.google.com/travel/hotels/entity/CgoIn_eG0v78uPpiEAE"
    );
    expect(GOOGLE_HOTELS_PROBE_SCOPE.propertyUrl).not.toContain("serpapi");
    expect(GOOGLE_HOTELS_PROBE_SCOPE.propertyUrl).not.toContain("key=");
  });

  it("classifies a non-loaded page as unsupported", () => {
    expect(classifyGoogleHotelsFreeDirectProbe(signals({ loaded: false })).status).toBe("unsupported");
  });

  it("classifies captcha / unusual traffic", () => {
    expect(classifyGoogleHotelsFreeDirectProbe(signals({ bodyText: "unusual traffic detected" })).status).toBe(
      "captcha"
    );
  });

  it("classifies a consent wall as unsupported/consent_or_js_wall", () => {
    const result = classifyGoogleHotelsFreeDirectProbe(
      signals({ bodyText: `Before you continue ${"x".repeat(500)}` })
    );
    expect(result.status).toBe("unsupported");
    expect(result.accessStatus).toBe("consent_or_js_wall");
  });

  it("classifies a near-empty JS shell as unsupported/consent_or_js_wall", () => {
    const result = classifyGoogleHotelsFreeDirectProbe(signals({ bodyText: "loading", bodyTextLength: 7 }));
    expect(result.status).toBe("unsupported");
    expect(result.accessStatus).toBe("consent_or_js_wall");
  });

  it("classifies visible content without a safe free price as unsupported", () => {
    const result = classifyGoogleHotelsFreeDirectProbe(signals({ bodyText: "ル・ベール蔵王 ".repeat(100) }));
    expect(result.status).toBe("unsupported");
    expect(result.accessStatus).toBe("no_safe_free_price_path");
  });
});
