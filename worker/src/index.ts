import { SummaryJob, type Env } from './job';
import { listModels, DEFAULT_MODEL_ID, DEFAULT_PROMPT } from './config';

export { SummaryJob };

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    const p = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    // Posters are served from R2 as plain images. This is what deletes the sips downscale
    // hack: that existed only to squeeze a 4K poster under Chrome's ~1MB native-message
    // cap. Over HTTPS the browser just streams the full-res original.
    if (p.startsWith('/poster/')) {
      const key = decodeURIComponent(p.slice('/poster/'.length));
      const obj = await env.POSTERS.get(key);
      if (!obj) return new Response('not found', { status: 404 });
      return new Response(obj.body, {
        headers: {
          'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable',
          ...cors(origin),
        },
      });
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
          videoId?: string; text: string; modelId?: string; prompt?: string;
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
          videoId: b.videoId, source: b.text, modelId, prompt: b.prompt,
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
        await env.DB.prepare('DELETE FROM summaries WHERE id = ?').bind(id).run();
        return json({ ok: true }, {}, origin);
      }

      return json({ error: 'not found' }, { status: 404 }, origin);
    } catch (e) {
      return json({ error: String(e) }, { status: 500 }, origin);
    }
  },
} satisfies ExportedHandler<Env>;
