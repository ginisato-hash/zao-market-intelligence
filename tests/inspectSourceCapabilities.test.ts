import { describe, it, expect } from "vitest";
import { loadSourceCapabilities } from "../src/services/sourceCapabilityRegistry";

describe("inspectSourceCapabilities (data assertions)", () => {
  it("loads the config and finds at least one active source", () => {
    const caps = loadSourceCapabilities();
    const active = caps.filter((c) => c.status === "active");
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active[0]?.source).toBe("jalan");
  });

  it("finds at least one parked source", () => {
    const caps = loadSourceCapabilities();
    expect(caps.some((c) => c.status === "parked")).toBe(true);
  });

  it("finds at least one forbidden source", () => {
    const caps = loadSourceCapabilities();
    expect(caps.some((c) => c.status === "forbidden")).toBe(true);
  });

  it("finds at least one feasibility_only source", () => {
    const caps = loadSourceCapabilities();
    expect(caps.some((c) => c.status === "feasibility_only")).toBe(true);
  });

  it("all forbidden sources have allowed=false", () => {
    const caps = loadSourceCapabilities();
    const forbidden = caps.filter((c) => c.status === "forbidden");
    expect(forbidden.every((c) => !c.allowed)).toBe(true);
  });

  it("all paid_service_required sources have allowed=false", () => {
    const caps = loadSourceCapabilities();
    const paid = caps.filter((c) => c.paid_service_required);
    expect(paid.every((c) => !c.allowed)).toBe(true);
  });

  it("serpapi is present and forbidden", () => {
    const caps = loadSourceCapabilities();
    const serpapi = caps.find((c) => c.source === "serpapi");
    expect(serpapi).toBeDefined();
    expect(serpapi?.status).toBe("forbidden");
    expect(serpapi?.allowed).toBe(false);
  });

  it("jalan is present and active and allowed", () => {
    const caps = loadSourceCapabilities();
    const jalan = caps.find((c) => c.source === "jalan");
    expect(jalan).toBeDefined();
    expect(jalan?.status).toBe("active");
    expect(jalan?.allowed).toBe(true);
    expect(jalan?.paid_service_required).toBe(false);
  });
});
