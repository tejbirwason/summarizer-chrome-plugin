import { DurableObject } from 'cloudflare:workers';
import { findModel, resolvePrompt, type ModelDef } from './config';
import { streamCompletion, type Msg } from './openrouter';
import { submitPoster, pollPoster } from './fal';

export interface Env {
  DB: D1Database;
  POSTERS: R2Bucket;
  JOB: DurableObjectNamespace<SummaryJob>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY: string;
  FAL_KEY: string;
  APP_TOKEN: string;
}

interface Generation {
  modelId: string;
  usedModel: { id: string; name: string; icon: string };
  prompt: string;
  messages: Msg[];
  content: string;
  state: 'streaming' | 'complete' | 'error';
  error?: string;
  startedAt: number;
  durationMs?: number;
}

interface JobState {
  id: string;
  url: string;
  title: string;
  kind: 'video' | 'page';
  videoId?: string;
  source: string; // transcript or selection text
  activeModelId: string;
  generations: Record<string, Generation>;
  poster?: { state: string; falRequestId?: string; r2Key?: string; error?: string };
}

const IDLE_TIMEOUT_MS = 150_000; // matches the local host's watchdog
const PERSIST_THROTTLE_MS = 1_000;

export class SummaryJob extends DurableObject<Env> {
  private subs = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private lastPersist = 0;

  private async load(): Promise<JobState | null> {
    return (await this.ctx.storage.get<JobState>('job')) ?? null;
  }

  private async save(job: JobState, force = false) {
    const now = Date.now();
    if (!force && now - this.lastPersist < PERSIST_THROTTLE_MS) return;
    this.lastPersist = now;
    await this.ctx.storage.put('job', job);
  }

