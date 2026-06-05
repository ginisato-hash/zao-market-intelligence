import { randomUUID } from "node:crypto";

export function createRunId(): string {
  return `run_${randomUUID()}`;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
