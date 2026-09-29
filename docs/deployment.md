# Deployment

Setra is four deployable parts plus an optional contract:

| Part | Artifact | Scales | Notes |
|---|---|---|---|
| PostgreSQL 15+ | managed Postgres | vertically | `pg_trgm` extension; two roles (owner + `setra_app`) |
| API | `docker build --target api` → `node dist/main.js` | horizontally | stateless; put a shared rate-limit store in front when running >1 instance |
| Worker | `docker build --target worker` → `node dist/main.js` | 1–N | chain ingestion is leased per network, webhooks use `SKIP LOCKED`; extra replicas are standbys/throughput |
| Web | `docker build --target web` → `next start` | horizontally | proxies `/api/*` to `API_INTERNAL_URL` |
| SetraPaymentIntent | Foundry script | n/a | optional; direct transfers work without it |

## Production stack (any Docker host)

`deploy/compose.production.yml` runs the three images plus a one-shot migration, with health checks and
log rotation. Put a TLS-terminating proxy in front (the web on 3000; the API on 4000 for merchant servers).

```bash
docker build --target api -t setra-api:local . && docker build --target worker -t setra-worker:local . && docker build --target web -t setra-web:local .
cp deploy/production.env.example deploy/production.env          # fill in; gitignored
docker compose -f deploy/compose.production.yml --env-file deploy/production.env up -d                     # managed Postgres
docker compose -f deploy/compose.production.yml --env-file deploy/production.env --profile bundled-db up -d  # or the bundled one
```

Set `SETRA_API_IMAGE` / `SETRA_WORKER_IMAGE` / `SETRA_WEB_IMAGE` to registry tags to run pushed images.
The same three images run unchanged on container platforms (Render, Fly.io, Railway, ECS, Cloud Run):
one service per image, the migration as a release/pre-deploy command (`node dist/migrate.js` in the api
image), health check paths as below.

## Order

1. **Database.** Create the database and the application role:
   ```sql
   CREATE ROLE setra_app LOGIN PASSWORD '<strong password>';   -- NOT superuser, NOT BYPASSRLS
   ```
2. **Migrate** as the schema owner (idempotent, advisory-locked, also syncs the network registry):
   ```bash
   MIGRATION_DATABASE_URL=postgresql://owner:…@host/setra node dist/migrate.js   # from the api image
   # or from a checkout: npm run db:migrate
   ```
   Re-run after every deploy that changes migrations or network/asset configuration.
3. **API**, then **worker**, then **web**. The worker only needs the database and RPC access; the web
   only needs `API_INTERNAL_URL`.
4. (Optional) **Contract**, then set `MONAD_PAYMENT_INTENT_ADDRESS` and `…_DEPLOY_BLOCK`, re-run migrate,
   restart API and worker.

## Environment

All variables are documented in `.env.example`. Required in production:

