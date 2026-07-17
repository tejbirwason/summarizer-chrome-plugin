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

# litellm is imported lazily inside handle_request (it's a ~1s import). The status /
# openGraphic / health actions don't need it, so the native host spawns fast for them.

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

def build_params(model_config, messages):
    """Translate an ai-config.json model entry into LiteLLM completion kwargs.

    OpenRouter exposes ONE unified `reasoning` field that it maps onto whatever the upstream
    provider wants (OpenAI effort levels, Anthropic thinking budgets). We pass it straight
    through as extra_body rather than using LiteLLM's reasoning_effort/thinking params, which
    it rejects for several openrouter models ("openrouter does not support parameters: [...]").
    Config may write `reasoning` as a bare effort string or as an explicit object:
        "reasoning": "high"                  ->  {"effort": "high"}
        "reasoning": {"effort": "high"}      ->  passed as-is
        "reasoning": {"max_tokens": 10000}   ->  passed as-is (Anthropic-style budget)

    Non-openrouter models keep the old provider-sniffing path, so a direct `openai/...` or
    `anthropic/...` entry still works if one is ever added back.
    """
    litellm_model = model_config['litellm_model']
    params = {
        "model": litellm_model,
        "messages": messages,
        "stream": True,
        "max_tokens": model_config.get('max_tokens', 4096),
    }

    reasoning = model_config.get('reasoning')
    if litellm_model.startswith('openrouter/'):
        if reasoning:
            if isinstance(reasoning, str):
                reasoning = {"effort": reasoning}
            params['extra_body'] = {"reasoning": reasoning}
    else:
        if reasoning and 'openai' in litellm_model:
            params['reasoning_effort'] = reasoning
        if 'thinking' in model_config and 'anthropic' in litellm_model:
            params['thinking'] = model_config['thinking']

    return params


def handle_request(data):
    """Handle summarize or followup request (stateless)"""
    from litellm import completion  # lazy: heavy import, only needed for completions
    model_id = data['modelId']
    model_config = data['modelConfig']
    messages = data['messages']  # Full conversation history from extension

    log_message(f"Request for model {model_id}: {model_config['litellm_model']}, messages count: {len(messages)}")

    params = build_params(model_config, messages)

    extra = params.get('extra_body') or {k: params[k] for k in ('reasoning_effort', 'thinking') if k in params}
    log_message(f"LiteLLM params: model={params['model']}, max_tokens={params['max_tokens']}, extra={extra}")

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
        block = json.loads(CONFIG_PATH.read_text()).get("openInClaudeCode", {})
    except (OSError, json.JSONDecodeError) as e:
        log_message(f"Could not load openInClaudeCode config ({e}); using defaults")
        return cfg
    # Only non-empty overrides win. A null/"" model must not shadow the default, or we'd hand
    # the launchers an empty --model and silently get whatever their default model is.
    for key, value in block.items():
        if value:
            cfg[key] = value
        elif key in OPEN_IN_CC_DEFAULTS:
            log_message(f"openInClaudeCode.{key} is empty; keeping default {cfg[key]!r}")
    return cfg


