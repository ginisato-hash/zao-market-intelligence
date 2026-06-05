import { describe, it, expect } from "vitest";
import {
  sourceCapabilitySchema,
  sourceCapabilityFileSchema
} from "../src/config/sourceCapabilitySchema";

// Use plain object literals — spread-compatible, parsed by Zod at runtime.
const VALID_JALAN = {
  source: "jalan",
  status: "active",
  source_type: "direct_ota",
  cost_policy: "free_direct_only",
  confidence: "A",
  allowed: true,
  paid_service_required: false,
  notes: "Primary source."
};

const VALID_SERPAPI = {
  source: "serpapi",
  status: "forbidden",
  source_type: "paid_serp_api",
  cost_policy: "paid_forbidden",
  confidence: "none",
  allowed: false,
  paid_service_required: true,
  notes: "Forbidden."
};

describe("sourceCapabilitySchema", () => {
  it("accepts a valid active free source", () => {
    expect(() => sourceCapabilitySchema.parse(VALID_JALAN)).not.toThrow();
  });

  it("accepts a valid forbidden paid source", () => {
    expect(() => sourceCapabilitySchema.parse(VALID_SERPAPI)).not.toThrow();
  });

  it("rejects paid_service_required=true with allowed=true", () => {
    const bad = { ...VALID_SERPAPI, allowed: true };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow(
      "paid_service_required=true requires allowed=false"
    );
  });

  it("rejects status=forbidden with allowed=true", () => {
    const bad = { ...VALID_SERPAPI, allowed: true };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow();
  });

  it("accepts status=forbidden with allowed=false", () => {
    expect(() => sourceCapabilitySchema.parse(VALID_SERPAPI)).not.toThrow();
  });

  it("rejects empty source string", () => {
    const bad = { ...VALID_JALAN, source: "" };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow();
  });

  it("rejects unknown status", () => {
    const bad = { ...VALID_JALAN, status: "unknown_status" };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow();
  });

  it("rejects unknown source_type", () => {
    const bad = { ...VALID_JALAN, source_type: "magical_cloud" };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow();
  });

  it("rejects unknown confidence value", () => {
    const bad = { ...VALID_JALAN, confidence: "Z" };
    expect(() => sourceCapabilitySchema.parse(bad)).toThrow();
  });
});

describe("sourceCapabilityFileSchema", () => {
  it("accepts a valid array of capabilities", () => {
    expect(() =>
      sourceCapabilityFileSchema.parse([VALID_JALAN, VALID_SERPAPI])
    ).not.toThrow();
  });

  it("rejects an empty array", () => {
    expect(() => sourceCapabilityFileSchema.parse([])).toThrow();
  });

  it("rejects if any element is invalid", () => {
    const bad = { ...VALID_SERPAPI, allowed: true };
    expect(() =>
      sourceCapabilityFileSchema.parse([VALID_JALAN, bad])
    ).toThrow();
  });
});
