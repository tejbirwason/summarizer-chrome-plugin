// In-page YouTube transcript extraction.
//
// WHY THIS EXISTS: YouTube blocks transcript fetching by ASN, not just by IP — datacenter
// proxies don't help because the whole cloud ASN is flagged, and residential proxies have
// been observed failing specifically when called from a cloud host. So the fetch can never
// move to a Worker. But it never needed the laptop's Python host either: a content script
// IS the YouTube web client — real session, real cookies, real BotGuard attestation,
// residential IP. Extracting here removes the native-messaging host entirely.
//
// WHY DOM AND NOT timedtext: since ~mid-2025 the captionTracks baseUrl returns an empty
// 200 without a `&pot=` proof-of-origin token minted by BotGuard, which cannot be forged.
// Clicking YouTube's own transcript panel makes YouTube mint it for us; we just read the
// result out of the DOM it renders.
//
// All selectors below were verified live against real videos (2026-07-17). See
// SELECTOR NOTE — they rotate.

(() => {
  // SELECTOR NOTE: YouTube ships two markups simultaneously, exactly like the thumbnail
  // Polymer/view-model split. `ytd-transcript-segment-renderer` is the OLD Polymer name and
  // currently matches NOTHING on the watch page — every video tested rendered the
  // view-model markup. It is kept only as a fallback in case YouTube serves the old layout
  // to some cohort. If both return zero, the selectors rotated again: fix them here.
  const SEG_NEW = 'transcript-segment-view-model';
  const SEG_OLD = 'ytd-transcript-segment-renderer';
  const TS_NEW = '.ytwTranscriptSegmentViewModelTimestamp';
  const TS_OLD = '.segment-timestamp';
  const TX_NEW = 'span.ytAttributedStringHost';
  const TX_OLD = '.segment-text';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function segments() {
    const nu = document.querySelectorAll(SEG_NEW);
    if (nu.length) return { mode: 'view-model', nodes: [...nu], ts: TS_NEW, tx: TX_NEW };
    const old = document.querySelectorAll(SEG_OLD);
    if (old.length) return { mode: 'polymer', nodes: [...old], ts: TS_OLD, tx: TX_OLD };
    return { mode: 'none', nodes: [], ts: '', tx: '' };
  }

  function readSegments() {
    const { mode, nodes, ts, tx } = segments();
    if (!nodes.length) return { mode, rows: [] };
    const rows = [];
    for (const n of nodes) {
      // NEVER use innerText here. Each segment carries a hidden accessibility duration
      // label ("39 minutes, 9 seconds") that innerText interleaves with real speech —
      // measured at 19% junk (47KB raw vs 38KB clean) on a 39-minute video.
      const t = n.querySelector(ts)?.textContent?.trim() ?? '';
      const x = n.querySelector(tx)?.textContent?.trim() ?? '';
      if (x) rows.push({ ts: t, text: x });
    }
    return { mode, rows };
  }

  function findTranscriptButton() {
    return [...document.querySelectorAll('button, tp-yt-paper-button')].find((b) =>
      /^show transcript$/i.test((b.getAttribute('aria-label') || '').trim()),
    );
  }

  /**
   * Opens YouTube's transcript panel and scrapes it.
   * The click is MANDATORY: on a fresh page load the segment count is 0 even though the
   * button is present — the transcript is lazy-loaded on panel open and is NOT sitting in
   * ytInitialData. Verified: 0 segments before click, populated after.
   */
  async function extractTranscript({ timeoutMs = 15000 } = {}) {
    // Already open (e.g. user opened it, or we ran before) — read straight out.
    let got = readSegments();
    if (got.rows.length) return ok(got);

    // WHY THIS IS A POLL, NOT A SINGLE CHECK: users reach the watch page by SPA navigation
    // (clicking a video from the feed), and the description / engagement section that holds
    // the "Show transcript" button re-hydrates asynchronously AFTER the click. The old code
    // clicked #expand, waited 150ms once, and if the button wasn't there yet declared "no
    // captions" — so a captioned video failed purely because the button hadn't rendered.
    // Poll for the button, forcing the metadata area to lazy-render, before believing it's
    // absent. Only when it genuinely never appears is the video truly caption-less.
    const btnDeadline = Date.now() + 9000;
    let btn = null;
    while (Date.now() < btnDeadline) {
      // Nudge YouTube to render the below-the-fold description (lazy on SPA nav).
      (document.querySelector('ytd-watch-metadata') || document.querySelector('#below'))
        ?.scrollIntoView({ block: 'center' });
      // The button lives inside the collapsed description on many layouts — expand it.
      document.querySelector('tp-yt-paper-button#expand, #expand, #description-inline-expander #expand')?.click();
      btn = findTranscriptButton();
      if (btn) break;
      await sleep(300);
    }

    if (!btn) {
      // A missing CC/subtitles control corroborates a genuine no-captions verdict; if CC IS
      // present but the transcript button never rendered, say so honestly rather than
      // claiming the video has no captions when it does.
      const hasCC = !!document.querySelector('.ytp-subtitles-button[aria-pressed], .ytp-subtitles-button');
      return hasCC
        ? { ok: false, reason: 'panel-unavailable', detail: 'Captions exist but YouTube did not expose a transcript panel for this video' }
        : { ok: false, reason: 'no-captions', detail: 'No "Show transcript" control on this video' };
    }
    btn.click();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(250);
      got = readSegments();
      if (got.rows.length) return ok(got);
    }
    // Loud failure: button existed, panel opened, still nothing. That means the markup
    // rotated — do not silently return an empty transcript and summarize nothing.
    return {
      ok: false,
      reason: 'no-segments',
      detail: `Transcript panel opened but no segments matched ${SEG_NEW} or ${SEG_OLD} — selectors likely rotated`,
    };
  }

  function ok({ mode, rows }) {
    return {
      ok: true,
      mode,
      count: rows.length,
      text: rows.map((r) => r.text).join(' '),
      timed: rows,
    };
  }

  window.__ytTranscript = { extractTranscript, readSegments };
})();
