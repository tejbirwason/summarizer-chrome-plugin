import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './job';
import {
  MODEL_LIBRARIAN, llmJSON, embed, cosine, normName, vecIdEntity, setMeta,
} from './wiki-llm';
import {
  mapRawTopics, loadTaxonomy, judgePairs, freeEntityId, schedulePages, pageSlug,
  TOPIC_MIN_SOURCES, ENTITY_MIN_SOURCES, PAGE_KINDS, type Ent,
} from './wiki-graph';
import { approxStart } from './wiki';

// One-time (re-runnable) compile of the whole corpus into the wiki:
//   timestamps → librarian designs the taxonomy → map raw topics → group + merge entities
//   → create pages → keyword + vector index → schedule every page's editor.
// Each step is checkpointed, so a failure resumes where it stopped.

const RETRY = { retries: { limit: 3, delay: '20 seconds' as const, backoff: 'exponential' as const }, timeout: '15 minutes' as const };

export interface BuildParams { skipTaxonomy?: boolean; skipEntities?: boolean; pageStaggerMs?: number }

const TAXONOMY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['slug', 'title', 'group', 'description'],
        properties: { slug: { type: 'string' }, title: { type: 'string' }, group: { type: 'string' }, description: { type: 'string' } },
      },
    },
  },
};

