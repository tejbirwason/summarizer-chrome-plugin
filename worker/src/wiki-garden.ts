import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './job';
import { MODEL_EDITOR, llmJSON, embed, cosine } from './wiki-llm';
import { judgePairs, schedulePages, pageSlug, loadTaxonomy, type Ent } from './wiki-graph';

// Weekly gardeners. They never restructure the wiki silently: merges, new topics and
// contradictions become proposals in the review queue. Only the digest is written directly.

const RETRY = { retries: { limit: 2, delay: '30 seconds' as const, backoff: 'exponential' as const }, timeout: '15 minutes' as const };
const WEEK = 7 * 24 * 3600 * 1000;

export class WikiGarden extends WorkflowEntrypoint<Env, Record<string, never>> {
  async run(_e: WorkflowEvent<Record<string, never>>, step: WorkflowStep) {
    const db = this.env.DB;
    const since = Date.now() - WEEK;

    // 1. Merge proposer: entities that have pages and look alike.
    await step.do('merge proposer', RETRY, async () => {
      const ents = (await db.prepare(
        `SELECT e.id, e.name, e.kind, e.context FROM entities e JOIN pages p ON p.ref = e.id AND p.kind = e.kind`,
      ).all<Ent>()).results ?? [];
      const rejected = new Set(((await db.prepare(`SELECT id FROM proposals WHERE kind = 'merge'`).all<{ id: string }>()).results ?? []).map((r) => r.id));
      const vecs = await embed(this.env, ents.map((e) => `${e.name} (${e.kind}): ${e.context ?? ''}`));
      const pairs: [Ent, Ent, number][] = [];
      for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
        const s = cosine(vecs[i], vecs[j]);
        if (s >= 0.82 && !rejected.has(`merge:${ents[i].id}:${ents[j].id}`)) pairs.push([ents[i], ents[j], s]);
      }
      pairs.sort((a, b) => b[2] - a[2]);
      const top = pairs.slice(0, 80);
      let made = 0;
      for (let i = 0; i < top.length; i += 40) {
        const chunk = top.slice(i, i + 40);
        const j = await judgePairs(this.env, chunk.map(([a, b]) => [a, b]));
        const stmts = chunk.flatMap(([a, b, s], k) => j.verdicts[k] === 'different' ? [] : [db.prepare(
          `INSERT OR IGNORE INTO proposals (id, kind, title, detail, payload, created_at) VALUES (?, 'merge', ?, ?, ?, ?)`,
        ).bind(`merge:${a.id}:${b.id}`, `Merge "${b.name}" into "${a.name}"?`,
          `${a.name} — ${a.context ?? a.kind}\n${b.name} — ${b.context ?? b.kind}\nsimilarity ${s.toFixed(2)}; judge said ${j.verdicts[k]}`,
          JSON.stringify({ keep: a.id, drop: b.id }), Date.now())]);
        made += stmts.length;
        if (stmts.length) await db.batch(stmts);
      }
      return made;
    });

