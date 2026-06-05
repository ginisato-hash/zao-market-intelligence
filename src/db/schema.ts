import { readFileSync } from "node:fs";

export const initialSchemaSql = readFileSync(
  new URL("./migrations/001_initial_schema.sql", import.meta.url),
  "utf8"
);

if (process.argv[1]?.endsWith("schema.ts")) {
  console.log(initialSchemaSql);
}
