#!/bin/sh
# Fetches the official Monad execution events SDK (Category Labs) at the pinned release tag.
# A shallow clone of one tag; the crate uses it through path dependencies (see Cargo.toml).
set -eu
TAG="${MONAD_SDK_TAG:-release/exec-events-sdk-v1.1}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/monad"
if [ -d "$DIR/.git" ] && [ "$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || true)" = "$TAG" ]; then
  echo "SDK already at $TAG ($DIR)"; exit 0
fi
rm -rf "$DIR"
git clone --depth 1 --branch "$TAG" https://github.com/category-labs/monad "$DIR"
echo "SDK $TAG fetched to $DIR"
