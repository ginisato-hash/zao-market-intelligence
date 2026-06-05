export const ZAO_POSTAL_CODE = "990-2301";
export const ZAO_TIMEZONE = "Asia/Tokyo";

export const CONFIDENCE_LEVELS = ["A", "B", "C"] as const;
export const AVAILABILITY_STATUSES = [
  "available",
  "sold_out",
  "not_listed",
  "not_found",
  "failed"
] as const;

export const CONFIDENCE_DESCRIPTIONS = {
  A: "API, official, or structured source",
  B: "OTA public page verified with Playwright screenshot",
  C: "Unavailable, blocked, JS failure, or date condition not confirmed"
} as const;
