export interface ScreenshotKeyInput {
  capturedAt: Date;
  runId: string;
  propertyId: string;
  ota: string;
  stayDate: string;
  jobId: string;
}

export function createScreenshotKey(input: ScreenshotKeyInput): string {
  const year = input.capturedAt.getUTCFullYear();
  const month = String(input.capturedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.capturedAt.getUTCDate()).padStart(2, "0");

  return [
    "screenshots",
    String(year),
    month,
    day,
    sanitize(input.runId),
    sanitize(input.propertyId),
    sanitize(input.ota),
    sanitize(input.stayDate),
    `${sanitize(input.jobId)}.png`
  ].join("/");
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
