import type { Env } from './job';
import { normName } from './wiki-llm';
import { attachSource, refreshPageCounts, schedulePages } from './wiki-graph';

// Wiki step 1: turn one source (transcript or page selection) into a "card" — atomic claims,
// entity mentions and topics — via a fast model with schema-enforced JSON output. Cards are
// what wiki pages will cite, so the extractor never writes prose pages itself.
// Backfill and live ingest share this path through the WIKI_INGEST queue.

export const CARD_MODEL = 'anthropic/claude-haiku-5.5';

export interface IngestMsg {
  sourceId: string;
  force?: boolean;
}

interface Card {
  gist: string;
  topics: string[];
  claims: { text: string; quote: string; kind: string; speaker: string }[];
  entities: { name: string; kind: string; context: string }[];
}

const CLAIM_KINDS = ['fact', 'opinion', 'advice', 'prediction', 'anecdote'];
const ENTITY_KINDS = ['person', 'org', 'product', 'concept', 'place', 'work'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gist', 'topics', 'claims', 'entities'],
  properties: {
    gist: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'quote', 'kind', 'speaker'],
        properties: {
          text: { type: 'string' },
          quote: { type: 'string' },
          kind: { type: 'string', enum: CLAIM_KINDS },
          speaker: { type: 'string' },
        },
      },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'context'],
        properties: {
          name: { type: 'string' },
          kind: { type: 'string', enum: ENTITY_KINDS },
          context: { type: 'string' },
        },
      },
    },
  },
};

// Claim budget scales with length: a 5-minute clip and a 3-hour podcast shouldn't get the
// same count. ~1 claim per 1.5k chars, clamped.
function claimBudget(chars: number) {
  return Math.max(5, Math.min(40, Math.round(chars / 1500)));
}

