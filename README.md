# Summarize & Draft Chrome Extension

A Chrome extension that provides AI-powered text summarization (using OpenAI's o3 model) and response drafting (using Claude) capabilities. Also includes YouTube video transcript summarization.

## Features

- **Text Summarization**: Select any text on a webpage and click the ✨ button to get an AI summary
- **Response Drafting**: Click the ✒️ button to draft a response based on selected text
- **YouTube Summarization**: Automatically adds a "Summarize" button to YouTube videos
- **Streaming Responses**: See results as they're generated in real-time

## Installation

1. Clone this repository
2. **Set up API keys**:
   - Copy `config.example.js` to `config.js`: `cp config.example.js config.js`
   - Edit `config.js` and add your API keys:
     - Replace `'your-openai-api-key-here'` with your OpenAI API key
     - Replace `'your-anthropic-api-key-here'` with your Anthropic API key
   - The `config.js` file is gitignored and won't be committed
3. Open Chrome and navigate to `chrome://extensions/`
4. Enable "Developer mode" in the top right
5. Click "Load unpacked" and select the extension directory

### YouTube Summarization Setup (Optional)

To enable YouTube video summarization:

1. Install Python dependencies:
   ```bash
   pip3 install youtube-transcript-api
   ```

2. Update the native messaging manifest:
   - Edit `com.ytsummary.json` with your extension ID (found in chrome://extensions)
   - Copy it to Chrome's native messaging directory:
   ```bash
   cp com.ytsummary.json ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/
   ```

## Usage

1. **Text Summarization**: Select text on any webpage → Click ✨ floating button
2. **Response Drafting**: Select text → Click ✒️ button → Enter instructions → Press Enter
3. **YouTube Videos**: Navigate to a YouTube video → Click "Summarize" button (top-right)

## Security Notes

- **API keys are stored locally**: Your API keys are stored in `config.js` which is gitignored
- The `.gitignore` file prevents `config.js` from being committed to the repository
- Never commit real API keys to version control
- For enhanced security, consider using Chrome storage API for production deployments

## Development

### Running Tests
```bash
npm test                # Run all tests
npm run test:watch      # Run tests in watch mode
npm run test:coverage   # Run tests with coverage report
```

### Project Structure
- `background.js` - Service worker handling API calls
- `config.js` - API keys configuration (create from config.example.js)
- `content.js` - Main content script for text selection
- `youtube-content.js` - YouTube-specific functionality
- `yt-summary.py` - Native messaging host for YouTube transcripts
- `manifest.json` - Extension configuration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes (remember to not commit API keys)
4. Run tests
5. Submit a pull request

## License

MIT