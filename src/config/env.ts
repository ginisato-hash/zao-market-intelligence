import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ZAO_POSTAL_CODE: z.string().default("990-2301"),
  ZAO_TIMEZONE: z.literal("Asia/Tokyo").default("Asia/Tokyo"),
  DATABASE_MODE: z.enum(["local", "d1"]).default("local"),
  LOCAL_DB_PATH: z.string().default(".data/zao-market-intelligence.sqlite"),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional().default(""),
  CLOUDFLARE_D1_DATABASE_ID: z.string().optional().default(""),
  CLOUDFLARE_R2_BUCKET: z.string().default("zao-market-screenshots"),
  SCREENSHOT_STORAGE: z.enum(["local", "r2"]).default("local"),
  SCREENSHOT_STORAGE_BUCKET: z.string().default("zao-market-intelligence-local"),
  LOCAL_SCREENSHOT_DIR: z.string().default(".data/screenshots"),
  // Per-scheduled-run crawl volume multiplier. Default 1 (safe baseline); the
  // always-on Mac rotating launchd job sets 3. Lenient parse + .catch(1) so an
  // invalid value never crashes a scheduled run; resolveCrawlVolumeMultiplier
  // (src/services/crawlVolumeConfig.ts) is the authority that clamps to [1, 5].
  ZMI_CRAWL_VOLUME_MULTIPLIER: z.coerce.number().int().catch(1).default(1)
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseEnv(input: NodeJS.ProcessEnv): AppEnv {
  return envSchema.parse(input);
}

export const env = parseEnv(process.env);
