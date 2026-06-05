import { closeDatabase, executeMigration, openLocalDatabase } from "./client";

const db = openLocalDatabase();

try {
  executeMigration(db);
  console.log("Applied local SQLite migration to .data/zao-market-intelligence.sqlite");
} finally {
  closeDatabase(db);
}
