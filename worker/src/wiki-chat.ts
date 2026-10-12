import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import { createUIMessageStream, createUIMessageStreamResponse, type GenerateTextOnFinishCallback, type ToolSet } from 'ai';
import type { Env } from './job';
import { findModel } from './config';
import { MODEL_EDITOR, llmTools, type ChatMsg } from './wiki-llm';
import { searchWiki, getClaims } from './wiki-search';
import { normalizeCitations } from './wiki-page';

// "Ask your wiki." One WikiChat per thread (instance name = thread id from the client).
// Same wire protocol and text-only replay as SummaryChat (chat.ts); the difference is a
// tool loop over the wiki: search → read pages/sources → answer citing claim ids.

const TOOLS = [
  { type: 'function', function: {
    name: 'search_wiki',
    description: 'Hybrid keyword + semantic search over wiki pages and individual claims from sources.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'read_page',
    description: 'Read a wiki page by slug (e.g. "topic/agent-memory", "person/sam-altman"), with the text of every claim it cites.',
    parameters: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
  } },
  { type: 'function', function: {
    name: 'read_source',
    description: 'Read one source: its gist, all its claims, and (if claim_id given) the transcript around that claim.',
    parameters: { type: 'object', properties: { source_id: { type: 'string' }, claim_id: { type: 'string' } }, required: ['source_id'] },
  } },
];

