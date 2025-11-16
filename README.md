# Summarize & Draft Chrome Extension

A Chrome extension that provides AI-powered text summarization and response drafting capabilities. Features dual-mode summaries (fast + deep) via local AI handler, Claude-powered response drafting, and YouTube video transcript summarization.

## Features

- **Dual-Mode Summarization**: Select text and get both fast and deep summaries simultaneously
- **Response Drafting**: Click the ✒️ button to draft responses using Claude
- **YouTube Summarization**: Automatically adds a "Summarize" button to YouTube videos
- **Streaming Responses**: See results as they're generated in real-time
- **Configurable AI Models**: Customize models, reasoning levels, and prompts via `ai-config.json`

## Installation

1. Clone this repository
2. **Set up API keys**:
   - For extension (Claude API):
     - Copy `config.example.js` to `config.js`: `cp config.example.js config.js`
     - Edit `config.js` and add your Anthropic API key
   - For local AI handler (summarization):
     - Copy `.env.example` to `.env`: `cp .env.example .env`
     - Edit `.env` and add your OpenAI API key
   - Both files are gitignored and won't be committed
3. Install Python dependencies:
   ```bash
   pip3 install -r requirements.txt
   ```
4. Open Chrome and navigate to `chrome://extensions/`
5. Enable "Developer mode" in the top right
6. Click "Load unpacked" and select the extension directory

### Native Messaging Setup (Required for summarization)

To enable text summarization and YouTube video summarization:

1. Copy native messaging manifests to Chrome's directory:
   ```bash
   cp com.ytsummary.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   cp com.localai.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   ```

2. Update extension IDs in manifests if needed (get ID from chrome://extensions)

3. Make Python scripts executable:
   ```bash
   chmod +x yt-summary.py local-ai-handler.py
   ```

4. Restart Chrome completely

See `NATIVE_MESSAGING_SETUP.md` for detailed troubleshooting.

## Usage

1. **Text Summarization**: Select text on any webpage → Click ✨ floating button → See dual-mode results (fast + deep)
2. **Response Drafting**: Select text → Click ✒️ button → Enter instructions → Press Enter
3. **YouTube Videos**: Navigate to a YouTube video → Click "✨ Summarize" button → Get dual-mode video summary
4. **Configure AI**: Edit `ai-config.json` to customize models, reasoning levels, and prompts (see `AI_CONFIG_README.md`)

## Security Notes

- **API keys are stored locally**: API keys are in `config.js` (Claude) and `.env` (OpenAI)
- Both files are gitignored and won't be committed to the repository
- Never commit real API keys to version control
- For production, consider using secure key management services

## Development

### Running Tests
```bash
npm test                # Run all tests
npm run test:watch      # Run tests in watch mode
npm run test:coverage   # Run tests with coverage report
```

### Project Structure
- `background.js` - Service worker handling Claude API and native messaging orchestration
- `content-dual.js` - Main content script with dual-mode UI overlay and FABs
- `youtube-content.js` - YouTube-specific button and functionality
- `local-ai-handler.py` - Native messaging host for dual-mode summarization (fast + deep)
- `yt-summary.py` - Native messaging host for YouTube transcript fetching
- `ai-config.json` - AI model configuration (models, reasoning, prompts)
- `config.js` - Claude API key (create from config.example.js)
- `.env` - OpenAI API key (create from .env.example)
- `manifest.json` - Extension configuration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes (remember to not commit API keys)
4. Run tests
5. Submit a pull request

## License

MIT
