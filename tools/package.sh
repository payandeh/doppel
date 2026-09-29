#!/usr/bin/env bash
# Builds dist/doppel-<version>.zip for the Chrome Web Store (extension files only).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
out="dist/doppel-$version.zip"
rm -f "$out"
zip -rq "$out" manifest.json *.html *.js *.css content lib icons -x "*.DS_Store"
echo "Built $out"
