#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["litellm", "python-dotenv"]
# ///
"""
Local AI Handler for Chrome Extension - LiteLLM Version
Stateless handler - receives full messages[] with each request
Supports multiple models via LiteLLM abstraction
"""
import datetime
import json
import os
import re
import shlex
import struct
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from litellm import completion

# Load environment variables
load_dotenv()

# Native-host PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin), so call CLIs by absolute path.
SC_BIN = os.path.expanduser("~/.superconductor/bin/sc")      # Superconductor CLI
CLAUDE_BIN = os.path.expanduser("~/.local/bin/claude")        # Claude Code CLI (Ghostty fallback)
# Transcripts are archived here; this folder is added to Superconductor as a project.
TRANSCRIPTS_DIR = Path.home() / "yt-transcripts"

# ai-config.json sits next to this script. Its "openInClaudeCode" block configures the
# transcript prompt, system prompt, model, and reasoning for the "Open in Claude Code" path.
# Edit that file to change them — no code change or native-host restart required.
CONFIG_PATH = Path(__file__).resolve().parent / "ai-config.json"
OPEN_IN_CC_DEFAULTS = {
    "model": "claude-opus-4-8",
    "reasoning": "max",
    "systemPrompt": "You are a transcript summarizer",
    "prompt": "Read the transcript at {ref}, summarize it and extract the key insights.",
}

def log_message(message):
    """Log messages to file for debugging"""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open("/tmp/local-ai-handler.log", "a") as f:
        f.write(f"[{timestamp}] {message}\n")

def read_message():
    """Read native messaging input"""
    length_bytes = sys.stdin.buffer.read(4)
    if not length_bytes:
        return None
    length = struct.unpack("I", length_bytes)[0]
    message = sys.stdin.buffer.read(length)
    return json.loads(message.decode('utf-8'))

def send_message(msg):
    """Send native messaging output"""
    encoded = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack("I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def handle_request(data):
    """Handle summarize or followup request (stateless)"""
    model_id = data['modelId']
    model_config = data['modelConfig']
    messages = data['messages']  # Full conversation history from extension

    log_message(f"Request for model {model_id}: {model_config['litellm_model']}, messages count: {len(messages)}")

    # Build completion params
    params = {
        "model": model_config['litellm_model'],
        "messages": messages,
        "stream": True,
        "max_tokens": model_config.get('max_tokens', 4096)
    }

    # Add reasoning for OpenAI models that support it
    if 'reasoning' in model_config and 'openai' in model_config['litellm_model']:
        params['reasoning_effort'] = model_config['reasoning']

    # Add extended thinking for Anthropic models
    if 'thinking' in model_config and 'anthropic' in model_config['litellm_model']:
        params['thinking'] = model_config['thinking']

    thinking_info = f", thinking={params.get('thinking')}" if 'thinking' in params else ""
    log_message(f"LiteLLM params: model={params['model']}, max_tokens={params['max_tokens']}{thinking_info}")

    start_time = time.time()
    full_response = ""

    try:
        response = completion(**params)

        for chunk in response:
            # Handle different chunk formats from various providers
            if hasattr(chunk, 'choices') and chunk.choices:
                delta = chunk.choices[0].delta
                if hasattr(delta, 'content') and delta.content:
                    content = delta.content
                    full_response += content
                    # Send only the delta, not full response (O(n) not O(n²))
                    send_message({
                        "type": "delta",
                        "modelId": model_id,
                        "delta": content
                    })

        duration_ms = int((time.time() - start_time) * 1000)
        log_message(f"Complete: {model_id} in {duration_ms}ms, response length: {len(full_response)}")

        send_message({
            "type": "complete",
            "modelId": model_id,
            "duration_ms": duration_ms,
            "response": full_response
        })

    except Exception as e:
        error_msg = str(e)
        log_message(f"Error for {model_id}: {error_msg}")
        send_message({
            "type": "error",
            "modelId": model_id,
            "error": error_msg
        })

def slugify(s, max_len=40):
    """Lowercase, ASCII-only, hyphenated slug suitable for a filename."""
    s = re.sub(r'[^\w\s-]', '', s, flags=re.ASCII).strip().lower()
    s = re.sub(r'[-\s]+', '-', s)
    return s[:max_len].rstrip('-')


def yaml_str(s):
    """Quote a value for safe YAML frontmatter (handles colons and quotes)."""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def open_in_cc_config():
    """Read the 'openInClaudeCode' block from ai-config.json fresh on each call, so edits to
    the file take effect on the next click without restarting the native host. Missing keys
    (or an unreadable/invalid file) fall back to OPEN_IN_CC_DEFAULTS."""
    cfg = dict(OPEN_IN_CC_DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text()).get("openInClaudeCode", {}))
    except (OSError, json.JSONDecodeError) as e:
        log_message(f"Could not load openInClaudeCode config ({e}); using defaults")
    return cfg


def summarize_prompt(template, ref):
    """Fill the configured transcript-summarization instruction with the transcript path.
    Uses .replace (not .format) so other braces in a user-edited prompt are left alone."""
    return template.replace("{ref}", ref)

