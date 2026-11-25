#!/usr/bin/env bash
# Optional setup for the Summarizer Chrome extension's YouTube transcript native host.
# Without it, the extension falls back to scraping YouTube's in-page transcript panel.
#
# Usage: scripts/install.sh <CHROME_EXTENSION_ID>
#
# What it does:
#   1. Installs Python deps for yt-summary.py from requirements.txt
#   2. Makes yt-summary.py executable
#   3. Renders com.ytsummary.json with your repo path and extension ID,
#      and writes it into Chrome's NativeMessagingHosts dir

set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  echo "Usage: $0 <CHROME_EXTENSION_ID>"
  echo ""
  echo "Get the extension ID from chrome://extensions/ after loading the unpacked"
  echo "extension. It looks like: fbmgekimgmgiiffchlkfknehmgmiphaf"
  exit 1
fi

REPO_PATH="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"

case "$OS" in
  Darwin) NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  Linux)  NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

echo "Repo path:     $REPO_PATH"
echo "Extension ID:  $EXT_ID"
echo "Target dir:    $NMH_DIR"
echo ""

echo "==> Installing Python dependencies"
pip3 install -r "$REPO_PATH/requirements.txt"

echo ""
echo "==> Making yt-summary.py executable"
chmod +x "$REPO_PATH/yt-summary.py"

echo ""
echo "==> Rendering com.ytsummary.json with your repo path and extension ID"
mkdir -p "$NMH_DIR"
sed \
  -e "s|__REPO_PATH__|$REPO_PATH|g" \
  -e "s|__EXTENSION_ID__|$EXT_ID|g" \
  "$REPO_PATH/com.ytsummary.json" > "$NMH_DIR/com.ytsummary.json"
echo "  wrote $NMH_DIR/com.ytsummary.json"

echo ""
echo "==> Done."
echo ""
echo "Next:"
echo "  1. Fully quit Chrome (cmd+Q), not just close the window."
echo "  2. Relaunch Chrome and try summarizing a YouTube video."
echo "  3. Logs: tail -f /tmp/native-host-test.txt"
