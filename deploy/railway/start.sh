#!/bin/sh
# Railway start command for every Setra service, chosen by SETRA_ROLE.
set -e
case "$SETRA_ROLE" in
  api) exec sh deploy/railway/start-api.sh ;;
  worker) exec node apps/worker/dist/main.js ;;
  web) exec sh deploy/railway/start-web.sh ;;
  *) echo "SETRA_ROLE must be api, worker or web." >&2; exit 1 ;;
esac
