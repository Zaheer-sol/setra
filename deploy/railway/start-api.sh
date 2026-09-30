#!/bin/sh
# Start the API: migrations first (safe to repeat, one migrator at a time), then the demo seed if
# enabled, then the server.
set -e
node packages/database/dist/migrate.js
if [ "$DEMO_SEED_ENABLED" = "true" ]; then
  node packages/database/dist/seed.js
  node packages/database/dist/seed-books.js
fi
exec node apps/api/dist/main.js