    // 2. Contradiction finder on the busiest pages changed this week.
    const pages = await step.do('pick pages for contradictions', async () =>
      ((await db.prepare(
        `SELECT slug FROM pages WHERE kind != 'note' AND source_count >= 4 ORDER BY (updated_at > ?) DESC, source_count DESC LIMIT 10`,
      ).bind(since).all<{ slug: string }>()).results ?? []).map((r) => r.slug));
    for (const slug of pages) {
      await step.do(`contradictions ${slug}`, RETRY, async () => {
        const page = await db.prepare('SELECT title, body_md FROM pages WHERE slug = ?').bind(slug).first<{ title: string; body_md: string }>();
        const claims = (await db.prepare(
          `SELECT c.id, c.text, c.speaker, s.title, s.created_at FROM page_sources ps
           JOIN claims c ON c.source_id = ps.source_id JOIN summaries s ON s.id = c.source_id
           WHERE ps.page_slug = ? AND c.kind IN ('opinion','prediction','fact','advice') LIMIT 400`,
        ).bind(slug).all<{ id: string; text: string; speaker: string; title: string; created_at: number }>()).results ?? [];
        if (!page || claims.length < 6) return 0;
        const r = await llmJSON<{ items: { headline: string; side_a: string; side_b: string; claim_ids: string[] }[] }>(
          this.env, MODEL_EDITOR,
          [{ role: 'user', content:
`Find GENUINE disagreements between sources on the wiki page "${page.title}": two sources making claims that can't both be right, or advice pointing opposite ways. Skip differences of emphasis. Skip anything the current page already covers under "Disagreements". Return 0-3 items.

Current page:
${page.body_md ?? ''}

Claims (id | speaker | source | date | text):
${claims.map((c) => `${c.id} | ${c.speaker ?? '-'} | ${c.title} | ${new Date(c.created_at).toISOString().slice(0, 10)} | ${c.text}`).join('\n')}` }],
          {
            type: 'object', additionalProperties: false, required: ['items'],
            properties: { items: { type: 'array', items: {
              type: 'object', additionalProperties: false, required: ['headline', 'side_a', 'side_b', 'claim_ids'],
              properties: { headline: { type: 'string' }, side_a: { type: 'string' }, side_b: { type: 'string' }, claim_ids: { type: 'array', items: { type: 'string' } } },
            } } },
          },
          { maxTokens: 3000 },
        );
        const ok = new Set(claims.map((c) => c.id));
        const stmts = r.data.items.map((it, i) => db.prepare(
          `INSERT OR IGNORE INTO proposals (id, kind, title, detail, payload, created_at) VALUES (?, 'contradiction', ?, ?, ?, ?)`,
        ).bind(`contra:${slug}:${Date.now()}:${i}`, `${page.title}: ${it.headline}`, `${it.side_a}\nvs.\n${it.side_b}`,
          JSON.stringify({ slug, note: `Add to Disagreements: ${it.headline}. Side A: ${it.side_a} Side B: ${it.side_b}`, claim_ids: it.claim_ids.filter((c) => ok.has(c)) }),
          Date.now()));
        if (stmts.length) await db.batch(stmts);
        return stmts.length;
      });
    }

