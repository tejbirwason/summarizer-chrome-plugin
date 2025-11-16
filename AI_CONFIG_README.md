# AI Configuration Guide

## Quick Config: `ai-config.json`

Edit this file to change models and prompts without touching Python code.

### File Structure

```json
{
  "models": {
    "fast": "gpt-5.1",      // Model for fast mode
    "deep": "gpt-5.1"       // Model for deep mode
  },
  "reasoning": {
    "fast": "none",         // none | low | medium | high
    "deep": "high"
  },
  "verbosity": {
    "fast": "low",          // low | medium | high
    "deep": "low"
  },
  "prompts": {
    "fast": "Your prompt...",
    "deep": "Your prompt..."
  }
}
```

### Making Changes

1. **Change model**: Edit `models.fast` or `models.deep`
2. **Adjust reasoning**: Change `reasoning.fast` or `reasoning.deep`
3. **Modify prompts**: Update text in `prompts.fast` or `prompts.deep`
4. **Save** - Changes apply immediately (no reload needed)

### Available Models

- `gpt-5.1` - Latest flagship (Instant with none, Thinking with high)
- `gpt-5` - Previous flagship
- `gpt-5-mini` - Faster, cheaper
- `gpt-5-nano` - Highest throughput

### Reasoning Levels

- `none` - No reasoning (fastest, like GPT-4.1)
- `low` - Minimal reasoning
- `medium` - Balanced
- `high` - Deep thinking (slowest)

### Verbosity Levels

- `low` - Concise output
- `medium` - Balanced
- `high` - Detailed explanations

### Example Configs

**Speed-focused:**
```json
{
  "models": {"fast": "gpt-5-nano", "deep": "gpt-5-mini"},
  "reasoning": {"fast": "none", "deep": "low"},
  "verbosity": {"fast": "low", "deep": "low"}
}
```

**Quality-focused:**
```json
{
  "models": {"fast": "gpt-5.1", "deep": "gpt-5.1"},
  "reasoning": {"fast": "low", "deep": "high"},
  "verbosity": {"fast": "medium", "deep": "high"}
}
```

### Prompt Tips

**Fast mode prompts:** Be specific about format (bullets, headers, length)

**Deep mode prompts:** Emphasize completeness, analysis, insights

**Use newlines:** `\n` in JSON for line breaks in prompts
