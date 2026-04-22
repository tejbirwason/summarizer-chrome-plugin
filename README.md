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

1. Clone this repository.

2. **Set up API keys**:
   - `cp config.example.js config.js` → add your Anthropic API key (used for the ✒️ draft flow in the browser)
   - `cp .env.example .env` → add `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and (optional) Webshare proxy creds for YouTube
   - Both files are gitignored.

3. **Load the extension**:
   - Open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked**, select this directory
   - Copy the extension ID from the extension card (e.g. `fbmgekimgmgiiffchlkfknehmgmiphaf`)

4. **Run the install script** with that ID:
   ```bash
   scripts/install.sh <EXTENSION_ID>
   ```
   It installs Python deps, marks the Python hosts executable, renders `com.localai.json` + `com.ytsummary.json` with your repo path and extension ID, and copies them into Chrome's `NativeMessagingHosts` directory.

5. **Fully quit Chrome (cmd+Q) and relaunch.** A plain extension reload doesn't pick up native-messaging manifest changes.

See `NATIVE_MESSAGING_SETUP.md` for troubleshooting.

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