    // 3. Gap finder: raw tags the taxonomy dropped, that keep coming back.
    await step.do('gap finder', RETRY, async () => {
      const dropped = (await db.prepare(
        `SELECT j.value t, COUNT(*) n FROM cards c, json_each(c.topics) j JOIN topic_map tm ON tm.raw = j.value
         WHERE tm.topic = '' GROUP BY j.value ORDER BY n DESC LIMIT 300`,
      ).all<{ t: string; n: number }>()).results ?? [];
      if (!dropped.length) return 0;
      const tax = await loadTaxonomy(this.env);
      const r = await llmJSON<{ topics: { slug: string; title: string; group: string; description: string; raw_tags: string[] }[] }>(
        this.env, MODEL_EDITOR,
        [{ role: 'user', content:
`These raw topic tags (with source counts) matched nothing in the wiki's taxonomy. Propose 0-5 NEW topics that would each gather 3+ sources from them. Don't duplicate existing topics.

Existing topics: ${tax.map((t) => t.slug).join(', ')}

Unmatched tags:
${dropped.map((d) => `${d.t}: ${d.n}`).join('\n')}` }],
        {
          type: 'object', additionalProperties: false, required: ['topics'],
          properties: { topics: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['slug', 'title', 'group', 'description', 'raw_tags'],
            properties: { slug: { type: 'string' }, title: { type: 'string' }, group: { type: 'string' }, description: { type: 'string' }, raw_tags: { type: 'array', items: { type: 'string' } } },
          } } },
        },
        { maxTokens: 3000 },
      );
      const counts = new Map(dropped.map((d) => [d.t, d.n]));
      const stmts = r.data.topics
        .map((t) => ({ ...t, raw_tags: t.raw_tags.filter((x) => counts.has(x)) }))
        .filter((t) => t.raw_tags.reduce((a, x) => a + (counts.get(x) ?? 0), 0) >= 3)
        .map((t) => db.prepare(
          `INSERT OR IGNORE INTO proposals (id, kind, title, detail, payload, created_at) VALUES (?, 'new_page', ?, ?, ?, ?)`,
        ).bind(`topic:${t.slug}`, `New topic: ${t.title}`, `${t.description}\nFrom tags: ${t.raw_tags.join(', ')}`, JSON.stringify(t), Date.now()));
      if (stmts.length) await db.batch(stmts);
      return stmts.length;
    });

    // 4. Weekly digest.
    await step.do('digest', RETRY, async () => {
      const revs = (await db.prepare(
        `SELECT r.page_slug, p.title, MAX(r.rev) rev, COUNT(*) n FROM page_revisions r JOIN pages p ON p.slug = r.page_slug
         WHERE r.created_at > ? GROUP BY r.page_slug ORDER BY n DESC LIMIT 40`,
      ).bind(since).all<{ page_slug: string; title: string; rev: number; n: number }>()).results ?? [];
      const newSources = (await db.prepare('SELECT title FROM summaries WHERE created_at > ? ORDER BY created_at DESC LIMIT 40').bind(since).all<{ title: string }>()).results ?? [];
      const props = (await db.prepare(`SELECT title FROM proposals WHERE status = 'open' ORDER BY created_at DESC LIMIT 20`).all<{ title: string }>()).results ?? [];
      if (!revs.length && !newSources.length) return 0;
      const changed = await Promise.all(revs.slice(0, 15).map(async (r) => {
        const prev = await db.prepare('SELECT summary FROM page_revisions WHERE page_slug = ? AND created_at <= ? ORDER BY rev DESC LIMIT 1').bind(r.page_slug, since).first<{ summary: string }>();
        const cur = await db.prepare('SELECT summary FROM pages WHERE slug = ?').bind(r.page_slug).first<{ summary: string }>();
        return `${r.page_slug} | ${r.title} | before: ${prev?.summary ?? '(new page)'} | now: ${cur?.summary ?? ''}`;
      }));
      const r = await llmJSON<{ body_md: string }>(this.env, MODEL_EDITOR, [{ role: 'user', content:
`Write this week's short digest for the owner of a personal wiki (max 150 words, markdown bullets). Lead with what actually shifted in their knowledge, not counts. Link pages as [[p:slug]] using only slugs below.

New sources this week (${newSources.length}): ${newSources.map((s) => s.title).join('; ')}

Pages that changed (slug | title | summary before | now):
${changed.join('\n')}

Open proposals awaiting review: ${props.length}` }],
        { type: 'object', additionalProperties: false, required: ['body_md'], properties: { body_md: { type: 'string' } } },
        { maxTokens: 1500 });
      await db.prepare('INSERT INTO digests (body_md, created_at) VALUES (?, ?)').bind(r.data.body_md, Date.now()).run();
      return 1;
    });

    return { ok: true };
  }
}

