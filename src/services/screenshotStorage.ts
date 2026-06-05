import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PutScreenshotObjectInput {
  key: string;
  contentType: string;
  body: Buffer | Uint8Array | string;
}

export interface PutScreenshotObjectResult {
  path: string;
  storageType: "local" | "r2";
}

export interface ScreenshotStorage {
  putObject(input: PutScreenshotObjectInput): Promise<PutScreenshotObjectResult>;
}

export class LocalScreenshotStorage implements ScreenshotStorage {
  constructor(private readonly rootDir = ".data/screenshots") {}

  async putObject(input: PutScreenshotObjectInput): Promise<PutScreenshotObjectResult> {
    const path = join(this.rootDir, input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    return { path, storageType: "local" };
  }
}

export class NotImplementedR2ScreenshotStorage implements ScreenshotStorage {
  async putObject(_input: PutScreenshotObjectInput): Promise<PutScreenshotObjectResult> {
    throw new Error("R2 remote screenshot upload is not implemented in Phase 5.");
  }
}
