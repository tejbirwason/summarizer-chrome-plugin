// Port of ai-config.json. models[0] is the "best" default pick (Opus 5.5); alternateModels
// define no prompt of their own, so switching model is a pure model swap on the same
// instructions — same contract the picker had locally.

export interface ModelDef {
  id: string;
  name: string;
  icon: string;
  model: string; // OpenRouter model slug
  reasoning?: { effort?: 'low' | 'medium' | 'high' } | { max_tokens: number };
  max_tokens: number;
  prompt?: string;
}

export const MODELS: ModelDef[] = [
  {
    id: 'opus-5-5',
    name: 'Opus 5.5',
    icon: 'claude',
    model: 'anthropic/claude-opus-5.5',
    reasoning: { effort: 'high' },
    max_tokens: 16000,
    prompt: 'Summarize concisely and extract key insights. Start with a TLDR. Use markdown:\n\n',
  },
];

export const ALTERNATE_MODELS: ModelDef[] = [
  {
    id: 'fable',
    name: 'Fable 5.1',
    icon: 'claude',
    model: 'anthropic/claude-fable-5.1',
    reasoning: { effort: 'high' },
    max_tokens: 16000,
  },
  {
    id: 'opus',
    name: 'Opus 4.8',
    icon: 'claude',
    model: 'anthropic/claude-opus-4.8',
    reasoning: { effort: 'high' },
    max_tokens: 16000,
  },
  {
    id: 'gpt',
    name: 'GPT-5.6 Sol',
    icon: 'openai',
    model: 'openai/gpt-5.6-sol',
    reasoning: { effort: 'high' },
    max_tokens: 8000,
  },
  {
    id: 'sonnet',
    name: 'Sonnet 5',
    icon: 'claude',
    model: 'anthropic/claude-sonnet-5',
    max_tokens: 8000,
  },
  {
    id: 'gpt-pro',
    name: 'GPT-5.6 Sol Pro',
    icon: 'openai',
    model: 'openai/gpt-5.6-sol-pro',
    reasoning: { effort: 'high' },
    max_tokens: 8000,
  },
];

export const DEFAULT_PROMPT =
  'Summarize concisely. Start with TLDR, then a tweetable one-liner. Be direct. ' +
  "No contrastive framing—don't define things by what they aren't. Use markdown:\n\n";

// "Chat with transcript" mode: no summary up front. This is the system turn the conversation
// starts from; the source text is appended after it, and the user's first message is the
// first real turn.
export const CHAT_PROMPT =
  'You are helping the user talk through a YouTube video. Its full transcript is below. ' +
  'Answer from the transcript; when it has timestamps, cite the approximate time. ' +
  "If the video doesn't cover something, say so before adding outside knowledge. Be direct. Use markdown.";

const ALL = [...MODELS, ...ALTERNATE_MODELS];

// ai-config.json's loader enforced id uniqueness across both arrays; keep that invariant
// here so a duplicate can't silently shadow a model and strand its saved summaries.
const seen = new Set<string>();
for (const m of ALL) {
  if (seen.has(m.id)) throw new Error(`duplicate model id: ${m.id}`);
  seen.add(m.id);
}

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function findModel(id: string | undefined | null): ModelDef {
  return ALL.find((m) => m.id === id) ?? MODELS[0];
}

export function listModels() {
  return ALL.map((m) => ({
    id: m.id,
    name: m.name,
    icon: m.icon,
    primary: MODELS.some((p) => p.id === m.id),
  }));
}

// Resolve the prompt the way the local host did: an explicit prompt wins, then the model's
// own prompt (primaries only), then the remembered default, then the built-in.
export function resolvePrompt(explicit: string | null | undefined, model: ModelDef, remembered?: string | null): string {
  return explicit?.trim() || model.prompt || remembered?.trim() || DEFAULT_PROMPT;
}
