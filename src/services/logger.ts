type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function currentLevel(): LogLevel {
  const value = process.env.LOG_LEVEL;
  return value === "debug" || value === "warn" || value === "error" ? value : "info";
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    write("debug", message, meta);
  },
  info(message: string, meta?: unknown): void {
    write("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    write("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    write("error", message, meta);
  }
};

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) {
    return;
  }

  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  console.log(`[${level}] ${message}${suffix}`);
}
