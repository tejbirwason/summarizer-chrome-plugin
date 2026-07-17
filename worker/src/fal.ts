// Port of ~/.claude/skills/explain-viz/scripts/render.sh. Style, size and mode strings are
// copied verbatim so a cloud-rendered poster is indistinguishable from a local one.
//
// This replaces the whole "Open in Claude Code -> /explain-viz -> save PNG" detour. Claude
// Code was only ever the runtime that could reach fal; a Worker reaches it directly, which
// is why the two buttons collapse into one.

const MODEL = 'fal-ai/gpt-image-2';
const BASE = `https://queue.fal.run/${MODEL}`;
const WIDTH = 3584;
const HEIGHT = 2016; // exact 16:9, multiples of 16, ~7.2 MP (under fal's ~8.3 MP cap)

const STYLE =
  'Sophisticated editorial explainer-graphic style as in The New Yorker or the Financial Times ' +
  'graphics desk: restrained hand-inked linework with selective muted spot color, intelligent and ' +
  'adult, elegant typography, subtle warm paper texture. Refined and hand-crafted, never corporate ' +
  'clip-art. No cute mascot or cartoon character.';

const DENSITY_POSTER =
  'Turn the text above into ONE rich, information-DENSE editorial INFOGRAPHIC that teaches the whole ' +
  'topic at a glance. Walk through the key points using several labeled elements, small spot diagrams, ' +
  'arrows, callouts and short annotations - like a full-page explainer graphic on the Financial Times ' +
  'graphics desk. Pack in the real specifics: names, numbers, and the step-by-step. Do NOT gloss over ' +
  'nuance: keep the caveats, exceptions, conditions, uncertainties and opposing viewpoints the text ' +
  'raises - not only the headline claims. Landscape orientation. All text must be crisp, legible English.';

// render.sh's hard cap is 32000, but there is a QUALITY CLIFF around 15000: past it fal
// happily returns a generic, off-topic poster with status COMPLETED and no error at all.
// We feed the summary (a few KB), not the transcript, so this should never trigger —
// truncate rather than silently render the wrong picture.
const SOFT_CAP = 15_000;

export function buildPrompt(title: string, summary: string): string {
  let content = `${title}\n\n${summary}`.trim();
  if (content.length > SOFT_CAP) content = content.slice(0, SOFT_CAP);
  return `${content}\n\n${DENSITY_POSTER}\n\nSTYLE: ${STYLE}`;
}

export async function submitPoster(falKey: string, title: string, summary: string): Promise<string> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: buildPrompt(title, summary),
      image_size: { width: WIDTH, height: HEIGHT },
      quality: 'high',
    }),
  });
  const j = (await res.json()) as { request_id?: string; detail?: unknown };
  if (!res.ok || !j.request_id) {
    throw new Error(`fal submit ${res.status}: ${JSON.stringify(j.detail ?? j).slice(0, 200)}`);
  }
  return j.request_id;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'error'; error: string }
  | { status: 'done'; bytes: ArrayBuffer; contentType?: string };

export async function pollPoster(falKey: string, requestId: string): Promise<PollResult> {
  const auth = { Authorization: `Key ${falKey}` };

  const st = await fetch(`${BASE}/requests/${requestId}/status`, { headers: auth });
  const sj = (await st.json()) as { status?: string };
  if (sj.status !== 'COMPLETED') return { status: 'pending' };

  const rs = await fetch(`${BASE}/requests/${requestId}`, { headers: auth });
  const rj = (await rs.json()) as any;
  const url: string | undefined = rj?.images?.[0]?.url ?? rj?.image?.url;

  if (!url) {
    // render.sh's sharpest gotcha: a REJECTED request lands here, not at submit, and with
    // status COMPLETED. The real reason hides in .detail — without this branch it would
    // look like a mysterious empty success.
    const det = rj?.detail?.[0]?.msg ?? rj?.detail ?? 'no image in fal response';
    return { status: 'error', error: String(det).slice(0, 300) };
  }

  const img = await fetch(url);
  if (!img.ok) return { status: 'error', error: `fal image fetch ${img.status}` };
  return {
    status: 'done',
    bytes: await img.arrayBuffer(),
    contentType: img.headers.get('content-type') ?? undefined,
  };
}
