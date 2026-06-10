#!/usr/bin/env bash
# Local dev server for the ee_maa_kaart static site.
#
# Port 8000 is reserved for another project, so this serves on 8090 instead.
# Override the port if you like:
#   ./serve.sh 9000        # one-off, as an argument
#   PORT=9000 ./serve.sh   # one-off, via env var
set -euo pipefail

PORT="${1:-${PORT:-8090}}"

# Always serve from the directory this script lives in.
cd "$(dirname "$0")"

echo "Serving ee_maa_kaart at http://localhost:${PORT}  (Ctrl+C to stop)"
exec python3 -m http.server "${PORT}"
