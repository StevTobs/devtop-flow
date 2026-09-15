#!/usr/bin/env bash
# Builds DevTop Flow as ONE universal .dmg (Apple Silicon + Intel) — run this on
# a Mac. Same build the GitHub workflow (.github/workflows/build-macos.yml) does.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci

# Keep signing with the local "DevTop Flow Local Dev" cert when this Mac has it
# — the Keychain ties saved API keys to the app's signature, so re-signing
# differently makes macOS re-prompt for access to them. Anywhere else, fall
# back to ad-hoc signing, the minimum Apple Silicon will run.
SIGNING_ARGS=()
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "DevTop Flow Local Dev"; then
  echo "DevTop Flow Local Dev certificate not found — using ad-hoc signing."
  SIGNING_ARGS=(--config src-tauri/tauri.adhoc-signing.conf.json)
fi

# The ${arr[@]+...} form: macOS's stock bash 3.2 treats an empty array as unbound under set -u.
npm run tauri build -- --target universal-apple-darwin --bundles dmg ${SIGNING_ARGS[@]+"${SIGNING_ARGS[@]}"}

OUT="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
echo
echo "Done: $(ls "$OUT"/*.dmg)"
open "$OUT"
