#!/usr/bin/env bash
# Assembles the hosted site: the web app's static build, reading the chain through /rpc, plus the
# MCP server at /mcp; both are Vercel functions. Deploy the result with `vercel deploy <dir> --prod`.
#   bash script/site.sh <dir>
set -euo pipefail
OUT=${1:?usage: script/site.sh <dir>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# The directory is emptied before assembly, so only one this script made (or an empty one) is used.
if [ -d "$OUT" ] && [ ! -f "$OUT/.curb-site" ] && [ -n "$(ls -A "$OUT" | grep -v '^\.vercel$')" ]; then
  echo "refusing: $OUT is not empty and was not assembled by this script" >&2
  exit 1
fi

VITE_RPC=rpc pnpm --dir "$ROOT" --filter @curb/web build
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
mkdir -p "$OUT/api"
touch "$OUT/.curb-site"
cp -r "$ROOT/apps/web/dist/." "$OUT/"
pnpm --dir "$ROOT/apps/mcp" exec esbuild src/vercel.ts --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$OUT/api/mcp.mjs" --log-level=warning
cp "$ROOT/script/rpc-proxy.mjs" "$OUT/api/rpc.mjs"
cat > "$OUT/vercel.json" <<'EOF'
{ "rewrites": [{ "source": "/mcp", "destination": "/api/mcp" }, { "source": "/rpc", "destination": "/api/rpc" }] }
EOF
echo "site assembled in $OUT"
