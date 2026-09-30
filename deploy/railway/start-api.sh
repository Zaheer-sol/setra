#!/bin/sh
# Railway start command for the API. Migrations already ran in the pre-deploy step.
set -e
if [ "$DEMO_SEED_ENABLED" = "true" ]; then
  node packages/database/dist/seed.js
  node packages/database/dist/seed-books.js
fi
exec node apps/api/dist/main.js
