#!/Users/tjwason/.pyenv/versions/3.11.13/bin/python3
"""
Local AI Handler for Chrome Extension
Handles text summarization using OpenAI's o3 (fast) and GPT-5.1 (deep) models
Supports streaming via native messaging protocol
"""
import datetime
import json
import os
import struct
import sys
from pathlib import Path
from openai import OpenAI

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# Initialize OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# Load AI configuration
config_path = Path(__file__).parent / "ai-config.json"
try:
    with open(config_path, 'r') as f:
        AI_CONFIG = json.load(f)
except Exception as e:
    # Fallback to defaults if config not found
    AI_CONFIG = {
        "models": {"fast": "gpt-5.1", "deep": "gpt-5.1"},
        "reasoning": {"fast": "none", "deep": "high"},
        "verbosity": {"fast": "low", "deep": "low"},
        "prompts": {
            "fast": "Summarize concisely. Format your response using markdown:\n\n",
            "deep": "Extract key insights, but be concise. Start with a TLDR. Format your response using markdown:\n\n"
        }
    }

def log_message(message):
    """Log messages to file for debugging"""
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open("/tmp/local-ai-handler.log", "a") as f:
        f.write(f"[{timestamp}] {message}\n")

def send_message(message_dict):
    """Send a message back to the extension via native messaging protocol"""
    try:
        encoded = json.dumps(message_dict).encode('utf-8')
        sys.stdout.buffer.write(struct.pack("I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except Exception as e:
        log_message(f"Error sending message: {str(e)}")

def summarize_fast(text):
    """Fast summarization using configured model and prompt"""
    try:
        model = AI_CONFIG["models"]["fast"]
        reasoning = AI_CONFIG["reasoning"]["fast"]
        verbosity = AI_CONFIG["verbosity"]["fast"]
        prompt = AI_CONFIG["prompts"]["fast"]

        log_message(f"Starting fast summarization (model={model}, reasoning={reasoning}, verbosity={verbosity}) for text length: {len(text)}")
        log_message(f"API Call: model={model}, input_length={len(text)}, reasoning={reasoning}, verbosity={verbosity}, streaming=True")

        stream = client.responses.create(
            model=model,
            input=f"{prompt}{text}",
            reasoning={"effort": reasoning},
            text={"verbosity": verbosity},
            stream=True
        )

        log_message("gpt-5.1 API call initiated successfully")

        summary = ""
        for event in stream:
            if event.type == 'response.output_text.delta':
                summary += event.delta
                # Send streaming update
                send_message({
                    "type": "delta",
                    "mode": "fast",
                    "delta": event.delta,
                    "summary": summary
                })

        # Send completion
        send_message({
            "type": "complete",
            "mode": "fast",
            "summary": summary
        })

        log_message(f"Fast summarization complete, length: {len(summary)}")

    except Exception as e:
        error_msg = f"Error in fast summarization: {str(e)}"
        log_message(error_msg)
        send_message({
            "type": "error",
            "mode": "fast",
            "error": error_msg
        })

def summarize_deep(text):
    """Deep summarization using configured model and prompt"""
    try:
        model = AI_CONFIG["models"]["deep"]
        reasoning = AI_CONFIG["reasoning"]["deep"]
        verbosity = AI_CONFIG["verbosity"]["deep"]
        prompt = AI_CONFIG["prompts"]["deep"]

        log_message(f"Starting deep summarization (model={model}, reasoning={reasoning}, verbosity={verbosity}) for text length: {len(text)}")
        log_message(f"API Call: model={model}, input_length={len(text)}, reasoning={reasoning}, verbosity={verbosity}, streaming=True")

        stream = client.responses.create(
            model=model,
            input=f"{prompt}{text}",
            text={"verbosity": verbosity},
            reasoning={"effort": reasoning},
            stream=True
        )

        log_message("gpt-5.1 API call initiated successfully")

        summary = ""
        for event in stream:
            if event.type == 'response.output_text.delta':
                summary += event.delta
                # Send streaming update
                send_message({
                    "type": "delta",
                    "mode": "deep",
                    "delta": event.delta,
                    "summary": summary
                })

        # Send completion
        send_message({
            "type": "complete",
            "mode": "deep",
            "summary": summary
        })

        log_message(f"Deep summarization complete, length: {len(summary)}")

    except Exception as e:
        error_msg = f"Error in deep summarization: {str(e)}"
        log_message(error_msg)
        send_message({
            "type": "error",
            "mode": "deep",
            "error": error_msg
        })

def main():
    """Main loop for native messaging"""
    log_message("Local AI Handler started")

    while True:
        try:
            # Read message length (4 bytes)
            raw_length = sys.stdin.buffer.read(4)
            if not raw_length:
                log_message("No more input, exiting")
                break

            length = struct.unpack("I", raw_length)[0]

            # Read and parse message
            message_bytes = sys.stdin.buffer.read(length)
            message = json.loads(message_bytes.decode('utf-8'))

            action = message.get("action")
            log_message(f"Received action: {action}")

            if action == "summarize":
                text = message.get("text", "")
                mode = message.get("mode", "fast")

                log_message(f"Summarizing in {mode} mode, text length: {len(text)}")

                if mode == "deep":
                    summarize_deep(text)
                else:
                    summarize_fast(text)

            elif action == "health":
                send_message({"status": "healthy", "service": "Local AI Handler"})

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
