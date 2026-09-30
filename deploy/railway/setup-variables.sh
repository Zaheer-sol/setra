#!/usr/bin/env bash
# Set every Railway variable Setra needs, for the services "api", "worker" and "web" and the
# database service "Postgres" (see deploy/railway/README.md).
#
#   railway login && railway link      # once, choose your Setra project
#   bash deploy/railway/setup-variables.sh
#
# Secrets are generated here with openssl and sent straight to Railway; they are never printed.
# Running it again keeps secrets that already exist (a new ENCRYPTION_KEY would make stored webhook
# secrets unreadable). If contracts/deployments/monad-testnet.json exists, the contract addresses are
# set too.
set -euo pipefail

command -v railway >/dev/null || { echo "Install the Railway CLI first: npm install -g @railway/cli"; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required."; exit 1; }
railway whoami >/dev/null 2>&1 || { echo "Sign in first: railway login"; exit 1; }

existing() { railway variable list --service api --kv 2>/dev/null | grep -E "^$1=" | head -1 | cut -d= -f2- || true; }
keep_or_new() { local v; v="$(existing "$1")"; if [ -n "$v" ]; then printf '%s' "$v"; else eval "$2"; fi; }

SESSION_SECRET="$(keep_or_new SESSION_SECRET 'openssl rand -base64 48 | tr -d "\n"')"
ENCRYPTION_KEY="$(keep_or_new ENCRYPTION_KEY 'openssl rand -hex 32')"
APP_DB_PASSWORD="$(keep_or_new APP_DB_PASSWORD 'openssl rand -hex 24')"

# Railway references: resolved by Railway, so services find each other and the database automatically.
APP_DB='postgresql://setra_app:${{api.APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}'
WEB_URL='https://${{web.RAILWAY_PUBLIC_DOMAIN}}'
CHAIN=(
  "MONAD_ENABLED=false"
  "MONAD_TESTNET_ENABLED=true"
  "MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz"
  "MONAD_TESTNET_LOGS_BLOCK_RANGE=100"
)
DEPLOYMENT="contracts/deployments/monad-testnet.json"
if [ -f "$DEPLOYMENT" ]; then
  read -r PI_ADDRESS PI_BLOCK BA_ADDRESS < <(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).contracts ?? {};
    console.log([d.SetraPaymentIntent?.address ?? "", d.SetraPaymentIntent?.deploymentBlock ?? "", d.SetraBooksAttestation?.address ?? ""].join(" "));
  ' "$DEPLOYMENT")
  [ -n "${PI_ADDRESS:-}" ] && CHAIN+=("MONAD_TESTNET_PAYMENT_INTENT_ADDRESS=$PI_ADDRESS" "MONAD_TESTNET_PAYMENT_INTENT_DEPLOY_BLOCK=$PI_BLOCK")
  [ -n "${BA_ADDRESS:-}" ] && CHAIN+=("MONAD_TESTNET_BOOKS_ATTESTATION_ADDRESS=$BA_ADDRESS")
  echo "Using contract addresses from $DEPLOYMENT."
fi

set_vars() {
  local service="$1"; shift
  railway variable set --service "$service" --skip-deploys "$@" >/dev/null
  echo "Set $# variables on $service."
}

# Secrets go through stdin, so they never appear on a command line or in the process list.
set_secret() { printf '%s' "$3" | railway variable set --service "$1" --skip-deploys --stdin "$2" >/dev/null; }

set_secret api SESSION_SECRET "$SESSION_SECRET"
set_secret api ENCRYPTION_KEY "$ENCRYPTION_KEY"
set_secret api APP_DB_PASSWORD "$APP_DB_PASSWORD"
echo "Set 3 secrets on api (kept any that already existed)."

set_vars api \
  "NODE_ENV=production" \
  "PORT=4000" \
  "API_PORT=4000" \
  "API_HOST=::" \
  'MIGRATION_DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  'DATABASE_URL=postgresql://setra_app:${{APP_DB_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}' \
  "WEB_ORIGIN=$WEB_URL" \
  "PUBLIC_APP_URL=$WEB_URL" \
  "DEMO_SEED_ENABLED=true" \
  "DEMO_OWNER_EMAIL=owner@acme.test" \
  "${CHAIN[@]}"

set_vars worker \
  "NODE_ENV=production" \
  "DATABASE_URL=$APP_DB" \
  'SESSION_SECRET=${{api.SESSION_SECRET}}' \
  'ENCRYPTION_KEY=${{api.ENCRYPTION_KEY}}' \
  "WEB_ORIGIN=$WEB_URL" \
  "PUBLIC_APP_URL=$WEB_URL" \
  "${CHAIN[@]}"

set_vars web \
  "NODE_ENV=production" \
  'API_INTERNAL_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4000'

echo "Done. Deploy the three services from the Railway dashboard (or push to GitHub)."
