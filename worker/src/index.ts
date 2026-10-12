import { routeAgentRequest } from 'agents';
import { SummaryJob, type Env } from './job';
import { SummaryChat } from './chat';
import { listModels, DEFAULT_MODEL_ID, DEFAULT_PROMPT } from './config';
import { handleIngestBatch, dropCard, type IngestMsg } from './wiki';
import { WikiPage } from './wiki-page';
import { WikiChat } from './wiki-chat';
import { WikiBuild } from './wiki-build';
import { WikiGarden } from './wiki-garden';
import { wikiApi } from './wiki-api';

export { SummaryJob, SummaryChat, WikiPage, WikiChat, WikiBuild, WikiGarden };

// Port of background.js's normUrl: strip hash/tracking but KEEP YouTube's ?v=, since that
// is the only thing distinguishing one video from another.
export function normUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    const v = u.searchParams.get('v');
    if (/(^|\.)youtube\.com$/.test(u.hostname) && v) {
      return `https://www.youtube.com/watch?v=${v}`;
    }
    if (u.hostname === 'youtu.be') {
      return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    }
    u.search = '';
    return u.toString();
  } catch {
    return raw;
  }
}

const cors = (origin: string | null) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
});

const json = (data: unknown, init: ResponseInit = {}, origin: string | null = null) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...cors(origin), ...(init.headers ?? {}) },
  });

function authed(req: Request, env: Env): boolean {
  const h = req.headers.get('Authorization');
  const url = new URL(req.url);
  const tok = h?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token');
  return !!env.APP_TOKEN && tok === env.APP_TOKEN;
}

// Preview sizes for the dashboard. Thumbs are 2× the rail card. Fullscreen always
// fetches the original (no ?s=). `hero` kept so any leftover cached links still work.
const POSTER_SIZES: Record<string, { width: number; quality: number }> = {
  // Rail cards are text-dense posters — need enough px + quality to stay legible.
  // `card` (not `thumb`) so old soft 200px edge-cache entries are abandoned.
  card: { width: 900, quality: 88 },
  thumb: { width: 900, quality: 88 }, // alias kept so any old ?s=thumb links still look ok
  hero: { width: 1600, quality: 86 },
};

