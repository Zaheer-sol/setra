#!/bin/sh
# Railway start command for the web app. Railway sets PORT for the public domain.
set -e
cd apps/web
exec node ../../node_modules/next/dist/bin/next start --port "${PORT:-3000}"
