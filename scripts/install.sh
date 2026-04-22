#!/usr/bin/env bash
# One-shot setup for the Summarizer Chrome extension's native messaging hosts.
#
# Usage: scripts/install.sh <CHROME_EXTENSION_ID>
#
# What it does:
#   1. Installs Python deps from requirements.txt
#   2. Makes the two Python native hosts executable
#   3. Renders com.localai.json / com.ytsummary.json with your repo path
#      and extension ID, and drops them into Chrome's NativeMessagingHosts dir
#   4. Reminds you to fully quit + relaunch Chrome

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
echo "==> Making Python hosts executable"
chmod +x "$REPO_PATH/local-ai-handler.py" "$REPO_PATH/yt-summary.py"

echo ""
echo "==> Rendering manifests with your repo path and extension ID"
mkdir -p "$NMH_DIR"
for tpl in com.localai.json com.ytsummary.json; do
  sed \
    -e "s|__REPO_PATH__|$REPO_PATH|g" \
    -e "s|__EXTENSION_ID__|$EXT_ID|g" \
    "$REPO_PATH/$tpl" > "$NMH_DIR/$tpl"
  echo "  wrote $NMH_DIR/$tpl"
done

echo ""
echo "==> Done."
echo ""
echo "Next:"
echo "  1. Fully quit Chrome (cmd+Q), not just close the window."
echo "  2. Relaunch Chrome and try the extension."
echo "  3. If something breaks, tail the logs:"
echo "       tail -f /tmp/local-ai-handler.log /tmp/native-host-test.txt"
