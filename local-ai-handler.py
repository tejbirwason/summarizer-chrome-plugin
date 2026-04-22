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
import struct
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from litellm import completion

# Load environment variables
load_dotenv()

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

def handle_open_in_cc(data):
    """Write text to temp file and open Claude Code in a new Ghostty window"""
    text = data.get('text', '')
    prompt = data.get('prompt', 'Summarize and extract key insights. Start with TLDR, then distinctive perspectives, reasoning patterns, and sticky quotes.')

    timestamp = int(time.time())
    filepath = f"/tmp/cc-summarize-{timestamp}.txt"

    with open(filepath, 'w') as f:
        f.write(text)

    log_message(f"Wrote {len(text)} chars to {filepath}")

    # Invoke claude directly with absolute path (non-interactive zsh under Ghostty's
    # login env doesn't source .zshrc, so PATH additions aren't available)
    cc_cmd = f'$HOME/.local/bin/claude --dangerously-skip-permissions --append-system-prompt "You are a transcript summarizer" "Summarize and extract key insights from this transcript: {filepath}"'

    # Launch in new Ghostty window via macOS open command
    subprocess.Popen(
        ['open', '-na', '/Applications/Ghostty.app', '--args',
         '--quit-after-last-window-closed=true',
         '-e', 'zsh', '-c', cc_cmd],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

    log_message(f"Launched Ghostty with CC for {filepath}")
    send_message({"type": "complete", "action": "openInCC", "filepath": filepath})

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
