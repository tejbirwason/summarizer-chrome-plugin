# Summarize & Draft Chrome Extension

A Chrome extension that provides AI-powered text summarization and response drafting capabilities. Features multi-model summaries (e.g., Opus 4.5 + GPT-5.2) via local AI handler with LiteLLM, Claude-powered response drafting, and YouTube video transcript summarization.

## Features

- **Multi-Model Summarization**: Select text and get summaries from multiple AI models in parallel (configurable)
- **Response Drafting**: Click the ✒️ button to draft responses using Claude
- **YouTube Summarization**: Automatically adds a "Summarize" button to YouTube videos
- **Streaming Responses**: See results as they're generated in real-time
- **Follow-up Questions**: Ask follow-up questions inline after summaries complete
- **Session Persistence**: Resume previous summaries when returning to a page
- **Configurable AI Models**: Add any LiteLLM-supported model via `ai-config.json`

## Installation

1. Clone this repository
2. **Set up API keys**:
   - For extension (Claude API):
     - Copy `config.example.js` to `config.js`: `cp config.example.js config.js`
     - Edit `config.js` and add your Anthropic API key
   - For local AI handler (summarization via LiteLLM):
     - Copy `.env.example` to `.env`: `cp .env.example .env`
     - Edit `.env` and add API keys for your configured providers (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
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

1. **Text Summarization**: Select text on any webpage → Click ✨ floating button → See results from all configured models
2. **Response Drafting**: Select text → Click ✒️ button → Enter instructions → Press Enter
3. **YouTube Videos**: Navigate to a YouTube video → Click "✨ Summarize" button → Get multi-model video summary
4. **Follow-up Questions**: After summary completes, click "💬 Ask about this..." to ask follow-up questions
5. **Configure AI**: Edit `ai-config.json` to add/remove models (see `AI_CONFIG_README.md`)

## Security Notes

- **API keys are stored locally**: API keys are in `config.js` (Claude) and `.env` (LiteLLM providers)
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
- `local-ai-handler.py` - Native messaging host for multi-model summarization (LiteLLM)
- `yt-summary.py` - Native messaging host for YouTube transcript fetching
- `ai-config.json` - AI model configuration (see `AI_CONFIG_README.md`)
- `config.js` - Claude API key for drafts (create from config.example.js)
- `.env` - API keys for LiteLLM providers (create from .env.example)
- `manifest.json` - Extension configuration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes (remember to not commit API keys)
4. Run tests
5. Submit a pull request

## License

MIT
