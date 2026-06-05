# Cloudflare Setup

Phase 5 only prepares Cloudflare configuration. Local tests and local mock collection do not require Cloudflare credentials.

## Resources

Create these resources manually when remote deployment is ready:

```bash
npx wrangler d1 create zao_market_intelligence
npx wrangler r2 bucket create zao-market-screenshots
```

Copy the D1 `database_id` returned by Cloudflare into `wrangler.toml`, replacing:

```toml
database_id = "TODO_REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID"
```

Bindings prepared in `wrangler.toml`:

- D1 binding: `ZAO_MARKET_DB`
- D1 database name: `zao_market_intelligence`
- R2 binding: `ZAO_MARKET_SCREENSHOTS`
- R2 bucket name: `zao-market-screenshots`

## Apply Migration

Local D1-compatible verification can continue to use SQLite:

```bash
npm run db:migrate
npm run cf:d1:verify:local
```

When Cloudflare login and `database_id` are configured, remote migration can be run manually:

```bash
npm run cf:d1:migrate:remote
npm run cf:d1:verify:remote
```

Remote commands may fail if `wrangler` is not installed, the user is not logged in, the account is not selected, or `database_id` still contains the TODO placeholder.

## Verify Tables

The verification SQL lives at:

```txt
src/db/cloudflare/verify_tables.sql
```

It checks that the expected D1-compatible tables exist and prints row counts for each table.

## R2 Screenshots

Future collectors will store screenshot evidence in R2 using keys like:

```txt
screenshots/YYYY/MM/DD/run_id/property_id/ota/stay_date/job_id.png
```

Phase 5 includes a local screenshot storage implementation and an R2 adapter that intentionally throws `not implemented`. Real R2 upload will be implemented later after the first real collector prototype.

## Secrets

Never commit:

- Cloudflare API tokens
- account secrets
- `.env` files
- raw screenshots with sensitive data
- production database exports

Use local `.env` files or Cloudflare-managed secrets for credentials.
