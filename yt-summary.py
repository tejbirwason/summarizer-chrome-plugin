#!/usr/bin/env python3
import datetime
import json
import os
import struct
import sys
from http.cookiejar import MozillaCookieJar
import requests

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import WebshareProxyConfig
import yt_dlp
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

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

        def get_transcript_ytdlp(video_id):
            """Get transcript using yt-dlp (more robust against blocking)"""
            try:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 3: Trying yt-dlp fallback...\n")

                script_dir = os.path.dirname(os.path.abspath(__file__))
                cookies_path = os.path.join(script_dir, "youtube_cookies.txt")

                ydl_opts = {
                    'writesubtitles': True,
                    'writeautomaticsub': True,
                    'skip_download': True,
                    'quiet': True,
                    'no_warnings': True,
                }

                # Add cookies if available
                if os.path.exists(cookies_path):
                    ydl_opts['cookiefile'] = cookies_path

                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)

                    # Try to get subtitles
                    subtitles = info.get('subtitles', {})
                    auto_captions = info.get('automatic_captions', {})

                    # Prefer English subtitles
                    text_data = None
                    for lang in ['en', 'en-US', 'en-GB']:
                        if lang in subtitles:
                            text_data = subtitles[lang]
                            break
                        if lang in auto_captions:
                            text_data = auto_captions[lang]
                            break

                    # If no English, try any language
                    if not text_data:
                        if subtitles:
                            text_data = list(subtitles.values())[0]
                        elif auto_captions:
                            text_data = list(auto_captions.values())[0]

                    if not text_data:
                        return "Error: No subtitles available for this video"

                    # Find the json3 format (contains text data)
                    json3_url = None
                    for format_info in text_data:
                        if format_info.get('ext') == 'json3':
                            json3_url = format_info.get('url')
                            break

                    if json3_url:
                        import urllib.request

                        # Create request with cookies and headers
                        req = urllib.request.Request(json3_url)
                        req.add_header('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')
                        req.add_header('Accept-Language', 'en-US,en;q=0.9')
                        req.add_header('Referer', 'https://www.youtube.com/')

                        # Add cookies if available
                        if os.path.exists(cookies_path):
                            with open(cookies_path, 'r') as f:
                                cookie_str = '; '.join([
                                    line.split('\t')[-2] + '=' + line.split('\t')[-1].strip()
                                    for line in f.readlines()
                                    if line.strip() and not line.startswith('#')
                                ])
                                req.add_header('Cookie', cookie_str)

                        response = urllib.request.urlopen(req)
                        subtitle_data = json.loads(response.read())

                        # Extract text from events
                        texts = []
                        for event in subtitle_data.get('events', []):
                            if 'segs' in event:
                                for seg in event['segs']:
                                    if 'utf8' in seg:
                                        texts.append(seg['utf8'])

                        joined = ' '.join(texts).strip()
                        if not joined:
                            return "Error: Subtitle track was empty"

                        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        with open("/tmp/native-host-test.txt", "a") as f:
                            f.write(f"[{timestamp}] Tier 3: SUCCESS (yt-dlp)\n")

                        return joined

                    return "Error: Could not extract transcript text"

            except Exception as e:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 3: Failed - {str(e)[:100]}\n")
                return f"Error: yt-dlp failed: {str(e)}"

        def get_transcript_api_no_proxy(video_id):
            """Try getting transcript without proxy (fastest, free)"""
            try:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 1: Trying without proxy...\n")

                api = YouTubeTranscriptApi()
                transcript_data = api.fetch(video_id)
                result = " ".join(segment.text for segment in transcript_data)

                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 1: SUCCESS (no proxy)\n")

                return result
            except Exception as e:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 1: Failed - {str(e)[:100]}\n")
                return None  # Return None to trigger next fallback

        def get_transcript_api_with_proxy(video_id):
            """Try getting transcript with Webshare proxies"""
            try:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                # Get Webshare credentials from environment
                proxy_username = os.getenv('WEBSHARE_PROXY_USERNAME')
                proxy_password = os.getenv('WEBSHARE_PROXY_PASSWORD')

                if not proxy_username or not proxy_password:
                    with open("/tmp/native-host-test.txt", "a") as f:
                        f.write(f"[{timestamp}] Tier 2: Skipped (no proxy credentials)\n")
                    return None  # No proxy configured, skip this method

                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 2: Trying with Webshare proxies...\n")

                # Use Webshare rotating proxies
                proxy_config = WebshareProxyConfig(
                    proxy_username=proxy_username,
                    proxy_password=proxy_password,
                    filter_ip_locations=["us"]  # Use US IPs only
                )
                api = YouTubeTranscriptApi(proxy_config=proxy_config)
                transcript_data = api.fetch(video_id)
                result = " ".join(segment.text for segment in transcript_data)

                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 2: SUCCESS (Webshare proxy)\n")

                return result

            except Exception as e:
                timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                with open("/tmp/native-host-test.txt", "a") as f:
                    f.write(f"[{timestamp}] Tier 2: Failed - {str(e)[:100]}\n")
                return None  # Return None to trigger next fallback

        def get_transcript(video_id):
            """Get transcript with three-tier fallback system"""
            # Tier 1: Try without proxy (fastest, free)
            result = get_transcript_api_no_proxy(video_id)
            if result:
                return result

            # Tier 2: Try with Webshare proxies (if IP blocked)
            result = get_transcript_api_with_proxy(video_id)
            if result:
                return result

            # Tier 3: Fallback to yt-dlp (most robust)
            return get_transcript_ytdlp(video_id)

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
