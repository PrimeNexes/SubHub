#!/bin/sh
# SubHub installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.sh | sh
# Gets the repo (or uses this checkout), installs `subhub`, and connects every AI agent installed here.
# Windows: irm https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.ps1 | iex
set -e
command -v node >/dev/null 2>&1 || { echo "SubHub needs Node.js 18 or newer: https://nodejs.org" >&2; exit 1; }
REPO=${SUBHUB_GIT:-https://github.com/PrimeNexes/SubHub.git}
here=; case $0 in */install.sh|install.sh) here=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P) ;; esac   # piped into sh: download
if [ -n "$here" ] && [ -f "$here/plugins/subhub/bin/subhub.mjs" ]; then src=$here
else
  src="$HOME/.subhub/src"
  if [ -d "$src/.git" ]; then git -C "$src" pull -q --ff-only
  elif command -v git >/dev/null 2>&1; then rm -rf "$src"; git clone -q --depth 1 "$REPO" "$src"
  else rm -rf "$src"; mkdir -p "$src"; curl -fsSL https://codeload.github.com/PrimeNexes/SubHub/tar.gz/refs/heads/main | tar -xz -C "$src" --strip-components 1; fi
  # Downloaded: agents install the plugin from GitHub, so they get updates from there.
  export SUBHUB_MARKET=${SUBHUB_MARKET:-https://github.com/PrimeNexes/SubHub}
fi
SUBHUB_REPO=$src exec node "$src/plugins/subhub/bin/subhub.mjs" install
