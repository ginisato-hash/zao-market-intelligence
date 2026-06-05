import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sourceCapabilityFileSchema,
  type SourceCapability
} from "../config/sourceCapabilitySchema";

export const DEFAULT_SOURCE_CAPABILITY_PATH =
  "data/config/source_capabilities.free-only.json";

export function loadSourceCapabilities(
  path = DEFAULT_SOURCE_CAPABILITY_PATH
): SourceCapability[] {
  try {
    return sourceCapabilityFileSchema.parse(
      JSON.parse(readFileSync(resolve(path), "utf8"))
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Invalid source capability config at ${path}: ${error.message}`
      );
    }
    throw error;
  }
}

export function listAllowedSources(
  capabilities: SourceCapability[]
): SourceCapability[] {
  return capabilities.filter((c) => c.allowed);
}

export function listForbiddenSources(
  capabilities: SourceCapability[]
): SourceCapability[] {
  return capabilities.filter((c) => !c.allowed);
}

export function assertSourceAllowed(
  source: string,
  capabilities: SourceCapability[]
): void {
  const capability = capabilities.find((c) => c.source === source);
  if (capability === undefined) {
    throw new Error(
      `Unknown source "${source}" — not found in capability registry.`
    );
  }
  if (!capability.allowed) {
    throw new Error(
      `Source "${source}" is not allowed ` +
        `(status=${capability.status}, paid_service_required=${capability.paid_service_required}).`
    );
  }
}

export function assertNoPaidSourcesEnabled(
  capabilities: SourceCapability[]
): void {
  const violations = capabilities.filter(
    (c) => c.paid_service_required && c.allowed
  );
  if (violations.length > 0) {
    const names = violations.map((c) => c.source).join(", ");
    throw new Error(
      `Free-only policy violation: paid sources are marked allowed: ${names}`
    );
  }
}

export function getSourceCapability(
  source: string,
  capabilities: SourceCapability[]
): SourceCapability | undefined {
  return capabilities.find((c) => c.source === source);
}
