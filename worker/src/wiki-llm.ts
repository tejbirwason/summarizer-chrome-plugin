import type { Env } from './job';

// Non-streaming OpenRouter calls for the wiki's background agents (librarian, editors,
// gardeners, chat tool loop). Streaming lives in openrouter.ts; these jobs want one JSON
// object back and the usage/cost for bookkeeping.

export const MODEL_FAST = 'anthropic/claude-haiku-5.5';
export const MODEL_EDITOR = 'anthropic/claude-sonnet-5.5';
export const MODEL_LIBRARIAN = 'anthropic/claude-opus-5.5';
export const EMBED_MODEL = '@cf/baai/bge-m3';

export interface LlmResult<T> {
  data: T;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

async function call(env: Env, body: Record<string, unknown>) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://summarizer.workers.dev',
        'X-Title': 'Summarizer wiki',
      },
      body: JSON.stringify({ ...body, usage: { include: true } }),
    });
    if (res.ok) {
      const j = (await res.json()) as any;
      if (j?.choices?.[0]?.message) return j;
      last = `empty completion: ${JSON.stringify(j).slice(0, 300)}`;
    } else {
      last = `OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`;
      if (res.status < 500 && res.status !== 429) break;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
  }
  throw new Error(last);
}

/** One call, schema-enforced JSON out. */
export async function llmJSON<T>(
  env: Env,
  model: string,
  messages: ChatMsg[],
  schema: Record<string, unknown>,
  opts: { maxTokens?: number; effort?: 'low' | 'medium' | 'high' } = {},
): Promise<LlmResult<T>> {
  const j = await call(env, {
    model,
    messages,
    max_tokens: opts.maxTokens ?? 8000,
    ...(opts.effort ? { reasoning: { effort: opts.effort } } : {}),
    response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema } },
  });
  const content = j.choices[0].message.content as string;
  return {
    data: JSON.parse(content) as T,
    cost: j.usage?.cost ?? 0,
    tokensIn: j.usage?.prompt_tokens ?? 0,
    tokensOut: j.usage?.completion_tokens ?? 0,
  };
}

/** One turn of a tool-calling loop. Returns the assistant message as-is. */
export async function llmTools(env: Env, model: string, messages: ChatMsg[], tools: unknown[], maxTokens = 6000) {
  const j = await call(env, { model, messages, tools, max_tokens: maxTokens });
  return { message: j.choices[0].message as ChatMsg, cost: (j.usage?.cost ?? 0) as number };
}

/** Workers AI embeddings, batched. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const r = (await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + 50).map((t) => t.slice(0, 2000)) })) as { data: number[][] };
    out.push(...r.data);
  }
  return out;
}

export const normName = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const slugify = (s: string) => normName(s).replace(/ /g, '-').slice(0, 60) || 'x';

export async function shortHash(s: string, n = 16) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, n / 2).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Vectorize ids are capped at 64 bytes, so pages/entities use a hash id + metadata. */
export const vecIdPage = (slug: string) => shortHash('p:' + slug).then((h) => 'p_' + h);
export const vecIdEntity = (id: string) => shortHash('e:' + id).then((h) => 'e_' + h);

export function cosine(a: number[], b: number[]) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

export async function getMeta(env: Env, key: string) {
  const r = await env.DB.prepare('SELECT value FROM prefs WHERE key = ?').bind('wiki:' + key).first<{ value: string }>();
  return r?.value ?? null;
}
export async function setMeta(env: Env, key: string, value: string) {
  await env.DB.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .bind('wiki:' + key, value).run();
}