def summarize_prompt(template, ref, out=""):
    """Fill the configured transcript-summarization instruction with the transcript path
    ({ref}) and the deterministic graphic output path ({out}). Uses .replace (not .format)
    so other braces in a user-edited prompt are left alone."""
    return template.replace("{ref}", ref).replace("{out}", out)

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
    # Deterministic graphic path: a PNG sibling sharing the transcript's stem
    # (…-<videoId>.png). This is the join key — handle_status() later finds it by the
    # embedded videoId, so the extension can detect & open the graphic for a video.
    out_abs = str(filepath.with_suffix(".png"))
    out_rel = Path(fname).with_suffix(".png").name
    prompt_rel = summarize_prompt(cfg["prompt"], fname, out_rel)          # relative — only the --worktree-bound chat fallback uses this
    prompt_abs = summarize_prompt(cfg["prompt"], str(filepath), out_abs)  # absolute — robust regardless of the tab's working dir

    sc_ok = Path(SC_BIN).exists() and subprocess.run([SC_BIN, 'status'], capture_output=True).returncode == 0

    # Primary: a fresh terminal-backed Claude Code tab per transcript, in the dedicated
    # yt-transcripts workspace (must be open in SC). --active keep so it lands there without
    # pulling focus off whatever workspace you're currently in.
    if sc_ok:
        run = subprocess.run(
            [SC_BIN, 'layout', 'run', 'tabs', '--provider', 'claude', '--ui', 'terminal',
             '--model', model, '--reasoning', reasoning, '--system-prompt', system_prompt,
             '--worktree', str(TRANSCRIPTS_DIR), '--open-if-needed', '--active', 'keep',
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
    # --model/--effort are mandatory here: with no --model the CLI picks its own default, which
    # is not pinned anywhere on this machine and can be Fable rather than Opus.
    cc_cmd = (
        f'{CLAUDE_BIN} --dangerously-skip-permissions '
        f'--model {shlex.quote(model)} --effort {shlex.quote(reasoning)} '
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

# ---------------------------------------------------------------------------
# Summary status — associate a YouTube video with its archived transcript and
# generated explainer graphic via the 11-char videoId embedded in each filename
# (…-<videoId>.md / …-<videoId>.png). The filesystem IS the index: a transcript
# means "summarized", a sibling PNG means "graphic ready". No separate store to
# keep in sync — the graphic appearing on disk is itself the completion signal.
# ---------------------------------------------------------------------------
VIDEO_ID_RE = re.compile(r'-([A-Za-z0-9_-]{11})\.(?:md|png)$')

def scan_status():
    """Scan TRANSCRIPTS_DIR once. Return (sorted summarized videoIds, {videoId: graphic_path})."""
    summarized, graphics = set(), {}
    if TRANSCRIPTS_DIR.exists():
        for p in TRANSCRIPTS_DIR.iterdir():
            m = VIDEO_ID_RE.search(p.name)
            if not m:
                continue
            vid = m.group(1)
            if p.suffix == ".png":
                graphics[vid] = str(p)
            else:  # .md transcript
                summarized.add(vid)
    summarized.update(graphics)  # a graphic implies the video was summarized
    return sorted(summarized), graphics

def handle_status(data):
    """Return the set of summarized videoIds and the videoId->graphic-path map."""
    summarized, graphics = scan_status()
    log_message(f"status: {len(summarized)} summarized, {len(graphics)} with graphics")
    send_message({"type": "status", "summarized": summarized, "graphics": graphics})

def handle_open_graphic(data):
    """Open a generated graphic in the macOS default viewer (Preview)."""
    path = data.get("graphic_path", "")
    if path and Path(path).exists():
        subprocess.Popen(["open", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        log_message(f"Opened graphic {path}")
        send_message({"type": "complete", "action": "openGraphic", "path": path})
    else:
        log_message(f"openGraphic: not found: {path}")
        send_message({"type": "error", "action": "openGraphic", "error": "Graphic not found"})

# Cap the inline poster payload. Native-messaging responses are hard-capped at 1 MB by Chrome,
# and base64 inflates bytes ~1.33x, so the encoded preview must stay well under that. explain-viz
# posters are 4K (11–14 MB), so we never ship the original — we downscale to a preview JPEG with
# the built-in `sips` (no extra Python deps) and hand back the ORIGINAL path so a click still
# opens the full-res image in Preview.
MAX_INLINE_GRAPHIC_BYTES = 700_000

def make_preview_data_url(src):
    """Downscale `src` to a JPEG preview small enough to inline, using macOS `sips`. Tries a few
    max-dimensions and returns (data_url, None) on success or (None, reason) on failure."""
    import base64
    import tempfile
    for max_dim in (1200, 900, 700):
        tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        tmp.close()
        try:
            r = subprocess.run(
                ["sips", "-Z", str(max_dim), "--setProperty", "format", "jpeg", str(src), "--out", tmp.name],
                capture_output=True,
            )
            if r.returncode != 0 or not os.path.exists(tmp.name):
                continue
            size = os.path.getsize(tmp.name)
            if size == 0 or size > MAX_INLINE_GRAPHIC_BYTES:
                continue
            with open(tmp.name, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("ascii")
            return f"data:image/jpeg;base64,{b64}", None
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    return None, "preview_failed"

def handle_get_graphic(data):
    """Return a generated poster as an inline JPEG-preview data: URL (downscaled from the 4K
    original). Resolve the file from an explicit graphic_path, else from the videoId (same
    filename join key handle_status uses). The returned `path` is always the ORIGINAL, so the
    panel's click-to-open still shows full resolution in Preview."""
    import base64
    path = data.get("graphic_path", "")
    if not path:
        vid = data.get("video_id", "")
        if vid:
            _, graphics = scan_status()
            path = graphics.get(vid, "")
    p = Path(path) if path else None
    if not p or not p.exists():
        log_message(f"getGraphic: not found (path={path!r}, video_id={data.get('video_id','')!r})")
        send_message({"type": "error", "action": "getGraphic", "error": "not_found"})
        return

    size = p.stat().st_size
    ext = p.suffix.lstrip(".").lower() or "png"

    # Small enough already → inline the original bytes directly.
    if size <= MAX_INLINE_GRAPHIC_BYTES and ext in ("jpg", "jpeg", "png", "webp", "gif"):
        mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        log_message(f"getGraphic: inlined {p.name} as-is ({size} bytes)")
        send_message({"type": "graphic", "action": "getGraphic", "path": str(p), "dataUrl": f"data:{mime};base64,{b64}"})
        return

    # Large → downscale to a preview.
    data_url, reason = make_preview_data_url(p)
    if data_url:
        log_message(f"getGraphic: sent downscaled preview of {p.name} (orig {size} bytes)")
        send_message({"type": "graphic", "action": "getGraphic", "path": str(p), "preview": True, "dataUrl": data_url})
    else:
        log_message(f"getGraphic: {p.name} too large and preview failed ({reason})")
        send_message({"type": "error", "action": "getGraphic", "error": "too_large", "path": str(p)})

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
            elif action == 'status':
                handle_status(msg)
            elif action == 'openGraphic':
                handle_open_graphic(msg)
            elif action == 'getGraphic':
                handle_get_graphic(msg)
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
