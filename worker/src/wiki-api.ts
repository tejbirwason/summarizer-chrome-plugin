import type { Env } from './job';
import { searchWiki, getClaims } from './wiki-search';
import { applyProposal } from './wiki-garden';
import { slugify } from './wiki-llm';
import { ingestSource } from './wiki';
import { attachSource } from './wiki-graph';
import { normalizeCitations } from './wiki-page';

// /api/wiki/* read + control routes for the wiki UI (public/wiki.html). Auth is checked by
// the caller (same APP_TOKEN as the rest of /api).

type J = (data: unknown, init?: ResponseInit) => Response;

export async function wikiApi(req: Request, env: Env, p: string, url: URL, json: J): Promise<Response | null> {
  const db = env.DB;
  const q = (k: string) => url.searchParams.get(k) ?? '';

  if (p === '/api/wiki/home' && req.method === 'GET') {
    const [stats, digest, topics, recentSources, recentRevs, open, groups] = await Promise.all([
      db.prepare(
        `SELECT (SELECT COUNT(*) FROM summaries) sources, (SELECT COUNT(*) FROM cards) cards,
                (SELECT COUNT(*) FROM pages) pages, (SELECT COUNT(*) FROM pages WHERE body_md IS NOT NULL) written,
                (SELECT COUNT(*) FROM claims) claims, (SELECT MAX(created_at) FROM cards) last_ingest,
                (SELECT SUM(cost_usd) FROM cards) + COALESCE((SELECT SUM(cost_usd) FROM page_revisions), 0) cost_usd`,
      ).first(),
      db.prepare('SELECT body_md, created_at FROM digests ORDER BY created_at DESC LIMIT 1').first(),
      db.prepare(
        `SELECT p.slug, p.title, p.summary, p.source_count, p.updated_at, t.grp FROM pages p JOIN topics t ON t.slug = p.ref
         WHERE p.kind = 'topic' ORDER BY p.source_count DESC LIMIT 12`,
      ).all(),
      db.prepare(
        `SELECT s.id, s.title, s.kind, s.video_id, s.created_at,
           (SELECT json_group_array(json_object('slug', p.slug, 'title', p.title)) FROM page_sources ps JOIN pages p ON p.slug = ps.page_slug WHERE ps.source_id = s.id) pages
         FROM summaries s JOIN cards c ON c.source_id = s.id ORDER BY s.created_at DESC LIMIT 8`,
      ).all(),
      db.prepare(
        `SELECT r.page_slug slug, p.title, r.rev, r.reason, r.created_at FROM page_revisions r JOIN pages p ON p.slug = r.page_slug
         ORDER BY r.created_at DESC LIMIT 10`,
      ).all(),
      db.prepare(`SELECT COUNT(*) n FROM proposals WHERE status = 'open'`).first<{ n: number }>(),
      db.prepare(
        `SELECT t.grp, COUNT(*) n FROM pages p JOIN topics t ON t.slug = p.ref WHERE p.kind = 'topic' GROUP BY t.grp ORDER BY n DESC`,
      ).all(),
    ]);
    const slugs = [...((digest as { body_md?: string } | null)?.body_md ?? '').matchAll(/\[\[p:([^\]]+)\]\]/g)].map((m) => m[1]);
    const links = slugs.length
      ? Object.fromEntries(((await db.prepare(`SELECT slug, title, kind FROM pages WHERE slug IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(slugs)).all<{ slug: string; title: string; kind: string }>()).results ?? []).map((l) => [l.slug, l]))
      : {};
    return json({
      stats, digest, links, topics: topics.results, groups: groups.results, open_proposals: open?.n ?? 0,
      recent_sources: (recentSources.results ?? []).map((r: any) => ({ ...r, pages: JSON.parse(r.pages ?? '[]') })),
      recent_revisions: recentRevs.results,
    });
  }

  if (p === '/api/wiki/list' && req.method === 'GET') {
    const kind = q('kind') || 'topic';
    const rows = kind === 'topic'
      ? await db.prepare(
        `SELECT p.slug, p.title, p.kind, p.summary, p.source_count, p.updated_at, t.grp FROM pages p
         LEFT JOIN topics t ON t.slug = p.ref WHERE p.kind = 'topic' ORDER BY t.grp, p.source_count DESC`,
      ).all()
      : await db.prepare(
        `SELECT slug, title, kind, summary, source_count, updated_at FROM pages
         WHERE ${kind === 'all' ? '1' : 'kind = ?'} ORDER BY source_count DESC LIMIT 2000`,
      ).bind(...(kind === 'all' ? [] : [kind])).all();
    const counts = await db.prepare('SELECT kind, COUNT(*) n FROM pages GROUP BY kind').all();
    return json({ pages: rows.results, counts: counts.results });
  }

  if (p === '/api/wiki/page' && req.method === 'GET') {
    const slug = q('slug');
    const page = await db.prepare('SELECT * FROM pages WHERE slug = ?').bind(slug).first<{ body_md: string | null; kind: string; ref: string }>();
    if (!page) return json({ error: 'not found' }, { status: 404 });
    const ids = [...new Set([...(page.body_md ?? '').matchAll(/\[\[c:([^\]]+)\]\]/g)].map((m) => m[1]))];
    const [claims, sources, related, revisions, links, extra] = await Promise.all([
      getClaims(env, ids),
      db.prepare(
        `SELECT s.id, s.title, s.url, s.kind, s.video_id, s.created_at, c.gist FROM page_sources ps
         JOIN summaries s ON s.id = ps.source_id LEFT JOIN cards c ON c.source_id = s.id
         WHERE ps.page_slug = ? ORDER BY s.created_at DESC`,
      ).bind(slug).all(),
      db.prepare(
        `SELECT p.slug, p.title, p.kind, COUNT(*) overlap FROM page_sources a
         JOIN page_sources b ON b.source_id = a.source_id AND b.page_slug != a.page_slug
         JOIN pages p ON p.slug = b.page_slug WHERE a.page_slug = ? GROUP BY p.slug ORDER BY overlap DESC LIMIT 16`,
      ).bind(slug).all(),
      db.prepare('SELECT rev, reason, model, cost_usd, created_at FROM page_revisions WHERE page_slug = ? ORDER BY rev DESC LIMIT 20').bind(slug).all(),
      db.prepare(`SELECT slug, title, kind FROM pages WHERE slug IN (SELECT DISTINCT value FROM json_each(?))`)
        .bind(JSON.stringify([...(page.body_md ?? '').matchAll(/\[\[p:([^\]]+)\]\]/g)].map((m) => m[1]))).all(),
      page.kind === 'topic'
        ? db.prepare('SELECT grp, description FROM topics WHERE slug = ?').bind(page.ref).first()
        : db.prepare('SELECT context FROM entities WHERE id = ?').bind(page.ref).first(),
    ]);
    // Which claims each source contributed, for the sources list.
    const used: Record<string, number> = {};
    for (const c of claims) used[c.source_id] = (used[c.source_id] ?? 0) + 1;
    return json({
      page, meta: extra, claims: Object.fromEntries(claims.map((c) => [c.id, c])),
      sources: (sources.results ?? []).map((s: any) => ({ ...s, claims_used: used[s.id] ?? 0 })),
      related: related.results, revisions: revisions.results,
      links: Object.fromEntries((links.results ?? []).map((l: any) => [l.slug, l])),
    });
  }

  if (p === '/api/wiki/revision' && req.method === 'GET') {
    const r = await db.prepare('SELECT * FROM page_revisions WHERE page_slug = ? AND rev = ?').bind(q('slug'), Number(q('rev'))).first();
    return r ? json(r) : json({ error: 'not found' }, { status: 404 });
  }

  if (p === '/api/wiki/source' && req.method === 'GET') {
    const id = q('id');
    const source = await db.prepare('SELECT id, title, url, kind, video_id, created_at, length(transcript) chars FROM summaries WHERE id = ?').bind(id).first();
    if (!source) return json({ error: 'not found' }, { status: 404 });
    const [card, claims, pages, mentions] = await Promise.all([
      db.prepare('SELECT gist, topics, model, cost_usd FROM cards WHERE source_id = ?').bind(id).first(),
      db.prepare('SELECT id, text, quote, quote_ok, kind, speaker, start_s, approx FROM claims WHERE source_id = ? ORDER BY idx').bind(id).all(),
      db.prepare('SELECT p.slug, p.title, p.kind FROM page_sources ps JOIN pages p ON p.slug = ps.page_slug WHERE ps.source_id = ? ORDER BY p.kind, p.title').bind(id).all(),
      db.prepare(
        `SELECT m.name, m.kind, m.context, e.id entity_id, p.slug page FROM mentions m
         LEFT JOIN entity_alias a ON a.alias = m.norm LEFT JOIN entities e ON e.id = a.entity_id
         LEFT JOIN pages p ON p.ref = e.id AND p.kind = e.kind WHERE m.source_id = ?`,
      ).bind(id).all(),
    ]);
    return json({ source, card, claims: claims.results, pages: pages.results, mentions: mentions.results });
  }

  if (p === '/api/wiki/transcript' && req.method === 'GET') {
    const s = await db.prepare('SELECT transcript FROM summaries WHERE id = ?').bind(q('id')).first<{ transcript: string }>();
    return json({ transcript: s?.transcript ?? '' });
  }

  if (p === '/api/wiki/sources' && req.method === 'GET') {
    const rows = await db.prepare(
      `SELECT s.id, s.title, s.kind, s.video_id, s.created_at, c.gist, (SELECT COUNT(*) FROM page_sources ps WHERE ps.source_id = s.id) pages
       FROM summaries s LEFT JOIN cards c ON c.source_id = s.id ORDER BY s.created_at DESC LIMIT 2000`,
    ).all();
    return json({ sources: rows.results });
  }

  if (p === '/api/wiki/claims' && req.method === 'GET') {
    const ids = q('ids').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const claims = await getClaims(env, ids);
    return json({ claims: Object.fromEntries(claims.map((c) => [c.id, c])) });
  }

  if (p === '/api/wiki/search' && req.method === 'GET') {
    return json(await searchWiki(env, q('q'), { pages: 10, claims: 20 }));
  }

  if (p === '/api/wiki/proposals' && req.method === 'GET') {
    const status = q('status') || 'open';
    const rows = await db.prepare('SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC LIMIT 200').bind(status).all();
    const counts = await db.prepare('SELECT status, COUNT(*) n FROM proposals GROUP BY status').all();
    return json({ proposals: rows.results, counts: counts.results });
  }

  if (p.startsWith('/api/wiki/proposals/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/wiki/proposals/'.length));
    const { action } = (await req.json()) as { action: 'approve' | 'reject' };
    if (action === 'reject') {
      await db.prepare(`UPDATE proposals SET status = 'rejected', decided_at = ? WHERE id = ?`).bind(Date.now(), id).run();
      return json({ id, status: 'rejected' });
    }
    return json(await applyProposal(env, id));
  }

  // Chat answers worth keeping become a "note" proposal; approving it creates the page.
  if (p === '/api/wiki/save-answer' && req.method === 'POST') {
    const b = (await req.json()) as { title: string; body_md: string; summary?: string };
    if (!b.title?.trim() || !b.body_md?.trim()) return json({ error: 'title and body_md required' }, { status: 400 });
    const slug = slugify(b.title);
    const id = `note:${slug}:${Date.now()}`;
    await db.prepare(`INSERT INTO proposals (id, kind, title, detail, payload, created_at) VALUES (?, 'note', ?, ?, ?, ?)`)
      .bind(id, `Save chat answer: ${b.title}`, b.body_md.slice(0, 400), JSON.stringify({ slug, title: b.title, body_md: b.body_md, summary: b.summary ?? '' }), Date.now()).run();
    return json({ id });
  }

  // Synchronous card + routing for one source; returns the real error instead of a queue retry.
  if (p === '/api/wiki/ingest-now' && req.method === 'POST') {
    const { id, force } = (await req.json()) as { id: string; force?: boolean };
    try {
      const r = await ingestSource(env, { sourceId: id, force });
      const routed = 'skipped' in r ? null : await attachSource(env, id);
      return json({ ...r, routed });
    } catch (e) {
      return json({ error: String(e) }, { status: 500 });
    }
  }

  // One-off repair: normalize citation markers in already-written pages and recount.
  if (p === '/api/wiki/normalize' && req.method === 'POST') {
    const rows = (await db.prepare('SELECT slug, body_md FROM pages WHERE body_md IS NOT NULL').all<{ slug: string; body_md: string }>()).results ?? [];
    const stmts: D1PreparedStatement[] = [];
    for (const r of rows) {
      const body = normalizeCitations(r.body_md);
      if (body === r.body_md) continue;
      const cited = new Set([...body.matchAll(/\[\[c:([^\]]+)\]\]/g)].map((m) => m[1])).size;
      stmts.push(db.prepare('UPDATE pages SET body_md = ?, claim_count = ? WHERE slug = ?').bind(body, cited, r.slug));
      stmts.push(db.prepare('UPDATE page_revisions SET body_md = ? WHERE page_slug = ? AND rev = (SELECT rev FROM pages WHERE slug = ?)').bind(body, r.slug, r.slug));
    }
    for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
    return json({ fixed: stmts.length / 2, scanned: rows.length });
  }

  if (p === '/api/wiki/rewrite' && req.method === 'POST') {
    const { slug } = (await req.json()) as { slug: string };
    const r = await env.WIKI_PAGE.get(env.WIKI_PAGE.idFromName(slug)).rewriteNow(slug, 'manual rewrite');
    return json(r);
  }

  if (p === '/api/wiki/build' && req.method === 'POST') {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const inst = await env.WIKI_BUILD.create({ params: b });
    return json({ id: inst.id });
  }
  if (p === '/api/wiki/garden' && req.method === 'POST') {
    const inst = await env.WIKI_GARDEN.create({});
    return json({ id: inst.id });
  }
  if (p === '/api/wiki/workflow' && req.method === 'GET') {
    const wf = q('type') === 'garden' ? env.WIKI_GARDEN : env.WIKI_BUILD;
    const inst = await wf.get(q('id'));
    return json(await inst.status());
  }

  return null;
}
