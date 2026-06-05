import { describe, it, expect } from "vitest";
import {
  loadSourceCapabilities,
  listAllowedSources,
  listForbiddenSources,
  assertSourceAllowed,
  assertNoPaidSourcesEnabled,
  getSourceCapability,
  DEFAULT_SOURCE_CAPABILITY_PATH
} from "../src/services/sourceCapabilityRegistry";
import type { SourceCapability } from "../src/config/sourceCapabilitySchema";

const CAPABILITIES: SourceCapability[] = [
  {
    source: "jalan",
    status: "active",
    source_type: "direct_ota",
    cost_policy: "free_direct_only",
    confidence: "A",
    allowed: true,
    paid_service_required: false,
    notes: "Working."
  },
  {
    source: "rakuten",
    status: "parked",
    source_type: "direct_ota",
    cost_policy: "free_direct_only",
    confidence: "unknown",
    allowed: true,
    paid_service_required: false,
    notes: "Parked."
  },
  {
    source: "serpapi",
    status: "forbidden",
    source_type: "paid_serp_api",
    cost_policy: "paid_forbidden",
    confidence: "none",
    allowed: false,
    paid_service_required: true,
    notes: "Forbidden."
  }
];

describe("loadSourceCapabilities", () => {
  it("loads and validates the default config file without error", () => {
    expect(() => loadSourceCapabilities(DEFAULT_SOURCE_CAPABILITY_PATH)).not.toThrow();
  });

  it("loaded config contains at least jalan", () => {
    const caps = loadSourceCapabilities(DEFAULT_SOURCE_CAPABILITY_PATH);
    expect(caps.some((c) => c.source === "jalan")).toBe(true);
  });

  it("throws on a non-existent path", () => {
    expect(() =>
      loadSourceCapabilities("data/config/does_not_exist.json")
    ).toThrow();
  });
});

describe("listAllowedSources", () => {
  it("returns only sources with allowed=true", () => {
    const allowed = listAllowedSources(CAPABILITIES);
    expect(allowed.every((c) => c.allowed)).toBe(true);
    expect(allowed.map((c) => c.source)).toContain("jalan");
    expect(allowed.map((c) => c.source)).toContain("rakuten");
    expect(allowed.map((c) => c.source)).not.toContain("serpapi");
  });
});

describe("listForbiddenSources", () => {
  it("returns only sources with allowed=false", () => {
    const forbidden = listForbiddenSources(CAPABILITIES);
    expect(forbidden.every((c) => !c.allowed)).toBe(true);
    expect(forbidden.map((c) => c.source)).toContain("serpapi");
    expect(forbidden.map((c) => c.source)).not.toContain("jalan");
  });
});

describe("assertSourceAllowed", () => {
  it("does not throw for jalan", () => {
    expect(() => assertSourceAllowed("jalan", CAPABILITIES)).not.toThrow();
  });

  it("does not throw for rakuten (parked but allowed)", () => {
    expect(() => assertSourceAllowed("rakuten", CAPABILITIES)).not.toThrow();
  });

  it("throws for serpapi", () => {
    expect(() => assertSourceAllowed("serpapi", CAPABILITIES)).toThrow(
      'Source "serpapi" is not allowed'
    );
  });

  it("throws for an unknown source name", () => {
    expect(() => assertSourceAllowed("unknown_xyz", CAPABILITIES)).toThrow(
      'Unknown source "unknown_xyz"'
    );
  });
});

describe("assertNoPaidSourcesEnabled", () => {
  it("passes for the current CAPABILITIES fixture (no paid source is allowed)", () => {
    expect(() => assertNoPaidSourcesEnabled(CAPABILITIES)).not.toThrow();
  });

  it("passes for the real config file", () => {
    const caps = loadSourceCapabilities(DEFAULT_SOURCE_CAPABILITY_PATH);
    expect(() => assertNoPaidSourcesEnabled(caps)).not.toThrow();
  });

  it("throws if a paid source is incorrectly marked allowed", () => {
    const bad: SourceCapability[] = [
      ...CAPABILITIES,
      // Construct a record that bypasses schema (not parsing it here — just testing the function)
      {
        source: "paid_villain",
        status: "active",
        source_type: "paid_serp_api",
        cost_policy: "paid_forbidden",
        confidence: "none",
        allowed: true,           // ← wrong, but testing the guard function
        paid_service_required: true
      } as unknown as SourceCapability
    ];
    expect(() => assertNoPaidSourcesEnabled(bad)).toThrow(
      "paid_villain"
    );
  });
});

describe("getSourceCapability", () => {
  it("returns the capability for a known source", () => {
    const cap = getSourceCapability("jalan", CAPABILITIES);
    expect(cap?.source).toBe("jalan");
    expect(cap?.status).toBe("active");
  });

  it("returns undefined for an unknown source", () => {
    expect(getSourceCapability("nonexistent", CAPABILITIES)).toBeUndefined();
  });
});
