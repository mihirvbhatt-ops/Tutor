#!/usr/bin/env bash
# AI Tutor installer & updater (roadmap #4).
#
# Fresh install:
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/install.sh | bash
#
# Re-running against an existing install pulls the latest release and
# reinstalls dependencies instead of cloning again — the same script doubles
# as the update mechanism, so there's nothing separate to remember.
#
# Override the target directory with INSTALL_DIR=/some/path.

set -euo pipefail

REPO_URL="https://github.com/OWNER/REPO.git"
INSTALL_DIR="${INSTALL_DIR:-$HOME/ai-tutor}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required but not found. Install git and re-run this script."
command -v node >/dev/null 2>&1 || fail "Node.js is required but not found. Install Node 20+ from https://nodejs.org and re-run this script."
command -v npm >/dev/null 2>&1 || fail "npm is required but not found (usually ships with Node)."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node 20+ is required (found $(node -v)). Install a newer Node and re-run this script."
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Existing install found at $INSTALL_DIR — updating."
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "Installing to $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

log "Installing dependencies"
npm install --prefix "$INSTALL_DIR"

log "Done."
echo
echo "  cd \"$INSTALL_DIR\" && npm start"
echo
echo "Then open http://localhost:3001 and add your Anthropic API key under Settings."
echo "Re-run this script any time to update to the latest release."