/** Apply an approved proposal. */
export async function applyProposal(env: Env, id: string) {
  const db = env.DB;
  const p = await db.prepare('SELECT * FROM proposals WHERE id = ?').bind(id).first<{ id: string; kind: string; payload: string; status: string }>();
  if (!p) throw new Error('no such proposal');
  if (p.status !== 'open') return { id, status: p.status };
  const pl = JSON.parse(p.payload);
  const touched: string[] = [];

  if (p.kind === 'merge') {
    const keep = await db.prepare('SELECT id, name, kind FROM entities WHERE id = ?').bind(pl.keep).first<Ent>();
    const drop = await db.prepare('SELECT id, name, kind FROM entities WHERE id = ?').bind(pl.drop).first<Ent>();
    if (keep && drop) {
      const keepSlug = pageSlug(keep.kind, keep.id);
      await db.batch([
        db.prepare('UPDATE entity_alias SET entity_id = ? WHERE entity_id = ?').bind(keep.id, drop.id),
        db.prepare('DELETE FROM entities WHERE id = ?').bind(drop.id),
        db.prepare(`INSERT OR IGNORE INTO pages (slug, kind, ref, title, dirty, updated_at) VALUES (?, ?, ?, ?, 1, ?)`).bind(keepSlug, keep.kind, keep.id, keep.name, Date.now()),
        db.prepare(
          `INSERT OR IGNORE INTO page_sources (page_slug, source_id)
           SELECT DISTINCT ?, m.source_id FROM mentions m JOIN entity_alias a ON a.alias = m.norm WHERE a.entity_id = ?`,
        ).bind(keepSlug, keep.id),
        db.prepare('DELETE FROM page_sources WHERE page_slug = ?').bind(pageSlug(drop.kind, drop.id)),
        db.prepare('DELETE FROM pages WHERE slug = ?').bind(pageSlug(drop.kind, drop.id)),
        db.prepare('DELETE FROM pages_fts WHERE slug = ?').bind(pageSlug(drop.kind, drop.id)),
      ]);
      touched.push(keepSlug);
    }
  } else if (p.kind === 'contradiction') {
    const page = await db.prepare('SELECT notes FROM pages WHERE slug = ?').bind(pl.slug).first<{ notes: string | null }>();
    if (page) {
      const notes = [...JSON.parse(page.notes ?? '[]'), pl.note];
      await db.prepare('UPDATE pages SET notes = ?, dirty = 1 WHERE slug = ?').bind(JSON.stringify(notes), pl.slug).run();
      touched.push(pl.slug);
    }
  } else if (p.kind === 'new_page') {
    const slug = String(pl.slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const ps = pageSlug('topic', slug);
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO topics (slug, title, grp, description) VALUES (?, ?, ?, ?)').bind(slug, pl.title, pl.group, pl.description),
      ...pl.raw_tags.map((t: string) => db.prepare('INSERT OR REPLACE INTO topic_map (raw, topic) VALUES (?, ?)').bind(t, slug)),
      db.prepare(`INSERT OR IGNORE INTO pages (slug, kind, ref, title, dirty, updated_at) VALUES (?, 'topic', ?, ?, 1, ?)`).bind(ps, slug, pl.title, Date.now()),
      db.prepare(
        `INSERT OR IGNORE INTO page_sources (page_slug, source_id)
         SELECT DISTINCT ?, c.source_id FROM cards c, json_each(c.topics) j JOIN topic_map tm ON tm.raw = j.value WHERE tm.topic = ?`,
      ).bind(ps, slug),
    ]);
    touched.push(ps);
  } else if (p.kind === 'note') {
    const slug = pageSlug('note', String(pl.slug));
    const now = Date.now();
    await db.batch([
      db.prepare(`INSERT OR REPLACE INTO pages (slug, kind, ref, title, summary, body_md, rev, dirty, updated_at) VALUES (?, 'note', ?, ?, ?, ?, 1, 0, ?)`)
        .bind(slug, pl.slug, pl.title, pl.summary ?? '', pl.body_md, now),
      db.prepare(`INSERT INTO page_revisions (page_slug, rev, body_md, summary, model, reason, created_at) VALUES (?, 1, ?, ?, 'chat', 'saved from chat', ?)`)
        .bind(slug, pl.body_md, pl.summary ?? '', now),
      db.prepare('INSERT INTO pages_fts (slug, title, body) VALUES (?, ?, ?)').bind(slug, pl.title, pl.body_md.replace(/\[\[[cp]:[^\]]+\]\]/g, '')),
    ]);
  }

  await db.prepare(`UPDATE proposals SET status = 'approved', decided_at = ? WHERE id = ?`).bind(Date.now(), id).run();
  for (const s of touched) {
    await db.prepare('UPDATE pages SET source_count = (SELECT COUNT(*) FROM page_sources WHERE page_slug = ?) WHERE slug = ?').bind(s, s).run();
  }
  await schedulePages(env, touched, 5000);
  return { id, status: 'approved', touched };
}