export class WikiBuild extends WorkflowEntrypoint<Env, BuildParams> {
  async run(event: WorkflowEvent<BuildParams>, step: WorkflowStep) {
    const p = event.payload ?? {};
    const db = this.env.DB;
    let cost = 0;

    // 1. Approximate timestamps for claims carded before the column was filled.
    const videoIds = await step.do('list videos needing timestamps', async () => {
      const r = await db.prepare(
        `SELECT DISTINCT c.source_id id FROM claims c JOIN summaries s ON s.id = c.source_id
         WHERE s.kind = 'video' AND c.start_s IS NULL`,
      ).all<{ id: string }>();
      return (r.results ?? []).map((x) => x.id);
    });
    for (let i = 0; i < videoIds.length; i += 60) {
      await step.do(`timestamps ${i}`, RETRY, async () => {
        for (const id of videoIds.slice(i, i + 60)) {
          const s = await db.prepare('SELECT transcript FROM summaries WHERE id = ?').bind(id).first<{ transcript: string }>();
          if (!s?.transcript) continue;
          const hay = s.transcript.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
          const cl = (await db.prepare('SELECT id, quote FROM claims WHERE source_id = ?').bind(id).all<{ id: string; quote: string }>()).results ?? [];
          await db.batch(cl.map((c) => db.prepare('UPDATE claims SET start_s = ? WHERE id = ?').bind(approxStart(hay, s.transcript.length, c.quote ?? ''), c.id)));
        }
        return true;
      });
    }

    // 2. Librarian: design the canonical taxonomy from the raw topic tags.
    if (!p.skipTaxonomy) {
      cost += await step.do('librarian: design taxonomy', RETRY, async () => {
        const raw = (await db.prepare(
          `SELECT value t, COUNT(*) n FROM cards, json_each(cards.topics) GROUP BY value ORDER BY n DESC LIMIT 1500`,
        ).all<{ t: string; n: number }>()).results ?? [];
        const r = await llmJSON<{ topics: { slug: string; title: string; group: string; description: string }[] }>(
          this.env, MODEL_LIBRARIAN,
          [{
            role: 'user',
            content:
`You are the librarian of a personal wiki built from ~1,100 YouTube videos and web articles one person chose to summarize. Below are the raw topic tags an extractor attached to each source, with how many sources carry each tag.

Design the wiki's canonical topic taxonomy:
- 70-140 topics. Each should plausibly gather 3+ sources; merge near-duplicates ("ai-agents", "agentic-ai", "llm-agents"); split only where the owner clearly has depth (many sources).
- Topics are subjects a reader would browse ("Agent memory", "Distributed systems", "Strength training"), not formats ("podcast-interview") or one-off events.
- 8-14 groups (e.g. "AI", "Software engineering", "Business", "Money", "Health", "Society & politics", "Culture", "Science", "Self").
- slug: kebab-case, short. title: Title Case. description: one line saying what belongs here.

Raw tags (tag: count):
${raw.map((x) => `${x.t}: ${x.n}`).join('\n')}`,
          }],
          TAXONOMY_SCHEMA,
          { maxTokens: 24000, effort: 'medium' },
        );
        const seen = new Set<string>();
        const topics = r.data.topics
          .map((t) => ({ ...t, slug: t.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }))
          .filter((t) => t.slug && !seen.has(t.slug) && seen.add(t.slug));
        await db.batch([
          db.prepare('DELETE FROM topics'),
          db.prepare('DELETE FROM topic_map'),
          ...topics.map((t) => db.prepare('INSERT INTO topics (slug, title, grp, description) VALUES (?, ?, ?, ?)').bind(t.slug, t.title, t.group, t.description)),
        ]);
        return r.cost;
      });

      const raws = await step.do('list raw topics', async () => {
        const r = await db.prepare(`SELECT DISTINCT value t FROM cards, json_each(cards.topics)`).all<{ t: string }>();
        return (r.results ?? []).map((x) => x.t);
      });
      for (let i = 0; i < raws.length; i += 200) {
        cost += await step.do(`map topics ${i}`, RETRY, async () => {
          const chunk = raws.slice(i, i + 200);
          const m = await mapRawTopics(this.env, chunk, await loadTaxonomy(this.env));
          await db.batch(chunk.map((r) => db.prepare('INSERT OR REPLACE INTO topic_map (raw, topic) VALUES (?, ?)').bind(r, m.map[r] ?? '')));
          return m.cost;
        });
      }
    }

    // 3. Entities: group mentions by normalized name, then merge aliases with embeddings + a judge.
    if (!p.skipEntities) {
      await step.do('normalize mentions', RETRY, async () => {
        const rows = (await db.prepare('SELECT source_id, name FROM mentions WHERE norm IS NULL').all<{ source_id: string; name: string }>()).results ?? [];
        for (let i = 0; i < rows.length; i += 500) {
          await db.batch(rows.slice(i, i + 500).map((r) => db.prepare('UPDATE mentions SET norm = ? WHERE source_id = ? AND name = ?').bind(normName(r.name), r.source_id, r.name)));
        }
        return rows.length;
      });

      const nEnt = await step.do('create entities', RETRY, async () => {
        // One entity per normalized name seen in 2+ sources; display name/kind = most common.
        const rows = (await db.prepare(
          `SELECT norm, name, kind, context, COUNT(*) n FROM mentions
           WHERE norm IN (SELECT norm FROM mentions WHERE norm != '' GROUP BY norm HAVING COUNT(DISTINCT source_id) >= 2)
           GROUP BY norm, name, kind ORDER BY norm, n DESC`,
        ).all<{ norm: string; name: string; kind: string; context: string | null; n: number }>()).results ?? [];
        const best = new Map<string, (typeof rows)[0]>();
        for (const r of rows) if (!best.has(r.norm)) best.set(r.norm, r);
        await db.batch([db.prepare('DELETE FROM entities'), db.prepare('DELETE FROM entity_alias')]);
        const used = new Set<string>();
        const ents: { id: string; norm: string; r: (typeof rows)[0] }[] = [];
        for (const [norm, r] of best) {
          let id = norm.replace(/ /g, '-').slice(0, 60) || 'x';
          if (used.has(id)) id = `${id}-${r.kind}`;
          while (used.has(id)) id = `${id}-2`;
          used.add(id);
          ents.push({ id, norm, r });
        }
        for (let i = 0; i < ents.length; i += 400) {
          await db.batch(ents.slice(i, i + 400).flatMap((e) => [
            db.prepare('INSERT INTO entities (id, name, kind, context) VALUES (?, ?, ?, ?)').bind(e.id, e.r.name, e.r.kind, e.r.context),
            db.prepare('INSERT INTO entity_alias (alias, entity_id) VALUES (?, ?)').bind(e.norm, e.id),
          ]));
        }
        return ents.length;
      });

      // Embed every entity (also stored in Vectorize for live resolution), then find look-alike pairs.
      const pairs = await step.do('embed entities + find look-alikes', { ...RETRY, timeout: '30 minutes' }, async () => {
        const ents = (await db.prepare('SELECT id, name, kind, context FROM entities ORDER BY id').all<Ent>()).results ?? [];
        const vecs = await embed(this.env, ents.map((e) => `${e.name} (${e.kind}): ${e.context ?? ''}`));
        for (let i = 0; i < ents.length; i += 500) {
          await this.env.WIKI_VEC.upsert(await Promise.all(ents.slice(i, i + 500).map(async (e, j) => ({
            id: await vecIdEntity(e.id), values: vecs[i + j], metadata: { type: 'entity', entity_id: e.id },
          }))));
        }
        const out: { a: Ent; b: Ent; s: number }[] = [];
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const s = cosine(vecs[i], vecs[j]);
            if (s >= 0.83) out.push({ a: ents[i], b: ents[j], s });
          }
        }
        out.sort((x, y) => y.s - x.s);
        return out.slice(0, 1000);
      });
      console.log('wiki build entities', nEnt, 'look-alike pairs', pairs.length);