def handle_open_in_cc(data):
    """Archive the transcript to TRANSCRIPTS_DIR (named by video title) and open a fresh
    terminal-backed Claude Code tab on it in the dedicated yt-transcripts Superconductor
    workspace (kept open on main), without stealing focus from the workspace you're in. Falls
    back to an in-app chat, then to the Claude CLI in a Ghostty window if SC is unavailable."""
    text = data.get('text', '')
    title = data.get('title', '')
    video_id = data.get('video_id', '')
    channel = data.get('channel', '')
    url = data.get('url', '') or f"https://youtube.com/watch?v={video_id}"

    # Filename: <epoch>-<title-slug>-<videoId>.md — epoch prefix sorts chronologically
    # (lexically too: the 10-digit width is stable until year 2286). Human date stays in frontmatter.
    date = datetime.date.today().isoformat()
    ts = int(time.time())
    base = slugify(title) if title else 'untitled'
    fname = f"{ts}-{base}{('-' + video_id) if video_id else ''}.md"

    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    filepath = TRANSCRIPTS_DIR / fname
    filepath.write_text(
        f"---\ntitle: {yaml_str(title)}\nchannel: {yaml_str(channel)}\nurl: {url}\nfetched: {date}\n---\n\n{text}"
    )
    log_message(f"Wrote {len(text)} chars to {filepath}")

    cfg = open_in_cc_config()
    model, reasoning, system_prompt = cfg["model"], cfg["reasoning"], cfg["systemPrompt"]
    prompt_rel = summarize_prompt(cfg["prompt"], fname)            # relative — only the --worktree-bound chat fallback uses this
    prompt_abs = summarize_prompt(cfg["prompt"], str(filepath))    # absolute — robust regardless of the tab's working dir

    sc_ok = Path(SC_BIN).exists() and subprocess.run([SC_BIN, 'status'], capture_output=True).returncode == 0

    # Primary: a fresh terminal-backed Claude Code tab per transcript, in the dedicated
    # yt-transcripts workspace (must be open in SC). --active keep so it lands there without
    # pulling focus off whatever workspace you're currently in.
    if sc_ok:
        run = subprocess.run(
            [SC_BIN, 'layout', 'run', 'tabs', '--provider', 'claude', '--ui', 'terminal',
             '--model', model, '--reasoning', reasoning,
             '--worktree', str(TRANSCRIPTS_DIR), '--active', 'keep',
             '--label', (title or base)[:40], '--prompt', prompt_abs, '--output', 'json'],
            capture_output=True, text=True,
        )
        sid = None
        if run.returncode == 0:
            try:
                resp = json.loads(run.stdout)
                if resp.get('kind') == 'layout_orchestration':
                    sid = resp['response']['sessions'][0].get('session_id')
            except (json.JSONDecodeError, KeyError, IndexError):
                sid = None
        if sid:
            log_message(f"Opened terminal CC tab {sid} for {fname}")
            send_message({"type": "complete", "action": "openInCC", "filepath": str(filepath)})
            return
        log_message(f"sc layout run blocked (rc={run.returncode}): {run.stdout.strip() or run.stderr.strip()} — falling back to chat")

        # Fallback 1: in-app Opus 4.8 chat bound to the transcripts project (no orchestration flag / open workspace needed).
        new = subprocess.run(
            [SC_BIN, 'chat', 'new', '--provider', 'claude', '--model', model,
             '--reasoning', reasoning, '--activate', '--worktree', str(TRANSCRIPTS_DIR)],
            capture_output=True, text=True,
        )
        csid = new.stdout.strip()
        if new.returncode == 0 and csid:
            send = subprocess.run(
                [SC_BIN, 'chat', 'send', csid, prompt_rel],
                capture_output=True, text=True,
            )
            if send.returncode == 0:
                log_message(f"Opened Opus 4.8 chat {csid} on {fname}")
                send_message({"type": "complete", "action": "openInCC", "filepath": str(filepath)})
                return
            log_message(f"sc chat send failed (rc={send.returncode}): {send.stderr.strip()} — falling back to Ghostty")
        else:
            log_message(f"sc chat new failed (rc={new.returncode}): {new.stderr.strip()} — falling back to Ghostty")
    else:
        log_message("Superconductor unavailable (sc status failed) — falling back to Ghostty")

    # Fallback 2: launch the Claude CLI on the transcript in a Ghostty window.
    cc_cmd = (
        f'{CLAUDE_BIN} --dangerously-skip-permissions '
        f'--append-system-prompt {shlex.quote(system_prompt)} {shlex.quote(prompt_abs)}'
    )
    subprocess.Popen(
        ['open', '-na', '/Applications/Ghostty.app', '--args',
         '--quit-after-last-window-closed=true',
         '-e', 'zsh', '-c', cc_cmd],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    log_message(f"Launched Ghostty fallback for {filepath}")
    send_message({"type": "complete", "action": "openInCC", "filepath": str(filepath)})

def main():
    """Main loop for native messaging"""
    log_message("Local AI Handler (LiteLLM) started")

    while True:
        try:
            msg = read_message()
            if msg is None:
                log_message("No more input, exiting")
                break

            action = msg.get('action')
            log_message(f"Received action: {action}")

            if action in ('summarize', 'followup'):
                handle_request(msg)
            elif action == 'openInCC':
                handle_open_in_cc(msg)
            elif action == 'health':
                send_message({"status": "healthy", "service": "Local AI Handler (LiteLLM)"})
            else:
                send_message({"type": "error", "error": f"Unknown action: {action}"})

        except KeyboardInterrupt:
            log_message("Received interrupt, exiting")
            break
        except Exception as e:
            error_msg = f"Error in main loop: {str(e)}"
            log_message(error_msg)
            send_message({"type": "error", "error": error_msg})
            break

if __name__ == "__main__":
    main()