  private broadcast(event: string, data: unknown) {
    const frame = new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const w of [...this.subs]) {
      w.write(frame).catch(() => this.subs.delete(w));
    }
  }

  async start(input: {
    id: string; url: string; title: string; kind: 'video' | 'page';
    videoId?: string; source: string; modelId?: string; prompt?: string;
  }) {
    const model = findModel(input.modelId);
    const prompt = resolvePrompt(input.prompt, model);
    const job: JobState = {
      id: input.id, url: input.url, title: input.title, kind: input.kind,
      videoId: input.videoId, source: input.source,
      activeModelId: model.id, generations: {},
    };
    await this.ctx.storage.put('job', job);
    await this.upsertSummary(job);
    this.run(job, model, prompt);
    return { id: job.id, activeModelId: model.id };
  }

  async snapshot() {
    const job = await this.load();
    if (!job) return null;
    // A job reaching this path has no live port, so a lingering 'streaming' flag from a
    // crashed run is stale — same defensive clear loadJob() did locally.
    return job;
  }

  async followup(question: string) {
    const job = await this.load();
    if (!job) throw new Error('no job');
    const gen = job.generations[job.activeModelId];
    if (!gen) throw new Error('no active generation');
    gen.messages.push({ role: 'user', content: question });
    gen.state = 'streaming';
    gen.startedAt = Date.now();
    await this.save(job, true);
    this.broadcast('user', { text: question });
    this.run(job, findModel(job.activeModelId), null, gen.messages);
    return { ok: true };
  }

  async regenerate(modelId: string, prompt?: string) {
    const job = await this.load();
    if (!job) throw new Error('no job');
    const model = findModel(modelId);
    job.activeModelId = model.id;
    await this.save(job, true);
    this.run(job, model, resolvePrompt(prompt, model));
    return { ok: true, activeModelId: model.id };
  }

  /**
   * The generation itself. Deliberately NOT awaited by the caller: the outbound
   * OpenRouter fetch counts as pending I/O, which is what keeps this DO alive after the
   * client disconnects. That's the property the whole design exists for.
   */
  private async run(job: JobState, model: ModelDef, prompt: string | null, existing?: Msg[]) {
    const messages: Msg[] =
      existing ?? [
        { role: 'system', content: prompt ?? '' },
        { role: 'user', content: job.source },
      ];

    const gen: Generation = job.generations[model.id] ?? {
      modelId: model.id,
      usedModel: { id: model.id, name: model.name, icon: model.icon },
      prompt: prompt ?? '',
      messages,
      content: '',
      state: 'streaming',
      startedAt: Date.now(),
    };
    gen.messages = messages;
    gen.state = 'streaming';
    gen.content = existing ? gen.content : '';
    gen.startedAt = Date.now();
    job.generations[model.id] = gen;

    // Write the row NOW, not on completion. The DO knows a generation is in flight but D1
    // is what the dashboard reads, and a LEFT JOIN against a row that doesn't exist yet
    // yields gen_state=NULL — so an in-flight job would render as a finished one with no
    // model and no state. This row is what makes "Running now" real.
    await this.persistGeneration(job, gen);

    const ctrl = new AbortController();
    let idle: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
    };
    kick();

    const started = Date.now();
    const answerStart = gen.content.length;

    streamCompletion(
      this.env.OPENROUTER_API_KEY,
      model,
      messages,
      {
        onDelta: async (t) => {
          kick();
          gen.content += t;
          this.broadcast('delta', { modelId: model.id, text: t, len: gen.content.length });
          await this.save(job);
        },
        onDone: async () => {
          if (idle) clearTimeout(idle);
          gen.state = 'complete';
          gen.durationMs = Date.now() - started;
          gen.messages.push({ role: 'assistant', content: gen.content.slice(answerStart) });
          await this.save(job, true);
          await this.persistGeneration(job, gen);
          this.broadcast('complete', {
            modelId: model.id, content: gen.content,
            usedModel: gen.usedModel, durationMs: gen.durationMs,
          });
          await this.kickPoster(job, gen);
        },
        onError: async (e) => {
          if (idle) clearTimeout(idle);
          gen.state = 'error';
          gen.error = e;
          await this.save(job, true);
          await this.persistGeneration(job, gen);
          this.broadcast('error', { modelId: model.id, error: e });
        },
      },
      ctrl.signal,
    ).catch(async (e) => {
      if (idle) clearTimeout(idle);
      gen.state = 'error';
      gen.error = ctrl.signal.aborted ? `stalled: no output for ${IDLE_TIMEOUT_MS / 1000}s` : String(e);
      await this.save(job, true);
      await this.persistGeneration(job, gen);
      this.broadcast('error', { modelId: model.id, error: gen.error });
    });
  }

  private async upsertSummary(job: JobState) {
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO summaries (id, url, title, kind, video_id, transcript, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, transcript=excluded.transcript, updated_at=excluded.updated_at`,
    )
      .bind(job.id, job.url, job.title, job.kind, job.videoId ?? null, job.source, now, now)
      .run();
  }

  private async persistGeneration(job: JobState, gen: Generation) {
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO generations (id, summary_id, model_id, model_name, model_icon, prompt, content, state, error, duration_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(summary_id, model_id) DO UPDATE SET
         content=excluded.content, state=excluded.state, error=excluded.error,
         duration_ms=excluded.duration_ms, updated_at=excluded.updated_at`,
    )
      .bind(
        `${job.id}::${gen.modelId}`, job.id, gen.modelId, gen.usedModel.name, gen.usedModel.icon,
        gen.prompt, gen.content, gen.state, gen.error ?? null, gen.durationMs ?? null, now, now,
      )
      .run();
  }

  // ---- poster ----

  private async kickPoster(job: JobState, gen: Generation) {
    if (job.poster && job.poster.state !== 'error') return; // one poster per summary
    if (!this.env.FAL_KEY) return;
    try {
      const reqId = await submitPoster(this.env.FAL_KEY, job.title, gen.content);
      job.poster = { state: 'generating', falRequestId: reqId };
      await this.save(job, true);
      await this.savePosterRow(job);
      this.broadcast('poster', { state: 'generating' });
      await this.ctx.storage.setAlarm(Date.now() + 10_000);
    } catch (e) {
      job.poster = { state: 'error', error: String(e) };
      await this.save(job, true);
      await this.savePosterRow(job);
    }
  }

  async alarm() {
    const job = await this.load();
    if (!job?.poster?.falRequestId || job.poster.state !== 'generating') return;
    try {
      const r = await pollPoster(this.env.FAL_KEY, job.poster.falRequestId);
      if (r.status === 'pending') {
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
        return;
      }
      if (r.status === 'error') {
        job.poster = { ...job.poster, state: 'error', error: r.error };
      } else {
        // fal returns PNG for gpt-image-2; derive the extension rather than assuming.
        const ct = r.contentType ?? 'image/png';
        const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
        const key = `${job.id.replace(/[^a-z0-9]/gi, '_')}/${Date.now()}.${ext}`;
        await this.env.POSTERS.put(key, r.bytes!, { httpMetadata: { contentType: ct } });
        job.poster = { ...job.poster, state: 'complete', r2Key: key };
        this.broadcast('poster', { state: 'complete', key });
      }
      await this.save(job, true);
      await this.savePosterRow(job);
    } catch (e) {
      job.poster = { ...job.poster, state: 'error', error: String(e) };
      await this.save(job, true);
      await this.savePosterRow(job);
    }
  }

  private async savePosterRow(job: JobState) {
    if (!job.poster) return;
    const now = Date.now();
    await this.env.DB.prepare(
      `INSERT INTO posters (id, summary_id, r2_key, state, fal_request_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         r2_key=excluded.r2_key, state=excluded.state, error=excluded.error, updated_at=excluded.updated_at`,
    )
      .bind(
        job.id, job.id, job.poster.r2Key ?? null, job.poster.state,
        job.poster.falRequestId ?? null, job.poster.error ?? null, now, now,
      )
      .run();
  }

  // ---- SSE subscription ----

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/stream')) {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const w = writable.getWriter();
      this.subs.add(w);

      const job = await this.load();
      if (job) {
        const gen = job.generations[job.activeModelId];
        w.write(
          new TextEncoder().encode(
            `event: snapshot\ndata: ${JSON.stringify({
              activeModelId: job.activeModelId,
              content: gen?.content ?? '',
              state: gen?.state ?? 'streaming',
              usedModel: gen?.usedModel,
              poster: job.poster ?? null,
            })}\n\n`,
          ),
        ).catch(() => {});
      }
      req.signal.addEventListener('abort', () => {
        this.subs.delete(w);
        w.close().catch(() => {});
      });
      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    }
    return new Response('not found', { status: 404 });
  }
}
