#!/bin/sh
# SubHub installer: curl -fsSL https://raw.githubusercontent.com/PrimeNexes/SubHub/main/install.sh | sh
# Gets the repo (or uses this checkout), installs `subhub`, and connects every AI agent installed here.
set -e
REPO=${SUBHUB_GIT:-https://github.com/PrimeNexes/SubHub.git}
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd -P || true)
if [ -n "$here" ] && [ -x "$here/plugins/subhub/bin/subhub" ]; then src=$here
else
  src="$HOME/.subhub/src"
  if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only -q; else git clone -q --depth 1 "$REPO" "$src"; fi
fi
SUBHUB_REPO=$src exec sh "$src/plugins/subhub/bin/subhub" install
