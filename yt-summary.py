#!/usr/bin/env python3
import datetime
import json
import os
import struct
import sys

from youtube_transcript_api import YouTubeTranscriptApi

while True:
    try:
        # Read message length
        raw_length = sys.stdin.buffer.read(4)
        if not raw_length:
            break
        length = struct.unpack("I", raw_length)[0]

        # Read and parse message
        message = json.loads(sys.stdin.buffer.read(length))
        video_id = message.get("video_id", "NO_ID_RECEIVED")

        # Log with timestamp
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open("/tmp/native-host-test.txt", "a") as f:
            f.write(f"[{timestamp}] Received video ID: {video_id}\n")

        def get_transcript(video_id):
            try:
                transcript = YouTubeTranscriptApi.get_transcript(video_id)
                return " ".join(segment["text"] for segment in transcript)
            except Exception as e:
                return f"Error getting transcript: {str(e)}"

        response_text = get_transcript(video_id)
        response = {"text": response_text}

        # Encode and send response
        encoded = json.dumps(response).encode()
        sys.stdout.buffer.write(struct.pack("I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

        # Log response transmission
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open("/tmp/native-host-test.txt", "a") as f:
            f.write(f"[{timestamp}] Sent response for video ID: {video_id}\n")
            f.write(f"[{timestamp}] Python sys.path: {sys.path}\n")
            f.write(f"[{timestamp}] Python executable: {sys.executable}\n")
            f.write(f"[{timestamp}] Python version: {sys.version}\n")
            f.write(f"[{timestamp}] System PATH: {os.environ.get('PATH', '')}\n\n")

    except Exception as e:
        with open("/tmp/native-host-test.txt", "a") as f:
            f.write(f"[{timestamp}] Error: {str(e)}\n")
        break
