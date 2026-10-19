#!/usr/bin/env bash
# Assembles the hosted site: the web app's static build plus the MCP server as a Vercel function
# at /mcp. Deploy the result with `vercel deploy <dir> --prod`.
#   bash script/site.sh <dir>
set -euo pipefail
OUT=${1:?usage: script/site.sh <dir>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

pnpm --dir "$ROOT" --filter @curb/web build
mkdir -p "$OUT/api"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name .vercel -exec rm -rf {} +
mkdir -p "$OUT/api"
cp -r "$ROOT/apps/web/dist/." "$OUT/"
pnpm --dir "$ROOT/apps/mcp" exec esbuild src/vercel.ts --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$OUT/api/mcp.mjs" --log-level=warning
cat > "$OUT/vercel.json" <<'EOF'
{ "rewrites": [{ "source": "/mcp", "destination": "/api/mcp" }] }
EOF
echo "site assembled in $OUT"
