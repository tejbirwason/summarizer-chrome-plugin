#!/usr/bin/env python3
"""
Quick test script for pytubefix to extract YouTube video transcripts
"""

from pytubefix import YouTube
import sys

def test_pytubefix(video_url):
    """Test pytubefix transcript extraction"""
    print(f"Testing pytubefix on: {video_url}\n")
    print("=" * 60)

    try:
        # Create YouTube object
        print("📥 Fetching video information...")
        yt = YouTube(video_url)

        # Print video info
        print(f"\n📺 Video Title: {yt.title}")
        print(f"👤 Author: {yt.author}")
        print(f"⏱️  Duration: {yt.length} seconds ({yt.length // 60}m {yt.length % 60}s)")
        print(f"👁️  Views: {yt.views:,}")

        # Get captions
        print("\n📝 Available Captions:")
        captions = yt.captions

        if not captions:
            print("❌ No captions available for this video")
            return

        # List all available captions
        caption_list = list(captions)
        for caption_obj in caption_list:
            print(f"   - {caption_obj.code}: {caption_obj.name}")

        # Try to get English captions (auto-generated or manual)
        print("\n🔍 Attempting to extract English transcript...")

        caption = None
        # Try to find English caption by checking each caption object
        for caption_obj in caption_list:
            code = caption_obj.code
            if 'en' in code.lower():
                caption = caption_obj
                print(f"✅ Found caption track: {code} ({caption_obj.name})")
                break

        if not caption:
            # Get first available caption
            caption = caption_list[0]
            print(f"⚠️  No English captions found, using: {caption.code}")

        # Extract transcript as text
        print("\n📄 Extracting transcript text...")
        transcript_text = caption.generate_srt_captions()

        # Show first 500 characters
        print("\n" + "=" * 60)
        print("📋 TRANSCRIPT PREVIEW (SRT format):")
        print("=" * 60)
        print(transcript_text[:800])
        if len(transcript_text) > 800:
            print(f"\n... (truncated, total length: {len(transcript_text)} characters)")

        # Also get plain text
        print("\n" + "=" * 60)
        print("📋 PLAIN TEXT PREVIEW:")
        print("=" * 60)
        plain_text = caption.generate_srt_captions()
        # Convert SRT to plain text (remove timestamps)
        lines = plain_text.split('\n')
        text_only = []
        for line in lines:
            if line.strip() and not line[0].isdigit() and '-->' not in line:
                text_only.append(line.strip())

        plain_transcript = ' '.join(text_only)
        print(plain_transcript[:500])
        if len(plain_transcript) > 500:
            print(f"\n... (truncated, total length: {len(plain_transcript)} characters)")

        print("\n" + "=" * 60)
        print("✅ SUCCESS! Transcript extracted successfully")
        print("=" * 60)

    except Exception as e:
        print(f"\n❌ ERROR: {type(e).__name__}: {str(e)}")
        import traceback
        print("\nFull traceback:")
        traceback.print_exc()

if __name__ == "__main__":
    video_url = "https://www.youtube.com/watch?v=Ld2ze2TsI9A"

    # Check if pytubefix is installed
    try:
        import pytubefix
        print(f"✅ pytubefix version: {pytubefix.__version__ if hasattr(pytubefix, '__version__') else 'unknown'}\n")
    except ImportError:
        print("❌ pytubefix not installed!")
        print("Install with: pip install pytubefix")
        sys.exit(1)

    test_pytubefix(video_url)
