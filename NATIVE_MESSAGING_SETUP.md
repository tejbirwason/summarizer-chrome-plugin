# Native Messaging Setup Guide

## Quick Setup

1. **Copy manifests to Chrome directory:**
```bash
cp com.ytsummary.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
cp com.localai.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
```

2. **Verify scripts are executable:**
```bash
chmod +x yt-summary.py local-ai-handler.py
```

3. **Get your Chrome extension ID:**
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Find your extension ID (e.g., `ebhjcabpoikcfhoadolmbcnpepbkmmec`)

4. **Update extension IDs in manifests if needed:**
```bash
# Edit these files in: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
# Replace the extension ID in "allowed_origins" arrays
```

5. **Restart Chrome completely** (not just reload the extension)

## Troubleshooting

Check logs:
```bash
tail -f /tmp/native-host-test.txt  # yt-summary logs
tail -f /tmp/local-ai-handler.log  # AI handler logs
```

Test scripts directly:
```bash
# Test yt-summary
echo '{"video_id":"dQw4w9WgXcQ"}' | python3 -c "import json,sys,struct; msg=sys.stdin.read(); sys.stdout.buffer.write(struct.pack('I',len(msg))); sys.stdout.buffer.write(msg.encode())" | ./yt-summary.py

# Test local-ai-handler (requires .env with OPENAI_API_KEY)
echo '{"action":"health"}' | python3 -c "import json,sys,struct; msg=sys.stdin.read(); sys.stdout.buffer.write(struct.pack('I',len(msg))); sys.stdout.buffer.write(msg.encode())" | ./local-ai-handler.py
```
