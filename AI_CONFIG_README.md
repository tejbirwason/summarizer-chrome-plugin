# AI Configuration Guide

## Quick Config: `ai-config.json`

Edit this file to change models and prompts without touching code.

### File Structure

```json
{
  "models": [
    {
      "id": "opus",
      "name": "Opus 4.5",
      "icon": "🟣",
      "litellm_model": "anthropic/claude-opus-4-5-20251101",
      "max_tokens": 4096,
      "prompt": "Summarize and extract key insights. Start with TLDR. Use markdown:\n\n"
    },
    {
      "id": "gpt",
      "name": "GPT-5.2",
      "icon": "🤖",
      "litellm_model": "openai/gpt-5.2",
      "reasoning": "high",
      "max_tokens": 4096,
      "prompt": "Summarize and extract key insights. Start with TLDR. Use markdown:\n\n"
    }
  ],
  "defaultPrompt": "Summarize concisely. Start with TLDR. Use markdown:\n\n"
}
```

### Model Object Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (used internally) |
| `name` | No | Display name in UI |
| `icon` | No | Emoji shown in tab |
| `litellm_model` | Yes | LiteLLM format: `provider/model-name` |
| `max_tokens` | No | Max response tokens (default: 4096) |
| `prompt` | No | System prompt (falls back to `defaultPrompt`) |
| `reasoning` | No | For OpenAI models: `none`/`low`/`medium`/`high` |

### LiteLLM Model Format

Uses `provider/model-name` format. Examples:

**Anthropic:**
- `anthropic/claude-opus-4-5-20251101`
- `anthropic/claude-sonnet-4-20250514`
- `anthropic/claude-haiku-3-5-20241022`

**OpenAI:**
- `openai/gpt-5.2`
- `openai/gpt-5.1`
- `openai/gpt-4o`

**Other providers:** See [LiteLLM docs](https://docs.litellm.ai/docs/providers)

### Adding a New Model

Add an object to the `models` array:

```json
{
  "id": "sonnet",
  "name": "Sonnet 4",
  "icon": "🔵",
  "litellm_model": "anthropic/claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "prompt": "Be concise. Use markdown:\n\n"
}
```

Reload extension to apply changes.

### Example Configs

**Single model:**
```json
{
  "models": [
    {
      "id": "main",
      "icon": "🤖",
      "litellm_model": "openai/gpt-5.2",
      "reasoning": "high"
    }
  ]
}
```

**Three models:**
```json
{
  "models": [
    {"id": "opus", "icon": "🟣", "litellm_model": "anthropic/claude-opus-4-5-20251101"},
    {"id": "sonnet", "icon": "🔵", "litellm_model": "anthropic/claude-sonnet-4-20250514"},
    {"id": "gpt", "icon": "🤖", "litellm_model": "openai/gpt-5.2", "reasoning": "high"}
  ]
}
```

### Environment Variables

API keys are read from `.env`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

LiteLLM automatically uses the appropriate key based on the provider in `litellm_model`.