async function servePoster(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  origin: string | null,
): Promise<Response> {
  const url = new URL(req.url);
  const key = decodeURIComponent(url.pathname.slice('/poster/'.length));
  if (!key) return new Response('not found', { status: 404 });

  const size = url.searchParams.get('s') || '';
  const preset = POSTER_SIZES[size];
  const cacheHeaders = {
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...cors(origin),
  };

  // Edge-cache resized variants (key includes ?s=). Full originals stream from R2 each
  // time but browsers still honor Cache-Control on the response.
  if (preset) {
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) {
      // Re-apply CORS for the current Origin without re-transforming.
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(cors(origin))) headers.set(k, v);
      return new Response(hit.body, { status: hit.status, headers });
    }

    const obj = await env.POSTERS.get(key);
    if (!obj) return new Response('not found', { status: 404 });

    try {
      const result = await env.IMAGES
        .input(obj.body)
        .transform({ width: preset.width, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: preset.quality });
      const out = new Response(result.image(), {
        headers: {
          'Content-Type': result.contentType(),
          ...cacheHeaders,
          'X-Poster-Size': size,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    } catch (e) {
      // Transform unavailable / bad input → fall through to full original.
      console.log('poster transform failed', size, String(e));
      const again = await env.POSTERS.get(key);
      if (!again) return new Response('not found', { status: 404 });
      return new Response(again.body, {
        headers: {
          'Content-Type': again.httpMetadata?.contentType ?? 'image/png',
          ...cacheHeaders,
        },
      });
    }
  }

  const obj = await env.POSTERS.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
      ...cacheHeaders,
    },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const p = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    // Posters from R2. Full-res by default; ?s=thumb|hero runs through the Images binding
    // so the rail/hero don't pull 10–14 MB PNGs. Transformed responses are edge-cached.
    if (p.startsWith('/poster/')) {
      return servePoster(req, env, ctx, origin);
    }

    // Chat agent (WebSocket + HTTP). Same APP_TOKEN gate as /api/ — browsers can't set
    // headers on a WebSocket, so the ?token= query-param path of authed() is the one that
    // matters here. routeAgentRequest maps /agents/summary-chat/<name> onto the SummaryChat
    // binding and hands the request to the DO instance named <name>.
    if (p.startsWith('/agents/')) {
      if (!authed(req, env)) return json({ error: 'unauthorized' }, { status: 401 }, origin);
      const routed = await routeAgentRequest(req, env);
      return routed ?? json({ error: 'not found' }, { status: 404 }, origin);
    }

    if (p === '/wiki' || p.startsWith('/wiki/')) {
      // Every /wiki/* deep link serves the SPA. Ask the asset binding for "/wiki", not
      // "/wiki.html": the latter answers with a 307 to /wiki and loses the path.
      return env.ASSETS.fetch(new Request(new URL('/wiki', url), req));
    }
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);

    if (!authed(req, env)) return json({ error: 'unauthorized' }, { status: 401 }, origin);

    try {
      // --- config ---
      if (p === '/api/models' && req.method === 'GET') {
        return json({ models: listModels(), defaultModelId: DEFAULT_MODEL_ID, defaultPrompt: DEFAULT_PROMPT }, {}, origin);
      }

      if (p === '/api/prefs' && req.method === 'GET') {
        const rows = await env.DB.prepare('SELECT key, value FROM prefs').all<{ key: string; value: string }>();
        const out: Record<string, string> = {};
        for (const r of rows.results ?? []) out[r.key] = r.value;
        return json({ prefs: out }, {}, origin);
      }

      if (p === '/api/prefs' && req.method === 'POST') {
        const body = (await req.json()) as Record<string, string>;
        for (const [k, v] of Object.entries(body)) {
          await env.DB.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .bind(k, String(v)).run();
        }
        return json({ ok: true }, {}, origin);
      }

      // --- start a job ---
      if (p === '/api/summarize' && req.method === 'POST') {
        const b = (await req.json()) as {
          url: string; title?: string; kind?: 'video' | 'page';
          videoId?: string; text: string; modelId?: string; prompt?: string; noPoster?: boolean;
        };
        if (!b.url || !b.text?.trim()) return json({ error: 'url and text required' }, { status: 400 }, origin);

        const id = normUrl(b.url);
        // Fall back to the remembered default so every entry point (including a feed tile,
        // which can't know the pref) honours the picker's choice.
        let modelId = b.modelId;
        if (!modelId) {
          const r = await env.DB.prepare("SELECT value FROM prefs WHERE key='defaultModel'").first<{ value: string }>();
          modelId = r?.value ?? DEFAULT_MODEL_ID;
        }
        const stub = env.JOB.get(env.JOB.idFromName(id));
        const res = await stub.start({
          id, url: b.url, title: b.title ?? b.url, kind: b.kind ?? 'page',
          videoId: b.videoId, source: b.text, modelId, prompt: b.prompt, noPoster: b.noPoster,
        });
        return json(res, {}, origin);
      }

      // --- job routes ---
      const jobMatch = p.match(/^\/api\/job\/(.+?)(\/stream|\/followup|\/regenerate)?$/);
      if (jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        const sub = jobMatch[2];
        const stub = env.JOB.get(env.JOB.idFromName(id));

        if (sub === '/stream') {
          return stub.fetch(new Request(`https://do/stream`, { headers: req.headers, signal: req.signal }));
        }
        if (sub === '/followup' && req.method === 'POST') {
          const { question } = (await req.json()) as { question: string };
          return json(await stub.followup(question), {}, origin);
        }
        if (sub === '/regenerate' && req.method === 'POST') {
          const { modelId, prompt } = (await req.json()) as { modelId: string; prompt?: string };
          await env.DB.prepare("INSERT INTO prefs (key,value) VALUES ('defaultModel',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(modelId).run();
          return json(await stub.regenerate(modelId, prompt), {}, origin);
        }
        if (req.method === 'GET') {
          return json({ job: await stub.snapshot() }, {}, origin);
        }
      }

      // --- backfill import ---
      // Writes D1 directly, deliberately bypassing the Durable Object: these transcripts
      // already HAVE summaries and posters, so routing them through the job path would
      // re-run the LLM and re-render fal for content that already exists. Idempotent by
      // summary id, so re-running the backfill is safe.
      if (p === '/api/import' && req.method === 'POST') {
        const b = (await req.json()) as {
          url: string; title?: string; channel?: string; videoId?: string;
          transcript: string; summary?: string; createdAt?: number;
          posterKey?: string; modelName?: string; modelIcon?: string;
        };
        if (!b.url || !b.transcript) return json({ error: 'url and transcript required' }, { status: 400 }, origin);
        const id = normUrl(b.url);
        const ts = b.createdAt ?? Date.now();

        await env.DB.prepare(
          `INSERT INTO summaries (id, url, title, kind, video_id, transcript, created_at, updated_at)
           VALUES (?, ?, ?, 'video', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, transcript=excluded.transcript, updated_at=excluded.updated_at`,
        ).bind(id, b.url, b.title ?? b.url, b.videoId ?? null, b.transcript, ts, ts).run();

        if (b.summary?.trim()) {
          await env.DB.prepare(
            `INSERT INTO generations (id, summary_id, model_id, model_name, model_icon, prompt, content, state, created_at, updated_at)
             VALUES (?, ?, 'imported', ?, ?, '', ?, 'complete', ?, ?)
             ON CONFLICT(summary_id, model_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
          ).bind(`${id}::imported`, id, b.modelName ?? 'Imported', b.modelIcon ?? '📦', b.summary, ts, ts).run();
        }

        if (b.posterKey) {
          await env.DB.prepare(
            `INSERT INTO posters (id, summary_id, r2_key, state, created_at, updated_at)
             VALUES (?, ?, ?, 'complete', ?, ?)
             ON CONFLICT(id) DO UPDATE SET r2_key=excluded.r2_key, state='complete', updated_at=excluded.updated_at`,
          ).bind(id, id, b.posterKey, ts, ts).run();
        }
        await env.WIKI_INGEST.send({ sourceId: id });
        return json({ ok: true, id }, {}, origin);
      }

      // Full record for the reading view: whole summary text, not the list excerpt.
      if (p.startsWith('/api/summary/') && req.method === 'GET') {
        const id = decodeURIComponent(p.slice('/api/summary/'.length));
        const s = await env.DB.prepare('SELECT * FROM summaries WHERE id = ?').bind(id).first();
        if (!s) return json({ error: 'not found' }, { status: 404 }, origin);
        const gens = await env.DB.prepare(
          'SELECT model_id, model_name, model_icon, content, state, duration_ms FROM generations WHERE summary_id = ?',
        ).bind(id).all();
        const poster = await env.DB.prepare('SELECT r2_key, state FROM posters WHERE summary_id = ?').bind(id).first();
        return json({ summary: s, generations: gens.results ?? [], poster: poster ?? null }, {}, origin);
      }

      // --- history ---
      if (p === '/api/summaries' && req.method === 'GET') {
        // ONE row per summary. A plain LEFT JOIN against generations fans out — a page
        // summarized with two models (or a live run plus a backfilled import of the same
        // video) returned one rail entry per generation and looked like duplicates. Pick a
        // single preferred generation per summary: a real run beats an import, then newest.
        const rows = await env.DB.prepare(
          `SELECT s.id, s.url, s.title, s.kind, s.video_id, s.created_at, s.updated_at,
                  g.model_id, g.model_name, g.model_icon, g.state AS gen_state, g.duration_ms,
                  substr(g.content, 1, 240) AS excerpt, length(g.content) AS content_len,
                  p.state AS poster_state, p.r2_key AS poster_key
           FROM summaries s
           LEFT JOIN (
             SELECT *, ROW_NUMBER() OVER (
               PARTITION BY summary_id
               ORDER BY (model_id = 'imported') ASC, updated_at DESC
             ) AS rn
             FROM generations
           ) g ON g.summary_id = s.id AND g.rn = 1
           LEFT JOIN posters p ON p.summary_id = s.id
           ORDER BY s.updated_at DESC LIMIT 1000`,
        ).all();
        return json({ summaries: rows.results ?? [] }, {}, origin);
      }

      if (p.startsWith('/api/summaries/') && req.method === 'DELETE') {
        const id = decodeURIComponent(p.slice('/api/summaries/'.length));
        await dropCard(env, id);
        await env.DB.prepare('DELETE FROM summaries WHERE id = ?').bind(id).run();
        return json({ ok: true }, {}, origin);
      }

      // --- wiki (step 1: cards) ---
      // Enqueue sources for card extraction. {ids:[...]} or {limit:N} (newest first, only
      // sources without a card unless force). Backfill and, later, live ingest use this queue.
      if (p === '/api/wiki/enqueue' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) as { ids?: string[]; limit?: number; force?: boolean };
        let ids = b.ids ?? [];
        if (!ids.length) {
          const rows = await env.DB.prepare(
            `SELECT s.id FROM summaries s LEFT JOIN cards c ON c.source_id = s.id
             WHERE length(s.transcript) > 0 ${b.force ? '' : 'AND c.source_id IS NULL'}
             ORDER BY s.created_at DESC LIMIT ?`,
          ).bind(Math.min(b.limit ?? 20, 2000)).all<{ id: string }>();
          ids = (rows.results ?? []).map((r) => r.id);
        }
        for (let i = 0; i < ids.length; i += 100) {
          await env.WIKI_INGEST.sendBatch(ids.slice(i, i + 100).map((sourceId) => ({ body: { sourceId, force: b.force } })));
        }
        return json({ enqueued: ids.length }, {}, origin);
      }

      if (p === '/api/wiki/stats' && req.method === 'GET') {
        const s = await env.DB.prepare(
          `SELECT (SELECT COUNT(*) FROM summaries WHERE length(transcript) > 0) AS sources,
                  COUNT(*) AS cards, SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in,
                  SUM(tokens_out) AS tokens_out, AVG(duration_ms) AS avg_ms,
                  (SELECT COUNT(*) FROM claims) AS claims,
                  (SELECT AVG(quote_ok) FROM claims) AS quote_ok_rate,
                  (SELECT COUNT(DISTINCT name) FROM mentions) AS entities
           FROM cards`,
        ).first();
        return json(s, {}, origin);
      }

      if (p.startsWith('/api/wiki/')) {
        const r = await wikiApi(req, env, p, url, (d, i) => json(d, i, origin));
        if (r) return r;
      }

      if (p === '/api/wiki/card' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? '';
        const card = await env.DB.prepare('SELECT * FROM cards WHERE source_id = ?').bind(id).first();
        const claims = await env.DB.prepare('SELECT * FROM claims WHERE source_id = ? ORDER BY idx').bind(id).all();
        const mentions = await env.DB.prepare('SELECT * FROM mentions WHERE source_id = ?').bind(id).all();
        return json({ card, claims: claims.results, mentions: mentions.results }, {}, origin);
      }

      return json({ error: 'not found' }, { status: 404 }, origin);
    } catch (e) {
      return json({ error: String(e) }, { status: 500 }, origin);
    }
  },

  async queue(batch: MessageBatch<IngestMsg>, env: Env) {
    await handleIngestBatch(batch, env);
  },

  // Weekly wiki gardeners (wrangler.jsonc triggers.crons).
  async scheduled(_c: ScheduledController, env: Env) {
    const inst = await env.WIKI_GARDEN.create({});
    console.log('wiki garden started', inst.id);
  },
} satisfies ExportedHandler<Env, IngestMsg>;
