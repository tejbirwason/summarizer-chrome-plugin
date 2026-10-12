import type { Env } from './job';
import {
  MODEL_FAST, llmJSON, embed, normName, slugify, vecIdEntity, getMeta,
} from './wiki-llm';

// The wiki's graph: canonical topics, canonical entities, and which sources feed which page.
// The bulk build (wiki-build.ts) fills these for the whole corpus; attachSource() does the
// same for one new source on live ingest.

export const TOPIC_MIN_SOURCES = 2;
export const ENTITY_MIN_SOURCES = 3;
export const PAGE_KINDS = ['person', 'org', 'product', 'concept', 'work', 'place'];
export const LIVE_DEBOUNCE_MS = 10 * 60 * 1000;

export const pageSlug = (kind: string, ref: string) => `${kind}/${ref}`;

export async function loadTaxonomy(env: Env) {
  const rows = await env.DB.prepare('SELECT slug, title, grp, description FROM topics ORDER BY grp, title')
    .all<{ slug: string; title: string; grp: string; description: string }>();
  return rows.results ?? [];
}

/** Map raw card topic slugs onto the canonical taxonomy with the fast model. */
export async function mapRawTopics(env: Env, raws: string[], taxonomy: { slug: string; title: string; description: string }[]) {
  if (!raws.length || !taxonomy.length) return { map: {} as Record<string, string>, cost: 0 };
  const allowed = [...taxonomy.map((t) => t.slug), 'none'];
  const r = await llmJSON<{ map: { raw: string; topic: string }[] }>(
    env, MODEL_FAST,
    [{
      role: 'user',
      content:
        `Map each raw topic tag onto the best matching topic in this taxonomy, or "none" if nothing fits well.\n\n` +
        `Taxonomy:\n${taxonomy.map((t) => `${t.slug}: ${t.title} — ${t.description}`).join('\n')}\n\n` +
        `Raw tags:\n${raws.join('\n')}`,
    }],
    {
      type: 'object', additionalProperties: false, required: ['map'],
      properties: {
        map: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['raw', 'topic'],
            properties: { raw: { type: 'string' }, topic: { type: 'string', enum: allowed } },
          },
        },
      },
    },
    { maxTokens: 16000 },
  );
  const want = new Set(raws);
  const map: Record<string, string> = {};
  for (const m of r.data.map) if (want.has(m.raw)) map[m.raw] = m.topic === 'none' ? '' : m.topic;
  return { map, cost: r.cost };
}

/** Pick an unused entity id for a display name. */
export async function freeEntityId(env: Env, name: string, kind: string) {
  const base = slugify(name);
  for (const cand of [base, `${base}-${kind}`, `${base}-${kind}-2`, `${base}-${Date.now().toString(36)}`]) {
    const hit = await env.DB.prepare('SELECT 1 FROM entities WHERE id = ?').bind(cand).first();
    if (!hit) return cand;
  }
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['i', 'verdict'],
        properties: { i: { type: 'integer' }, verdict: { type: 'string', enum: ['same', 'different', 'unsure'] } },
      },
    },
  },
};

export interface Ent { id: string; name: string; kind: string; context: string | null }

/** Ask the fast model whether pairs of entities are the same real-world thing. */
export async function judgePairs(env: Env, pairs: [Ent, Ent][]) {
  if (!pairs.length) return { verdicts: [] as string[], cost: 0 };
  const r = await llmJSON<{ decisions: { i: number; verdict: string }[] }>(
    env, MODEL_FAST,
    [{
      role: 'user',
      content:
        `Each line is a pair of names extracted from video transcripts. Decide if both refer to the SAME real-world ` +
        `person/organization/product/concept (aliases, nicknames, misspellings, abbreviations), or DIFFERENT things ` +
        `(e.g. a company vs its product, a product vs its newer version, two different people). Use "unsure" only when ` +
        `the context really can't tell.\n\n` +
        pairs.map(([a, b], i) => `${i}. "${a.name}" (${a.kind}: ${a.context ?? '?'})  vs  "${b.name}" (${b.kind}: ${b.context ?? '?'})`).join('\n'),
    }],
    JUDGE_SCHEMA,
    { maxTokens: 4000 },
  );
  const verdicts = pairs.map(() => 'unsure');
  for (const d of r.data.decisions) if (d.i >= 0 && d.i < pairs.length) verdicts[d.i] = d.verdict;
  return { verdicts, cost: r.cost };
}

