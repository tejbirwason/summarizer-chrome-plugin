import { DurableObject } from 'cloudflare:workers';
import type { Env } from './job';
import { MODEL_EDITOR, MODEL_FAST, llmJSON, embed, vecIdPage, normName } from './wiki-llm';

// One WikiPage per page slug. Edits to a page are serialized here: schedule() coalesces any
// number of incoming sources into a single alarm, and the alarm runs the editor agent once.
// That is what lets ingest run in parallel without two agents rewriting the same page.

const MAX_CLAIMS = 450;
const BIG_PAGE_SOURCES = 12; // pages with more sources get the stronger editor model

interface PageRow {
  slug: string; kind: string; ref: string; title: string; body_md: string | null; summary: string | null;
  rev: number; notes: string | null;
}
interface ClaimRow { id: string; source_id: string; text: string; kind: string; speaker: string | null }
interface SourceRow { id: string; title: string; created_at: number; gist: string | null }

const OUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'body_md'],
  properties: { summary: { type: 'string' }, body_md: { type: 'string' } },
};

// Models often drop the "c:" prefix ([[c_ab12_3]]) or group ids ([[c:a, c:b]]). Normalize
// every variant to one [[c:ID]] per claim before validation.
export function normalizeCitations(md: string) {
  return md.replace(/\[\[((?:c:)?c_[0-9a-f]+_\d+(?:\s*[,;]\s*(?:c:)?c_[0-9a-f]+_\d+)*)\]\]/g, (_m, inner: string) =>
    inner.split(/[,;]/).map((x) => `[[c:${x.trim().replace(/^c:/, '')}]]`).join(''));
}

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class WikiPage extends DurableObject<Env> {
  /** Coalesce: keep an earlier alarm if one is pending, so a burst of sources = one rewrite. */
  async schedule(slug: string, delayMs: number) {
    await this.ctx.storage.put('slug', slug);
    const at = Date.now() + delayMs;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
    return { slug, at };
  }

  async alarm() {
    const slug = await this.ctx.storage.get<string>('slug');
    if (!slug) return;
    try {
      await this.rewrite(slug, 'new sources');
    } catch (e) {
      console.error('wiki page rewrite failed', slug, String(e));
      throw e; // alarms retry with backoff
    }
  }

  /** Run the editor now (used by the "rewrite" button and tests). */
  async rewriteNow(slug: string, reason = 'manual') {
    await this.ctx.storage.put('slug', slug);
    return this.rewrite(slug, reason);
  }

  private async rewrite(slug: string, reason: string) {
    const db = this.env.DB;
    const page = await db.prepare('SELECT slug, kind, ref, title, body_md, summary, rev, notes FROM pages WHERE slug = ?')
      .bind(slug).first<PageRow>();
    if (!page) return { slug, skipped: 'no page' };

    const sources = (await db.prepare(
      `SELECT s.id, s.title, s.created_at, c.gist FROM page_sources ps
       JOIN summaries s ON s.id = ps.source_id LEFT JOIN cards c ON c.source_id = s.id
       WHERE ps.page_slug = ? ORDER BY s.created_at`,
    ).bind(slug).all<SourceRow>()).results ?? [];
    if (!sources.length) return { slug, skipped: 'no sources' };

    const claims = await this.pickClaims(page, sources);
    const allowedClaims = new Set(claims.map((c) => c.id));

    // Links are restricted to pages that share sources with this one — the editor can't
    // invent a target.
    const related = (await db.prepare(
      `SELECT p.slug, p.title, COUNT(*) overlap FROM page_sources a
       JOIN page_sources b ON b.source_id = a.source_id AND b.page_slug != a.page_slug
       JOIN pages p ON p.slug = b.page_slug
       WHERE a.page_slug = ? GROUP BY p.slug ORDER BY overlap DESC LIMIT 30`,
    ).bind(slug).all<{ slug: string; title: string; overlap: number }>()).results ?? [];
    const allowedLinks = new Map(related.map((r) => [r.slug, r.title]));

    const sIdx = new Map(sources.map((s, i) => [s.id, `S${i + 1}`]));
    const notes: string[] = JSON.parse(page.notes ?? '[]');
    const subject = page.kind === 'topic' ? `the topic "${page.title}"` : `the ${page.kind} "${page.title}"`;

    const prompt =
`You maintain one page of a personal wiki compiled from the videos and articles its owner has watched and read. Write the page for ${subject}.

Rules:
- Synthesize what THESE sources say. Attribute views to people or sources ("Cowling argues..."). Don't add outside knowledge beyond a neutral one-line definition.
- Cite every factual sentence or bullet with 1-3 claim markers like [[c:${claims[0]?.id ?? 'c_x_0'}]], placed at the end of the sentence. Use ONLY claim ids listed below.
- Link to other wiki pages with [[p:slug]] using ONLY the slugs listed under "Pages you may link". Link each page at most once.
- Ignore claims that aren't about ${subject}.
- Structure: a 2-4 sentence lead (no heading); "## Key ideas" (bullets or ### subsections); "## Disagreements" only if sources genuinely conflict (name both sides); "## How views changed" only if source dates show a real shift; optional "## Open questions" (max 3 bullets). ${page.kind === 'person' ? 'For a person, open with who they are (from context), then what they argue across sources.' : ''}
- Length scales with material: about 120 words for 3 sources, up to ~900 for 40+.
- Markdown only. No title heading (the UI shows it). No "Sources" section (the UI lists them).
- summary: one plain sentence (max 25 words) for page lists.
${page.body_md ? '- A previous version exists. Keep its good structure; integrate the new material; fix anything the claims contradict.' : ''}
${notes.length ? `\nEditor notes you must address in this rewrite:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
Sources:
${sources.map((s) => `${sIdx.get(s.id)} | ${fmtDate(s.created_at)} | ${s.title} | ${s.gist ?? ''}`).join('\n')}

Claims (id, source, kind, speaker, text):
${claims.map((c) => `[${c.id}] ${sIdx.get(c.source_id)} ${c.kind} ${c.speaker ?? '-'}: ${c.text}`).join('\n')}

Pages you may link:
${related.map((r) => `${r.slug} — ${r.title}`).join('\n') || '(none)'}
${page.body_md ? `\nPrevious version:\n${page.body_md}` : ''}`;

    const model = sources.length > BIG_PAGE_SOURCES ? MODEL_EDITOR : MODEL_FAST;
    const out = await llmJSON<{ summary: string; body_md: string }>(this.env, model, [{ role: 'user', content: prompt }], OUT_SCHEMA, { maxTokens: 8000 });

    // Validation is code, not trust: unknown claim ids are dropped, unknown links become text.
    let dropped = 0;
    const body = normalizeCitations(out.data.body_md)
      .replace(/\[\[c:([^\]]+)\]\]/g, (m, id) => (allowedClaims.has(id.trim()) ? `[[c:${id.trim()}]]` : (dropped++, '')))
      .replace(/\[\[p:([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, s, label) => {
        const k = s.trim();
        return allowedLinks.has(k) ? `[[p:${k}]]` : (label ?? k.split('/').pop()!.replace(/-/g, ' '));
      })
      .replace(/^#\s+.*\n+/, '')
      .trim();
    const cited = new Set([...body.matchAll(/\[\[c:([^\]]+)\]\]/g)].map((m) => m[1]));
    const rev = page.rev + 1;
    const now = Date.now();

    await db.batch([
      db.prepare(
        `UPDATE pages SET body_md = ?, summary = ?, rev = ?, dirty = 0, notes = NULL, claim_count = ?,
           source_count = ?, updated_at = ? WHERE slug = ?`,
      ).bind(body, out.data.summary, rev, cited.size, sources.length, now, slug),
      db.prepare(
        'INSERT INTO page_revisions (page_slug, rev, body_md, summary, model, reason, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(slug, rev, body, out.data.summary, model, `${reason}${dropped ? ` (dropped ${dropped} bad citations)` : ''}`, out.cost, now),
      db.prepare('DELETE FROM pages_fts WHERE slug = ?').bind(slug),
      db.prepare('INSERT INTO pages_fts (slug, title, body) VALUES (?, ?, ?)')
        .bind(slug, page.title, `${out.data.summary}\n${body.replace(/\[\[[cp]:[^\]]+\]\]/g, '')}`),
    ]);

    const [vec] = await embed(this.env, [`${page.title}. ${out.data.summary}\n${body.replace(/\[\[[cp]:[^\]]+\]\]/g, '').slice(0, 1500)}`]);
    await this.env.WIKI_VEC.upsert([{ id: await vecIdPage(slug), values: vec, metadata: { type: 'page', slug } }]);

    console.log('wiki page rewritten', JSON.stringify({ slug, rev, model, sources: sources.length, claims: claims.length, cited: cited.size, dropped, cost: out.cost }));
    return { slug, rev, model, cited: cited.size, dropped, cost: out.cost };
  }

  /** Claims worth showing the editor. Entity pages: claims naming the entity or spoken by it. */
  private async pickClaims(page: PageRow, sources: SourceRow[]): Promise<ClaimRow[]> {
    const db = this.env.DB;
    const perSource = Math.max(3, Math.min(15, Math.floor(MAX_CLAIMS / sources.length)));
    const out: ClaimRow[] = [];

    let terms: string[] = [];
    if (page.kind !== 'topic') {
      const aliases = (await db.prepare('SELECT alias FROM entity_alias WHERE entity_id = ?').bind(page.ref).all<{ alias: string }>()).results ?? [];
      terms = [...new Set([normName(page.title), ...aliases.map((a) => a.alias)])];
      if (page.kind === 'person') {
        const last = normName(page.title).split(' ').pop()!;
        if (last.length > 3) terms.push(last);
      }
      terms = terms.filter((t) => t.length > 1);
    }

    for (let i = 0; i < sources.length; i += 40) {
      const ids = sources.slice(i, i + 40).map((s) => s.id);
      const rows = (await db.prepare(
        `SELECT id, source_id, text, kind, speaker FROM claims WHERE source_id IN (${ids.map(() => '?').join(',')}) ORDER BY source_id, idx`,
      ).bind(...ids).all<ClaimRow>()).results ?? [];
      const bySource = new Map<string, ClaimRow[]>();
      for (const r of rows) (bySource.get(r.source_id) ?? bySource.set(r.source_id, []).get(r.source_id)!).push(r);
      for (const id of ids) {
        let list = bySource.get(id) ?? [];
        if (terms.length) {
          const hit = list.filter((c) => {
            const t = ` ${normName(c.text)} ${normName(c.speaker ?? '')} `;
            return terms.some((term) => t.includes(` ${term} `));
          });
          list = hit.length ? hit : list.slice(0, 2);
        }
        out.push(...list.slice(0, perSource));
      }
    }
    return out.slice(0, MAX_CLAIMS);
  }
}
