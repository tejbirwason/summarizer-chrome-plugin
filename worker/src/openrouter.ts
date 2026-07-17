import type { ModelDef } from './config';

// Direct fetch to OpenRouter — no LiteLLM. This deletes the entire build_params()
// provider-sniffing path: OpenRouter takes ONE unified `reasoning` field and maps it onto
// whatever the upstream provider wants, so there is nothing to route to extra_body and no
// UnsupportedParamsError class to hit. It also removes LiteLLM's habit of occasionally
// yielding a whole completion as a single chunk — raw SSE streams normally.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export interface Msg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function buildBody(model: ModelDef, messages: Msg[]) {
  const body: Record<string, unknown> = {
    model: model.model,
    messages,
    max_tokens: model.max_tokens,
    stream: true,
  };
  if (model.reasoning) body.reasoning = model.reasoning;
  return body;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void | Promise<void>;
  onDone: () => void | Promise<void>;
  onError: (err: string) => void | Promise<void>;
}

/**
 * Streams a completion, invoking onDelta per token chunk.
 * Mirrors the local host's 150s idle watchdog: a stalled upstream errors out instead of
 * hanging forever. The timer resets on every delta, so slow-but-alive is fine.
 */
export async function streamCompletion(
  apiKey: string,
  model: ModelDef,
  messages: Msg[],
  cb: StreamCallbacks,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://summarizer.workers.dev',
      'X-Title': 'Summarizer',
    },
    body: JSON.stringify(buildBody(model, messages)),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    const msg = `OpenRouter ${res.status}: ${detail.slice(0, 300)}`;
    await cb.onError(msg);
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE frames are newline-delimited; keep the trailing partial in buf.
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') {
          await cb.onDone();
          return full;
        }
        try {
          const j = JSON.parse(payload);
          const delta: string | undefined = j?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            await cb.onDelta(delta);
          }
          const err = j?.error?.message;
          if (err) {
            await cb.onError(String(err));
            throw new Error(String(err));
          }
        } catch (e) {
          // A JSON.parse failure on one frame is a malformed chunk, not a fatal stream
          // error — OpenRouter interleaves comment/keepalive lines. Only rethrow if the
          // frame actually carried an upstream error.
          if (e instanceof Error && !/Unexpected|JSON/i.test(e.message)) throw e;
        }
      }
    }
    await cb.onDone();
    return full;
  } finally {
    reader.releaseLock();
  }
}