async function ensurePage(env: Env, kind: string, ref: string, title: string) {
  const slug = pageSlug(kind, ref);
  await env.DB.prepare(
    `INSERT INTO pages (slug, kind, ref, title, dirty, updated_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(slug) DO NOTHING`,
  ).bind(slug, kind, ref, title, Date.now()).run();
  return slug;
}

export async function refreshPageCounts(env: Env, slugs: string[]) {
  if (!slugs.length) return;
  await env.DB.batch(slugs.map((s) => env.DB.prepare(
    'UPDATE pages SET source_count = (SELECT COUNT(*) FROM page_sources WHERE page_slug = ?), dirty = 1 WHERE slug = ?',
  ).bind(s, s)));
}

export async function schedulePages(env: Env, slugs: string[], delayMs: number) {
  for (const s of slugs) {
    await env.WIKI_PAGE.get(env.WIKI_PAGE.idFromName(s)).schedule(s, delayMs);
  }
}

/** Index one source's claims for search: FTS + vectors. */
export async function indexClaims(env: Env, sourceId: string) {
  const rows = await env.DB.prepare('SELECT id, text FROM claims WHERE source_id = ?').bind(sourceId).all<{ id: string; text: string }>();
  const claims = rows.results ?? [];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM claims_fts WHERE source_id = ?').bind(sourceId),
    ...claims.map((c) => env.DB.prepare('INSERT INTO claims_fts (id, source_id, text) VALUES (?, ?, ?)').bind(c.id, sourceId, c.text)),
  ]);
  if (!claims.length) return;
  const vecs = await embed(env, claims.map((c) => c.text));
  await env.WIKI_VEC.upsert(claims.map((c, i) => ({ id: c.id, values: vecs[i], metadata: { type: 'claim', source_id: sourceId } })));
}

/**
 * Live ingest: route one freshly-carded source into the wiki. Maps its topics, resolves its
 * entity mentions (exact alias → vector neighbour + LLM judge → new entity), attaches it to
 * every affected page, and schedules a debounced rewrite of those pages.
 */