const clip = (s: string, n = 14000) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s);
const ts = (s: number | null) => (s == null ? '' : ` @${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

export class WikiChat extends AIChatAgent<Env> {
  private async runTool(name: string, args: Record<string, string>): Promise<{ text: string; summary: string }> {
    const db = this.env.DB;
    if (name === 'search_wiki') {
      const r = await searchWiki(this.env, args.query ?? '', { pages: 6, claims: 14 });
      return {
        summary: `${r.pages.length} pages, ${r.claims.length} claims`,
        text: `Pages:\n${r.pages.map((p) => `- ${p.slug} — ${p.title} (${p.source_count} sources): ${p.summary ?? ''}`).join('\n') || '(none)'}\n\n` +
          `Claims:\n${r.claims.map((c) => `- [${c.id}] ${c.speaker ?? ''} in "${c.source_title}" (source_id ${c.source_id}${ts(c.start_s)}): ${c.text}`).join('\n') || '(none)'}`,
      };
    }
    if (name === 'read_page') {
      const p = await db.prepare('SELECT slug, title, kind, summary, body_md, source_count FROM pages WHERE slug = ?').bind(args.slug)
        .first<{ slug: string; title: string; kind: string; summary: string; body_md: string; source_count: number }>();
      if (!p) return { summary: 'not found', text: `No page "${args.slug}".` };
      const ids = [...new Set([...(p.body_md ?? '').matchAll(/\[\[c:([^\]]+)\]\]/g)].map((m) => m[1]))];
      const claims = await getClaims(this.env, ids);
      return {
        summary: p.title,
        text: clip(`# ${p.title} (${p.kind}, ${p.source_count} sources)\n${p.body_md ?? '(not written yet)'}\n\nCited claims:\n` +
          claims.map((c) => `[${c.id}] "${c.source_title}" (source_id ${c.source_id}${ts(c.start_s)}): ${c.text}`).join('\n')),
      };
    }
    if (name === 'read_source') {
      const s = await db.prepare('SELECT id, title, url, transcript FROM summaries WHERE id = ?').bind(args.source_id)
        .first<{ id: string; title: string; url: string; transcript: string }>();
      if (!s) return { summary: 'not found', text: `No source "${args.source_id}".` };
      const card = await db.prepare('SELECT gist FROM cards WHERE source_id = ?').bind(s.id).first<{ gist: string }>();
      const claims = (await db.prepare('SELECT id, text, speaker, start_s, quote FROM claims WHERE source_id = ? ORDER BY idx').bind(s.id)
        .all<{ id: string; text: string; speaker: string; start_s: number | null; quote: string }>()).results ?? [];
      let window = '';
      const target = claims.find((c) => c.id === args.claim_id);
      if (target?.quote) {
        const i = s.transcript.toLowerCase().indexOf(target.quote.toLowerCase().slice(0, 40));
        if (i >= 0) window = `\n\nTranscript around ${target.id}:\n…${s.transcript.slice(Math.max(0, i - 1500), i + 1500)}…`;
      }
      return {
        summary: s.title,
        text: clip(`# ${s.title}\n${s.url}\nGist: ${card?.gist ?? ''}\n\nClaims:\n` +
          claims.map((c) => `[${c.id}]${ts(c.start_s)} ${c.speaker ?? ''}: ${c.text}`).join('\n') + window),
      };
    }
    return { summary: 'unknown tool', text: `Unknown tool ${name}` };
  }

  /** Same rule as the page editors: citations and links must point at things that exist. */
  private async validate(md: string) {
    md = normalizeCitations(md);
    const cids = [...new Set([...md.matchAll(/\[\[c:([^\]]+)\]\]/g)].map((m) => m[1]))];
    const slugs = [...new Set([...md.matchAll(/\[\[p:([^\]|]+)\]\]/g)].map((m) => m[1]))];
    const okC = new Set((await getClaims(this.env, cids)).map((c) => c.id));
    const okP = new Set(slugs.length ? ((await this.env.DB.prepare(
      `SELECT slug FROM pages WHERE slug IN (${slugs.map(() => '?').join(',')})`,
    ).bind(...slugs).all<{ slug: string }>()).results ?? []).map((r) => r.slug) : []);
    return md
      .replace(/\s?\[\[c:([^\]]+)\]\]/g, (m, id) => (okC.has(id) ? m : ''))
      .replace(/\[\[p:([^\]|]+)\]\]/g, (m, s) => (okP.has(s) ? m : s.split('/').pop()!.replace(/-/g, ' ')));
  }

  async onChatMessage(_onFinish: GenerateTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions): Promise<Response | undefined> {
    const body = (options?.body ?? {}) as { modelId?: string; pageSlug?: string };
    const model = body.modelId ? findModel(body.modelId).model : MODEL_EDITOR;

    const top = (await this.env.DB.prepare(
      `SELECT slug, title FROM pages WHERE kind = 'topic' ORDER BY source_count DESC LIMIT 80`,
    ).all<{ slug: string; title: string }>()).results ?? [];
    const pinned = body.pageSlug
      ? await this.env.DB.prepare('SELECT title, body_md FROM pages WHERE slug = ?').bind(body.pageSlug).first<{ title: string; body_md: string }>()
      : null;

    const system =
`You answer questions from the owner of a personal wiki compiled from ~1,100 videos and articles they watched and read. Ground answers in the wiki, not general knowledge: use the tools (search first, then read pages or sources for detail). If the wiki doesn't cover something, say so plainly, then you may add brief general knowledge clearly labeled as such.

Cite with markers the UI renders as links: [[c:CLAIM_ID]] after a sentence for a claim, [[p:SLUG]] for a wiki page. Only use ids/slugs you saw in tool results. Be direct and concise; use markdown. Say which view is strongest and why when sources differ.

Main topic pages: ${top.map((t) => `${t.slug} (${t.title})`).join(', ')}` +
      (pinned ? `\n\nThe user is reading the page "${pinned.title}" (${body.pageSlug}):\n${pinned.body_md ?? ''}` : '');

    const history: ChatMsg[] = this.messages
      .map((m) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as ChatMsg['role'],
        content: (m.parts ?? []).filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join(''),
      }))
      .filter((m) => (m.content ?? '').trim().length > 0);

    const env = this.env;
    const stream = createUIMessageStream({
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });
        const msgs: ChatMsg[] = [{ role: 'system', content: system }, ...history];
        let answer = '';
        for (let round = 0; round < 7; round++) {
          const last = round === 6;
          const { message } = await llmTools(env, model, msgs, last ? [] : TOOLS);
          const calls = message.tool_calls ?? [];
          if (!calls.length || last) { answer = message.content ?? ''; break; }
          msgs.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
          for (const c of calls) {
            let args: Record<string, string> = {};
            try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
            const r = await this.runTool(c.function.name, args);
            writer.write({ type: 'data-tool', data: { name: c.function.name, args, summary: r.summary } } as never);
            msgs.push({ role: 'tool', tool_call_id: c.id, content: r.text });
          }
        }
        answer = await this.validate(answer);
        const tid = `txt-${Date.now()}`;
        writer.write({ type: 'text-start', id: tid });
        writer.write({ type: 'text-delta', id: tid, delta: answer || '(no answer)' });
        writer.write({ type: 'text-end', id: tid });
        writer.write({ type: 'finish' });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
