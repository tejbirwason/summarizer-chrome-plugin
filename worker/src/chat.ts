import { AIChatAgent, type OnChatMessageOptions } from '@cloudflare/ai-chat';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type GenerateTextOnFinishCallback,
  type ToolSet,
} from 'ai';
import { findModel } from './config';
import { streamCompletion, type Msg } from './openrouter';
import type { Env } from './job';

// One SummaryChat per summary id (the normalized URL) — instance name = encodeURIComponent(id).
// The SDK's own SQLite tables hold the thread and the resumable-stream buffer; the only
// state this class supplies is the transcript, hydrated from D1 on every turn.
//
// The model call deliberately reuses openrouter.ts's streamCompletion (the same code the
// summary path runs daily, incl. the unified `reasoning` field) rather than the AI SDK's
// provider — an @openrouter/ai-sdk-provider streamText call was observed hanging on
// anthropic/claude-opus-4.8 with reasoning enabled, and there's no reason to debug a
// second OpenRouter client when a proven one is sitting in the same directory.
export class SummaryChat extends AIChatAgent<Env> {
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const id = decodeURIComponent(this.name);
    const row = await this.env.DB.prepare('SELECT url, title, transcript FROM summaries WHERE id = ?')
      .bind(id)
      .first<{ url: string; title: string; transcript: string }>();
    if (!row) return new Response('unknown summary', { status: 404 });

    // The model rides on every request body (shape 2: one thread, model per turn).
    const model = findModel(typeof options?.body?.modelId === 'string' ? options.body.modelId : undefined);
    console.log('SummaryChat turn', JSON.stringify({ id, modelId: model.id, msgs: this.messages.length }));

    const system =
      `You are a sharp assistant answering follow-up questions about ONE piece of content the user has already had summarized. ` +
      `Ground every answer in the transcript below; quote or reference specific parts when useful. ` +
      `If the transcript doesn't cover something, say so plainly. Be direct and concise. Use markdown.\n\n` +
      `Title: ${row.title}\nSource: ${row.url}\n\nFull transcript/content:\n${row.transcript}`;

    // Replay TEXT parts only. Assistant messages persist provider reasoning parts
    // (OpenAI's arrive encrypted), and replaying those to a different model is rejected
    // upstream — which would break the whole switch-model-per-turn design.
    const history: Msg[] = this.messages
      .map((m) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as Msg['role'],
        content: (m.parts ?? [])
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(''),
      }))
      .filter((m) => m.content.trim().length > 0);

    const meta = { modelId: model.id, modelName: model.name, modelIcon: model.icon };
    const apiKey = this.env.OPENROUTER_API_KEY;
    const abortSignal = options?.abortSignal;

    const stream = createUIMessageStream({
      // Single-user tool: surface the real upstream error, not a masked one.
      onError: (e) => (e instanceof Error ? e.message : String(e)),
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageMetadata: meta });
        const tid = `txt-${Date.now()}`;
        writer.write({ type: 'text-start', id: tid });
        await streamCompletion(
          apiKey,
          model,
          [{ role: 'system', content: system }, ...history],
          {
            onDelta: (t) => writer.write({ type: 'text-delta', id: tid, delta: t }),
            onDone: () => {},
            // streamCompletion also throws after onError; the throw is what reaches
            // createUIMessageStream's onError and becomes the client's error part.
            onError: () => {},
          },
          abortSignal,
        );
        writer.write({ type: 'text-end', id: tid });
        writer.write({ type: 'finish', messageMetadata: meta });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