export async function attachSource(env: Env, sourceId: string) {
  if ((await getMeta(env, 'built')) !== '1') return { sourceId, routed: 'wiki not built yet' };
  let cost = 0;
  const touched = new Set<string>();

  // --- topics ---
  const card = await env.DB.prepare('SELECT topics FROM cards WHERE source_id = ?').bind(sourceId).first<{ topics: string }>();
  const raws: string[] = JSON.parse(card?.topics ?? '[]');
  const known = raws.length
    ? (await env.DB.prepare(`SELECT raw, topic FROM topic_map WHERE raw IN (${raws.map(() => '?').join(',')})`).bind(...raws).all<{ raw: string; topic: string }>()).results ?? []
    : [];
  const topicOf: Record<string, string> = Object.fromEntries(known.map((k) => [k.raw, k.topic]));
  const unknown = raws.filter((r) => !(r in topicOf));
  if (unknown.length) {
    const m = await mapRawTopics(env, unknown, await loadTaxonomy(env));
    cost += m.cost;
    for (const r of unknown) topicOf[r] = m.map[r] ?? '';
    await env.DB.batch(unknown.map((r) => env.DB.prepare('INSERT OR REPLACE INTO topic_map (raw, topic) VALUES (?, ?)').bind(r, topicOf[r])));
  }
  for (const t of new Set(Object.values(topicOf).filter(Boolean))) {
    const slug = pageSlug('topic', t);
    await env.DB.prepare('INSERT OR IGNORE INTO page_sources (page_slug, source_id) VALUES (?, ?)').bind(slug, sourceId).run();
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM page_sources WHERE page_slug = ?').bind(slug).first<{ n: number }>();
    if ((n?.n ?? 0) >= TOPIC_MIN_SOURCES) {
      const topic = await env.DB.prepare('SELECT title FROM topics WHERE slug = ?').bind(t).first<{ title: string }>();
      if (topic) touched.add(await ensurePage(env, 'topic', t, topic.title));
    }
  }

  // --- entities ---
  const ms = (await env.DB.prepare('SELECT name, kind, context FROM mentions WHERE source_id = ?').bind(sourceId)
    .all<{ name: string; kind: string; context: string | null }>()).results ?? [];
  await env.DB.batch(ms.map((m) => env.DB.prepare('UPDATE mentions SET norm = ? WHERE source_id = ? AND name = ?').bind(normName(m.name), sourceId, m.name)));

  for (const m of ms) {
    const norm = normName(m.name);
    if (!norm) continue;
    let entityId = (await env.DB.prepare('SELECT entity_id FROM entity_alias WHERE alias = ?').bind(norm).first<{ entity_id: string }>())?.entity_id;

    if (!entityId) {
      // Only names seen in 2+ sources become entities; one-offs stay as raw mentions.
      const seen = await env.DB.prepare('SELECT COUNT(DISTINCT source_id) n FROM mentions WHERE norm = ?').bind(norm).first<{ n: number }>();
      if ((seen?.n ?? 0) < 2) continue;
      const me: Ent = { id: '', name: m.name, kind: m.kind, context: m.context };
      const [vec] = await embed(env, [`${m.name} (${m.kind}): ${m.context ?? ''}`]);
      const near = await env.WIKI_VEC.query(vec, { topK: 3, filter: { type: 'entity' }, returnMetadata: 'all' });
      const cands = (near.matches ?? []).filter((x) => x.score >= 0.8 && x.metadata?.entity_id);
      for (const c of cands) {
        const other = await env.DB.prepare('SELECT id, name, kind, context FROM entities WHERE id = ?').bind(String(c.metadata!.entity_id)).first<Ent>();
        if (!other) continue;
        const j = await judgePairs(env, [[me, other]]);
        cost += j.cost;
        if (j.verdicts[0] === 'same') { entityId = other.id; break; }
      }
      if (!entityId) {
        entityId = await freeEntityId(env, m.name, m.kind);
        await env.DB.prepare('INSERT INTO entities (id, name, kind, context) VALUES (?, ?, ?, ?)').bind(entityId, m.name, m.kind, m.context).run();
        await env.WIKI_VEC.upsert([{ id: await vecIdEntity(entityId), values: vec, metadata: { type: 'entity', entity_id: entityId } }]);
      }
      await env.DB.prepare('INSERT OR REPLACE INTO entity_alias (alias, entity_id) VALUES (?, ?)').bind(norm, entityId).run();
    }

    const ent = await env.DB.prepare('SELECT id, name, kind FROM entities WHERE id = ?').bind(entityId).first<Ent>();
    if (!ent || !PAGE_KINDS.includes(ent.kind)) continue;
    const n = await env.DB.prepare(
      `SELECT COUNT(DISTINCT m.source_id) n FROM mentions m JOIN entity_alias a ON a.alias = m.norm WHERE a.entity_id = ?`,
    ).bind(ent.id).first<{ n: number }>();
    if ((n?.n ?? 0) < ENTITY_MIN_SOURCES) continue;
    const slug = await ensurePage(env, ent.kind, ent.id, ent.name);
    // A brand-new page needs every earlier source too, not just this one.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO page_sources (page_slug, source_id)
       SELECT DISTINCT ?, m.source_id FROM mentions m JOIN entity_alias a ON a.alias = m.norm WHERE a.entity_id = ?`,
    ).bind(slug, ent.id).run();
    touched.add(slug);
  }

  await indexClaims(env, sourceId);
  const slugs = [...touched];
  await refreshPageCounts(env, slugs);
  await schedulePages(env, slugs, LIVE_DEBOUNCE_MS);
  return { sourceId, pages: slugs, cost };
}