function prompt(title: string, url: string, kind: string, chars: number) {
  const n = claimBudget(chars);
  return `You are building a personal knowledge wiki. Extract a structured card from the ${kind === 'video' ? 'video transcript' : 'web page excerpt'} below.

Title: ${title}
URL: ${url}

Rules:
- gist: 1-2 sentences on what this source is and its main argument.
- topics: 2-6 kebab-case topic slugs, general enough to be shared across many sources (e.g. "ai-coding-agents", "distributed-systems", "personal-finance"), not specific to this one.
- claims: about ${n} of the most useful, non-obvious statements. Each must be atomic (one idea) and self-contained: name the subject instead of "he"/"it"/"this", so it reads correctly out of context. Skip filler, sponsor reads, greetings and calls to subscribe.
- claim.quote: a short VERBATIM span (5-25 words) copied exactly from the text that supports the claim. Do not paraphrase or fix typos in the quote.
- claim.kind: fact (checkable), opinion, advice, prediction, or anecdote.
- claim.speaker: who makes the claim, by full name if known, else "narrator" or "unknown".
- entities: people, organizations, products, concepts, places and works (books/papers) that matter to the claims. Use the full canonical name ("Sam Altman", not "Sam" or "Altman"). Fix obvious transcription misspellings in names. context: a few words that disambiguate (role, what it is).

Text:
"""
`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Until real caption segments exist, place a claim by where its quote sits in the transcript,
// at ~15 chars/s of speech. Good to about a minute on a talk; marked approx in the UI.
const CHARS_PER_SEC = 15;
export function approxStart(hay: string, rawLen: number, quote: string): number | null {
  const q = norm(quote);
  if (!q) return null;
  let pos = hay.indexOf(q);
  if (pos < 0) pos = hay.indexOf(q.split(' ').slice(0, 6).join(' '));
  if (pos < 0) return null;
  return Math.max(0, Math.round(((pos / hay.length) * rawLen) / CHARS_PER_SEC) - 5);
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function extract(env: Env, row: { title: string; url: string; kind: string; transcript: string }) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://summarizer.workers.dev',
      'X-Title': 'Summarizer wiki',
    },
    body: JSON.stringify({
      model: CARD_MODEL,
      messages: [{ role: 'user', content: prompt(row.title, row.url, row.kind, row.transcript.length) + row.transcript + '\n"""' }],
      max_tokens: 12000,
      response_format: { type: 'json_schema', json_schema: { name: 'card', strict: true, schema: SCHEMA } },
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as any;
  const content = j?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`empty completion: ${JSON.stringify(j).slice(0, 300)}`);
  return {
    card: JSON.parse(content) as Card,
    tokensIn: j.usage?.prompt_tokens ?? null,
    tokensOut: j.usage?.completion_tokens ?? null,
    cost: j.usage?.cost ?? null,
    ms: Date.now() - t0,
  };
}

const MIN_CHARS = 300;

/** Remove a source from the wiki; pages it fed get rewritten without it. */
export async function dropCard(env: Env, sourceId: string) {
  const pages = ((await env.DB.prepare('SELECT page_slug FROM page_sources WHERE source_id = ?').bind(sourceId)
    .all<{ page_slug: string }>()).results ?? []).map((r) => r.page_slug);
  const claimIds = ((await env.DB.prepare('SELECT id FROM claims WHERE source_id = ?').bind(sourceId)
    .all<{ id: string }>()).results ?? []).map((r) => r.id);
  await env.DB.batch(['cards', 'claims', 'mentions', 'claims_fts', 'page_sources'].map((t) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE source_id = ?`).bind(sourceId)));
  for (let i = 0; i < claimIds.length; i += 100) await env.WIKI_VEC.deleteByIds(claimIds.slice(i, i + 100));
  if (pages.length) {
    await refreshPageCounts(env, pages);
    await schedulePages(env, pages, 5000);
  }
}

/** Extract and store the card for one source. Skips when the transcript and model are unchanged. */
export async function ingestSource(env: Env, { sourceId, force }: IngestMsg) {
  const row = await env.DB.prepare('SELECT id, url, title, kind, transcript FROM summaries WHERE id = ?')
    .bind(sourceId).first<{ id: string; url: string; title: string; kind: string; transcript: string | null }>();
  // Error stubs ("No subtitles available…") and near-empty selections carry no knowledge.
  if (!row?.transcript || row.transcript.trim().length < MIN_CHARS) {
    await dropCard(env, sourceId);
    return { sourceId, skipped: 'too short' };
  }

  const hash = await sha256(row.transcript);
  // Same transcript as another source = a duplicate save or an old wrong-video read. Only
  // one copy feeds the wiki, so a claim never cites the wrong video twice.
  const twin = await env.DB.prepare('SELECT source_id FROM cards WHERE source_hash = ? AND source_id != ? LIMIT 1')
    .bind(hash, sourceId).first<{ source_id: string }>();
  if (twin) {
    await dropCard(env, sourceId);
    return { sourceId, skipped: `duplicate of ${twin.source_id}` };
  }
  if (!force) {
    const prev = await env.DB.prepare('SELECT source_hash, model FROM cards WHERE source_id = ?')
      .bind(sourceId).first<{ source_hash: string; model: string }>();
    if (prev && prev.source_hash === hash && prev.model === CARD_MODEL) return { sourceId, skipped: 'unchanged' };
  }

  const { card, tokensIn, tokensOut, cost, ms } = await extract(env, {
    title: row.title ?? row.url, url: row.url, kind: row.kind, transcript: row.transcript,
  });

  // Cheap hallucination check: does the quote actually appear in the source?
  const hay = norm(row.transcript);
  // Keyed by source id, not transcript hash: a few sources share a transcript (old
  // wrong-video reads) and must not collide on claim ids.
  const cid = `c_${(await sha256(sourceId)).slice(0, 8)}`;
  const seen = new Set<string>();
  const stmts = [
    env.DB.prepare('DELETE FROM claims WHERE source_id = ?').bind(sourceId),
    env.DB.prepare('DELETE FROM mentions WHERE source_id = ?').bind(sourceId),
    env.DB.prepare(
      `INSERT INTO cards (source_id, model, source_hash, gist, topics, json, tokens_in, tokens_out, cost_usd, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET model=excluded.model, source_hash=excluded.source_hash, gist=excluded.gist,
         topics=excluded.topics, json=excluded.json, tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out,
         cost_usd=excluded.cost_usd, duration_ms=excluded.duration_ms, created_at=excluded.created_at`,
    ).bind(sourceId, CARD_MODEL, hash, card.gist, JSON.stringify(card.topics), JSON.stringify(card), tokensIn, tokensOut, cost, ms, Date.now()),
    ...card.claims.map((c, i) => {
      const q = norm(c.quote);
      const start = row.kind === 'video' ? approxStart(hay, row.transcript!.length, c.quote) : null;
      return env.DB.prepare(
        'INSERT INTO claims (id, source_id, idx, text, quote, quote_ok, kind, speaker, start_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(`${cid}_${i}`, sourceId, i, c.text, c.quote, q.length > 0 && hay.includes(q) ? 1 : 0, c.kind, c.speaker || null, start);
    }),
    ...card.entities
      .filter((e) => {
        const k = e.name.trim().toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((e) => env.DB.prepare('INSERT INTO mentions (source_id, name, kind, context, norm) VALUES (?, ?, ?, ?, ?)')
        .bind(sourceId, e.name.trim(), e.kind, e.context || null, normName(e.name))),
  ];
  await env.DB.batch(stmts);
  return { sourceId, claims: card.claims.length, entities: seen.size, cost, ms };
}

export async function handleIngestBatch(batch: MessageBatch<IngestMsg>, env: Env) {
  await Promise.all(
    batch.messages.map(async (m) => {
      try {
        const r = await ingestSource(env, m.body);
        // Unchanged sources were already routed; everything else flows on into the pages.
        const routed = 'skipped' in r ? null : await attachSource(env, m.body.sourceId);
        console.log('wiki ingest', JSON.stringify({ ...r, routed }));
        m.ack();
      } catch (e) {
        console.error('wiki ingest failed', m.body.sourceId, String(e));
        m.retry({ delaySeconds: 30 * m.attempts });
      }
    }),
  );
}