      const verdicts: string[] = [];
      for (let i = 0; i < pairs.length; i += 40) {
        const r = await step.do(`judge pairs ${i}`, RETRY, async () => {
          const j = await judgePairs(this.env, pairs.slice(i, i + 40).map((x) => [x.a, x.b] as [Ent, Ent]));
          return j;
        });
        cost += r.cost;
        verdicts.push(...r.verdicts);
      }

      await step.do('merge entities', RETRY, async () => {
        // Union-find over "same" pairs; the canonical entity is the most-mentioned one.
        const counts = new Map<string, number>(((await db.prepare(
          `SELECT a.entity_id id, COUNT(DISTINCT m.source_id) n FROM mentions m JOIN entity_alias a ON a.alias = m.norm GROUP BY a.entity_id`,
        ).all<{ id: string; n: number }>()).results ?? []).map((r) => [r.id, r.n]));
        const parent = new Map<string, string>();
        const find = (x: string): string => { while (parent.get(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
        const props: unknown[] = [];
        pairs.forEach((pr, i) => {
          if (verdicts[i] === 'same') {
            const ra = find(pr.a.id), rb = find(pr.b.id);
            if (ra === rb) return;
            const [keep, drop] = (counts.get(ra) ?? 0) >= (counts.get(rb) ?? 0) ? [ra, rb] : [rb, ra];
            parent.set(drop, keep);
          } else if (verdicts[i] === 'unsure') {
            props.push(pr);
          }
        });
        const stmts: D1PreparedStatement[] = [];
        const dropped: string[] = [];
        for (const id of parent.keys()) {
          const keep = find(id);
          if (keep === id) continue;
          dropped.push(id);
          stmts.push(db.prepare('UPDATE entity_alias SET entity_id = ? WHERE entity_id = ?').bind(keep, id));
          stmts.push(db.prepare('DELETE FROM entities WHERE id = ?').bind(id));
        }
        for (const pr of props as { a: Ent; b: Ent; s: number }[]) {
          stmts.push(db.prepare(
            `INSERT OR IGNORE INTO proposals (id, kind, title, detail, payload, created_at) VALUES (?, 'merge', ?, ?, ?, ?)`,
          ).bind(`merge:${pr.a.id}:${pr.b.id}`, `Merge "${pr.b.name}" into "${pr.a.name}"?`,
            `${pr.a.name} — ${pr.a.context ?? pr.a.kind}\n${pr.b.name} — ${pr.b.context ?? pr.b.kind}\nsimilarity ${pr.s.toFixed(2)}; the judge was unsure`,
            JSON.stringify({ keep: pr.a.id, drop: pr.b.id }), Date.now()));
        }
        for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
        for (let i = 0; i < dropped.length; i += 100) {
          await this.env.WIKI_VEC.deleteByIds(await Promise.all(dropped.slice(i, i + 100).map(vecIdEntity)));
        }
        return { merged: dropped.length, proposals: props.length };
      });
    }

    // 4. Pages: topics with 2+ sources, entities with 3+ sources.
    const nPages = await step.do('create pages', RETRY, async () => {
      const now = Date.now();
      await db.batch([
        db.prepare('DELETE FROM page_sources'),
        db.prepare(
          `INSERT OR IGNORE INTO page_sources (page_slug, source_id)
           SELECT 'topic/' || tm.topic, c.source_id FROM cards c, json_each(c.topics) j
           JOIN topic_map tm ON tm.raw = j.value WHERE tm.topic != ''`,
        ),
        db.prepare(
          `INSERT OR IGNORE INTO page_sources (page_slug, source_id)
           SELECT e.kind || '/' || e.id, m.source_id FROM mentions m
           JOIN entity_alias a ON a.alias = m.norm JOIN entities e ON e.id = a.entity_id
           WHERE e.kind IN (${PAGE_KINDS.map((k) => `'${k}'`).join(',')})`,
        ),
        // Drop under-threshold groups.
        db.prepare(
          `DELETE FROM page_sources WHERE page_slug IN (
             SELECT page_slug FROM page_sources GROUP BY page_slug
             HAVING COUNT(*) < CASE WHEN page_slug LIKE 'topic/%' THEN ${TOPIC_MIN_SOURCES} ELSE ${ENTITY_MIN_SOURCES} END)`,
        ),
        db.prepare(
          `INSERT INTO pages (slug, kind, ref, title, dirty, updated_at)
           SELECT 'topic/' || t.slug, 'topic', t.slug, t.title, 1, ${now} FROM topics t
           WHERE EXISTS (SELECT 1 FROM page_sources ps WHERE ps.page_slug = 'topic/' || t.slug)
           ON CONFLICT(slug) DO UPDATE SET title = excluded.title, dirty = 1`,
        ),
        db.prepare(
          `INSERT INTO pages (slug, kind, ref, title, dirty, updated_at)
           SELECT e.kind || '/' || e.id, e.kind, e.id, e.name, 1, ${now} FROM entities e
           WHERE EXISTS (SELECT 1 FROM page_sources ps WHERE ps.page_slug = e.kind || '/' || e.id)
           ON CONFLICT(slug) DO UPDATE SET title = excluded.title, dirty = 1`,
        ),
        // Pages whose topic/entity no longer qualifies (e.g. merged away) go.
        db.prepare(`DELETE FROM pages WHERE kind != 'note' AND slug NOT IN (SELECT DISTINCT page_slug FROM page_sources)`),
        db.prepare(`UPDATE pages SET source_count = (SELECT COUNT(*) FROM page_sources ps WHERE ps.page_slug = pages.slug)`),
      ]);
      return (await db.prepare('SELECT COUNT(*) n FROM pages').first<{ n: number }>())?.n ?? 0;
    });

    // 5. Keyword index over claims; vectors for every claim.
    await step.do('claims fts', RETRY, async () => {
      await db.batch([
        db.prepare('DELETE FROM claims_fts'),
        db.prepare('INSERT INTO claims_fts (id, source_id, text) SELECT id, source_id, text FROM claims'),
      ]);
      return true;
    });
    const nClaims = await step.do('count claims', async () => (await db.prepare('SELECT COUNT(*) n FROM claims').first<{ n: number }>())?.n ?? 0);
    for (let off = 0; off < nClaims; off += 500) {
      await step.do(`embed claims ${off}`, RETRY, async () => {
        const rows = (await db.prepare('SELECT id, source_id, text FROM claims ORDER BY id LIMIT 500 OFFSET ?').bind(off).all<{ id: string; source_id: string; text: string }>()).results ?? [];
        const vecs = await embed(this.env, rows.map((r) => r.text));
        await this.env.WIKI_VEC.upsert(rows.map((r, i) => ({ id: r.id, values: vecs[i], metadata: { type: 'claim', source_id: r.source_id } })));
        return rows.length;
      });
    }

    await step.do('mark built', async () => { await setMeta(this.env, 'built', '1'); return true; });

    // 6. Every page's editor, staggered so OpenRouter sees a steady trickle.
    const slugs = await step.do('list pages', async () =>
      ((await db.prepare('SELECT slug FROM pages ORDER BY source_count DESC').all<{ slug: string }>()).results ?? []).map((r) => r.slug));
    const stagger = p.pageStaggerMs ?? 2500;
    for (let i = 0; i < slugs.length; i += 100) {
      await step.do(`schedule pages ${i}`, RETRY, async () => {
        for (const [j, s] of slugs.slice(i, i + 100).entries()) {
          await this.env.WIKI_PAGE.get(this.env.WIKI_PAGE.idFromName(s)).schedule(s, (i + j) * stagger);
        }
        return true;
      });
    }

    await step.do('log', async () => {
      await db.prepare('INSERT INTO digests (body_md, created_at) VALUES (?, ?)').bind(
        `**Wiki built.** ${nPages} pages from ${nClaims} claims. Editors are writing pages now (about ${Math.round((slugs.length * stagger) / 60000)} min).`,
        Date.now(),
      ).run();
      return true;
    });
    return { pages: nPages, claims: nClaims, cost };
  }
}

export { pageSlug };
