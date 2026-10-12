import type { Env } from './job';
import { embed } from './wiki-llm';

// Hybrid search: FTS5 keyword hits + Vectorize semantic hits, merged by reciprocal rank.

export interface PageHit { slug: string; title: string; kind: string; summary: string | null; source_count: number }
export interface ClaimHit {
  id: string; text: string; source_id: string; source_title: string; kind: string;
  speaker: string | null; start_s: number | null; video_id: string | null; url: string;
}

// FTS5 query syntax chokes on punctuation; turn free text into OR'd prefix terms.
function ftsQuery(q: string) {
  const terms = q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(terms)].slice(0, 12).map((t) => `"${t}"*`).join(' OR ');
}

function rrf(lists: string[][], k = 60) {
  const score = new Map<string, number>();
  for (const l of lists) l.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export async function searchWiki(env: Env, q: string, opts: { pages?: number; claims?: number } = {}) {
  const nPages = opts.pages ?? 8, nClaims = opts.claims ?? 15;
  const db = env.DB;
  const fq = ftsQuery(q);
  if (!fq) return { pages: [] as PageHit[], claims: [] as ClaimHit[] };

  const [vec] = await embed(env, [q]);
  const [ftsPages, ftsClaims, vPages, vClaims] = await Promise.all([
    db.prepare('SELECT slug FROM pages_fts WHERE pages_fts MATCH ? ORDER BY bm25(pages_fts, 0, 5, 1) LIMIT 20').bind(fq).all<{ slug: string }>(),
    db.prepare('SELECT id FROM claims_fts WHERE claims_fts MATCH ? ORDER BY bm25(claims_fts) LIMIT 30').bind(fq).all<{ id: string }>(),
    env.WIKI_VEC.query(vec, { topK: 20, filter: { type: 'page' }, returnMetadata: 'all' }),
    env.WIKI_VEC.query(vec, { topK: 30, filter: { type: 'claim' } }),
  ]);

  const pageIds = rrf([
    (ftsPages.results ?? []).map((r) => r.slug),
    (vPages.matches ?? []).map((m) => String(m.metadata?.slug ?? '')).filter(Boolean),
  ]).slice(0, nPages);
  const claimIds = rrf([
    (ftsClaims.results ?? []).map((r) => r.id),
    (vClaims.matches ?? []).map((m) => m.id),
  ]).slice(0, nClaims);

  const pages = pageIds.length
    ? ((await db.prepare(`SELECT slug, title, kind, summary, source_count FROM pages WHERE slug IN (${pageIds.map(() => '?').join(',')})`).bind(...pageIds).all<PageHit>()).results ?? [])
    : [];
  const claims = claimIds.length ? await getClaims(env, claimIds) : [];
  const order = (ids: string[]) => (a: { id?: string; slug?: string }, b: { id?: string; slug?: string }) =>
    ids.indexOf((a.slug ?? a.id)!) - ids.indexOf((b.slug ?? b.id)!);
  return { pages: pages.sort(order(pageIds)), claims: claims.sort(order(claimIds)) };
}

export async function getClaims(env: Env, ids: string[]): Promise<ClaimHit[]> {
  const out: ClaimHit[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = (await env.DB.prepare(
      `SELECT c.id, c.text, c.source_id, s.title source_title, c.kind, c.speaker, c.start_s, s.video_id, s.url
       FROM claims c JOIN summaries s ON s.id = c.source_id WHERE c.id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<ClaimHit>()).results ?? [];
    out.push(...rows);
  }
  return out;
}