| Variable | Used by | Notes |
|---|---|---|
| `NODE_ENV=production` | all | enables strict config checks, secure cookies, SSRF protection |
| `DATABASE_URL` | api, worker | `setra_app` role |
| `MIGRATION_DATABASE_URL` | migrate | schema owner |
| `SESSION_SECRET` | api | ≥ 32 random chars (`openssl rand -base64 48`); the API refuses to start without it |
| `ENCRYPTION_KEY` | api, worker | 32 random bytes as 64 hex chars (`openssl rand -hex 32`) or base64 (Render's generated values); encrypts webhook secrets. **Losing it invalidates all webhook secrets**. Rotate endpoints if it must change |
| `ENCRYPTION_KEY_GENERATED` | api, worker | Optional host-generated secret (Render's `generateValue`), used only when `ENCRYPTION_KEY` isn't a valid key. |
| `WEB_ORIGIN`, `PUBLIC_APP_URL` | api | exact console origin (CSRF) and base for payment links |
| `API_INTERNAL_URL` | web | where Next proxies `/api/*` |
| `MONAD_RPC_URL` (+ `MONAD_LOGS_BLOCK_RANGE`) | api, worker | use an authenticated provider; set the range to your provider's `eth_getLogs` limit |
| `MONAD_TESTNET_RPC_URL` | api, worker | test mode |
| `SMTP_URL`, `EMAIL_FROM` | api | password reset and invitations; without SMTP, production does not send (or log) links |
| `TRUST_PROXY` | api | which hops' `X-Forwarded-For` to trust (rate limits, audit IPs); default trusts private networks only |

Secrets belong in your platform's secret store, never in images or the repository.

## Persistent Render demo

Setra's demo is stored in PostgreSQL, not in the web service filesystem. Render redeploys therefore
do not remove it. To create the same **Acme Infrastructure** demo used locally, set these
environment variables on `setra-api` (`render.yaml` already does) and deploy once:

```text
DEMO_SEED_ENABLED=true
DEMO_OWNER_EMAIL=owner@acme.test
```

The demo account then uses the same sign-in as local development (see the README). Anyone who knows
it can open the demo workspace, which holds only simulated test-mode data. To use a different
password, set `DEMO_OWNER_PASSWORD` (at least 14 characters) before the first seed.

The API start command runs both demo seeders. They are idempotent: once the demo user, workspace and
books exist, later deploys leave them unchanged. The public demo is test mode and all seeded chain
activity is explicitly labelled simulated. Production deploy logs never print its password, API key
or webhook secret.

**Do not rely on a free Render Postgres database for a durable demo.** Free databases expire after
30 days and have no managed backups. Upgrade `setra-db` in the Render dashboard to at least the
`0.1c-256mb` paid Postgres plan. The API and web services may remain on their free plans if sleeping
and cold starts are acceptable.

Before deliberately deleting the demo, first set `DEMO_SEED_ENABLED=false` and redeploy. Otherwise a
later API restart will recreate it. This opt-in flag is deliberately separate from `NODE_ENV`.

## Monad execution events (optional)

Faster detection needs a Monad full node on the same host as the sidecar
(`services/execution-events`, see its README for build and a systemd unit). Set a random
`EXEC_EVENTS_INGEST_TOKEN` (≥ 32 characters) on the API and the same value as
`SETRA_EXEC_EVENTS_TOKEN` for the sidecar, and point it at the API with `--chain-id 143` (or 10143).
Without it Setra runs on RPC alone, with identical correctness. Stream status appears in
`/v1/health` (`checks.execution_events`, `warnings`).

## Webhook egress

Workers make outbound HTTPS requests to merchant endpoints. Allow egress on 443. In production
private/loopback destinations are refused (`WEBHOOK_ALLOW_PRIVATE_URLS` defaults to false).

## Smart contract

```bash
cd contracts
forge build && forge test
# Use a hardware wallet or an encrypted keystore, never a plaintext key in an env var.
forge script script/DeployPaymentIntent.s.sol --rpc-url https://testnet-rpc.monad.xyz --account <keystore> --broadcast
cd .. && npm run contracts:record -- --network monad-testnet     # writes contracts/deployments/monad-testnet.json
```

Then set the printed `MONAD_TESTNET_PAYMENT_INTENT_ADDRESS` / `…_DEPLOY_BLOCK`. Repeat with
`https://rpc.monad.xyz` and `--network monad` for mainnet. Optionally verify the source on the explorer.
The contract has no constructor arguments, owner or upgrade path, so redeploying means configuring a new
address; existing intents stay payable on the old contract until they expire.

## Rollback

- API/worker/web are stateless: roll back the image.
- Migrations are forward-only. Write new migrations additively (new columns nullable/defaulted) so the
  previous release keeps working against the new schema; never drop columns in the same release that
  stops using them.
- Never delete rows from append-only tables to "undo" something. Use the product's compensating
  operations (resolutions, reversals).
- Ingestion cursors can be moved back safely (rescans are idempotent) but should never be moved forward
  past unprocessed blocks.

## Health and monitoring

| Endpoint | Use | Returns |
|---|---|---|
| `GET /v1/health/live` | liveness probe | 200 while the process is up |
| `GET /v1/health/ready` | readiness probe / load balancer | 200 when the database answers, else 503 |
| `GET /v1/health` | dashboards | `status` (`ok` / `degraded`), `problems[]`, and `checks`: database; per network `settled_block`, `head_block`, `seconds_since_progress`, `last_error`, status (`ok`, `delayed` after 30 s, `error`, `not_started`); webhooks `due`, `oldest_due_seconds` (`stalled` above 120 s), `failed_last_hour`, `delivered_last_hour` |
| `GET /v1/health?strict=true` | uptime monitors | same body, but **503 when degraded**, so any HTTP monitor alerts on ingestion or webhook trouble |

Point an uptime monitor (UptimeRobot, Better Stack, a cloud health check) at
`https://<api>/v1/health?strict=true`, or run the bundled monitor from cron:

```bash
SETRA_HEALTH_URL=https://api.example.com/v1/health ALERT_WEBHOOK_URL=https://hooks.slack.com/... node scripts/health-monitor.mjs --watch 60
```

It exits 0/1/2 (ok/degraded/unreachable) and posts a Slack-compatible message on every state change.
