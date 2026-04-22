# Native Messaging Setup

## Quick setup

1. Load the extension in Chrome:
   - Open `chrome://extensions/`
   - Enable **Developer mode**
   - Click **Load unpacked**, select this repo directory
   - Copy the extension ID from the extension card (looks like `fbmgekimgmgiiffchlkfknehmgmiphaf`)

2. Run the install script with that ID:
   ```bash
   scripts/install.sh <EXTENSION_ID>
   ```
   This installs Python deps, marks the hosts executable, renders the two manifests with your repo path + extension ID, and drops them into Chrome's `NativeMessagingHosts` directory.

3. **Fully quit Chrome (cmd+Q)** and relaunch. Extension reload is not enough — Chrome only reads native-messaging manifests at process start.

## Repeat the install

Re-run `scripts/install.sh <EXTENSION_ID>` whenever:
- You move the repo directory
- The extension ID changes (e.g. after reinstalling unpacked)
- You update `requirements.txt` or one of the Python hosts

## Troubleshooting

Logs are written to:
```bash
tail -f /tmp/local-ai-handler.log   # summarization + "open in Claude Code"
tail -f /tmp/native-host-test.txt   # YouTube transcript fetching
```

**"Native host has exited" with no logs:** the Python script crashed before opening its log file. Almost always a missing import. Run the host manually to see the real error:
```bash
./yt-summary.py < /dev/null
./local-ai-handler.py < /dev/null
```
If an import fails, add the missing module to `requirements.txt` and re-run `scripts/install.sh`.

**`command not found: claude` in the Ghostty window:** Ghostty launches its shell via `/usr/bin/login` with a stripped PATH that doesn't source `.zshrc`. `local-ai-handler.py` already invokes Claude via absolute path (`$HOME/.local/bin/claude`). If your binary lives elsewhere, update `handle_open_in_cc()` in `local-ai-handler.py`.

**Multiple Ghostty processes pile up:** intentional — `open -na` forces a fresh process each call. If you'd rather reuse the existing Ghostty instance, drop the `-n` flag in `local-ai-handler.py`'s `subprocess.Popen` call.

**Script runs as the wrong Python:** the shebangs use `#!/usr/bin/env python3`, which picks whatever `python3` is on the login PATH. If you need a specific interpreter (e.g. a venv), edit the shebang on both scripts.

## Test a host manually

The native-messaging protocol is: 4-byte little-endian length prefix, then JSON.

```bash
# Test yt-summary
echo '{"video_id":"dQw4w9WgXcQ"}' | python3 -c \
  "import json,sys,struct; m=sys.stdin.read(); sys.stdout.buffer.write(struct.pack('I',len(m))); sys.stdout.buffer.write(m.encode())" \
  | ./yt-summary.py

# Test local-ai-handler (requires .env with API keys)
echo '{"action":"health"}' | python3 -c \
  "import json,sys,struct; m=sys.stdin.read(); sys.stdout.buffer.write(struct.pack('I',len(m))); sys.stdout.buffer.write(m.encode())" \
  | ./local-ai-handler.py
```
