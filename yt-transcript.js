// In-page YouTube transcript extraction — the FALLBACK path.
//
// The PRIMARY transcript source is the com.ytsummary native host (yt-summary.py:
// youtube_transcript_api → Webshare proxy → yt-dlp) — faster (~2s) and it touches nothing on
// the page. This DOM path runs only when that host is missing or fails. It stays because it
// is the one path YouTube can never block: a content script IS the YouTube web client — real
// session, real cookies, real BotGuard attestation, residential IP. (The fetch can never move
// to a Worker: YouTube blocks by cloud ASN, not just IP.)
//
// WHY DOM AND NOT timedtext: since ~mid-2025 the captionTracks baseUrl returns an empty
// 200 without a `&pot=` proof-of-origin token minted by BotGuard, which cannot be forged.
// Clicking YouTube's own transcript panel makes YouTube mint it for us; we just read the
// result out of the DOM it renders.
//
// All selectors below were verified live against real videos (2026-07-17). See
// SELECTOR NOTE — they rotate.

(() => {
  // SELECTOR NOTE: YouTube ships (at least) THREE transcript markups and picks one per page
  // load, seemingly at random — the SAME video rendered view-model markup on one load and
  // Polymer (`ytd-transcript-segment-renderer`) markup an hour later (verified 2026-07-24).
  // There is also a `PAmodern_transcript_view` engagement panel (A/B "modern transcript
  // view") whose segment markup we haven't been able to capture. So: known selectors first,
  // and when they match nothing inside an OPEN transcript panel, a structural fallback parses
  // whatever markup is there by finding timestamp-shaped leaves.
  const SEG_NEW = 'transcript-segment-view-model';
  const SEG_OLD = 'ytd-transcript-segment-renderer';
  const TS_NEW = '.ytwTranscriptSegmentViewModelTimestamp';
  const TS_OLD = '.segment-timestamp';
  const TX_NEW = 'span.ytAttributedStringHost';
  const TX_OLD = '.segment-text';

  const TS_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/;           // 0:00 / 12:34 / 1:02:03
  const A11Y_RE = /\d+\s+(?:second|minute|hour)/i;      // hidden a11y duration labels

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The transcript engagement panel that is open RIGHT NOW. Panels accumulate across SPA
  // navigations (hidden, still holding the previous video's rows), so scoping reads to the
  // expanded panel is what guarantees we never read another video's transcript. Matches both
  // `engagement-panel-searchable-transcript` and the A/B `PAmodern_transcript_view`.
  function expandedTranscriptPanel() {
    return [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer')]
      .find((p) => (p.getAttribute('visibility') || '').includes('EXPANDED') &&
                   /transcript/i.test(p.getAttribute('target-id') || ''));
  }

  function knownSegments(root) {
    const nu = root.querySelectorAll(SEG_NEW);
    if (nu.length) return { mode: 'view-model', nodes: [...nu], ts: TS_NEW, tx: TX_NEW };
    const old = root.querySelectorAll(SEG_OLD);
    if (old.length) return { mode: 'polymer', nodes: [...old], ts: TS_OLD, tx: TX_OLD };
    return null;
  }

  // Markup-agnostic fallback for when YouTube rotates selectors (e.g. the modern transcript
  // view). Finds leaf elements whose text is exactly a timestamp, climbs to the row that also
  // holds the speech, and takes the longest non-timestamp, non-a11y leaf text as the speech.
  function genericRows(panel) {
    const seen = new Set();
    const rows = [];
    const tsEls = [...panel.querySelectorAll('div,span')].filter(
      (el) => !el.childElementCount && TS_RE.test((el.textContent || '').trim()));
    for (const t of tsEls) {
      const tsText = (t.textContent || '').trim();
      let row = t.parentElement;
      while (row && row !== panel && (row.textContent || '').trim().length <= tsText.length + 2) {
        row = row.parentElement;
      }
      if (!row || row === panel || seen.has(row)) continue;
      seen.add(row);
      const leaves = [...row.querySelectorAll('*')]
        .filter((e) => !e.childElementCount)
        .map((e) => (e.textContent || '').trim())
        .filter((s) => s && !TS_RE.test(s) && !A11Y_RE.test(s));
      const text = leaves.sort((a, b) => b.length - a.length)[0] || '';
      if (text) rows.push({ ts: tsText, text });
    }
    return rows;
  }

  function readSegments() {
    // Prefer the open panel; fall back to a document-wide read only when no panel is open
    // (pre-click fast path on layouts whose panel visibility attribute we can't see).
    const panel = expandedTranscriptPanel();
    const k = knownSegments(panel || document);
    if (!k) {
      if (panel) {
        const rows = genericRows(panel);
        if (rows.length) return { mode: 'generic', rows };
      }
      return { mode: 'none', rows: [] };
    }
    const rows = [];
    for (const n of k.nodes) {
      // NEVER use innerText here. Each segment carries a hidden accessibility duration
      // label ("39 minutes, 9 seconds") that innerText interleaves with real speech —
      // measured at 19% junk (47KB raw vs 38KB clean) on a 39-minute video.
      const t = n.querySelector(k.ts)?.textContent?.trim() ?? '';
      const x = n.querySelector(k.tx)?.textContent?.trim() ?? '';
      if (x) rows.push({ ts: t, text: x });
    }
    return { mode: k.mode, rows };
  }

  function findTranscriptButton() {
    // There are often TWO matching buttons (one in the description, one inside the hidden
    // structured-description panel). Clicking the hidden one opens nothing — prefer the one
    // that actually has layout.
    const all = [...document.querySelectorAll('button, tp-yt-paper-button')].filter((b) =>
      /^show transcript$/i.test((b.getAttribute('aria-label') || '').trim()));
    return all.find((b) => b.getClientRects().length > 0) || all[0] || null;
  }

  // ---- Stale-panel guard -----------------------------------------------------------------
  // YouTube's SPA navigation (watch page → related video) HIDES the old transcript panel but
  // does not empty it. So right after navigating, readSegments() still returns the PREVIOUS
  // video's rows, and the "already open — read straight out" shortcut happily summarized the
  // wrong video. At every SPA navigation we fingerprint whatever rows currently exist — by
  // definition they belong to the page we just left — and refuse to return rows matching that
  // fingerprint. A fresh panel open replaces the content, the fingerprint stops matching, and
  // only then do we accept the read.
  let staleFp = null;

  function fingerprint(rows) {
    if (!rows.length) return null;
    const first = rows[0].text, last = rows[rows.length - 1].text;
    return `${rows.length}:${first.length + last.length}:${first}:${last}`;
  }

  function markCurrentRowsStale() {
    const fp = fingerprint(readSegments().rows);
    if (fp) staleFp = fp;
  }

  // content scripts receive these page-dispatched events (content-dual.js relies on the same).
  // -start fires at click time, -finish when the new page's data lands; stamping at both closes
  // the window where an extraction could begin between them and still see pre-nav rows.
  document.addEventListener('yt-navigate-start', markCurrentRowsStale);
  document.addEventListener('yt-navigate-finish', markCurrentRowsStale);
  window.addEventListener('popstate', markCurrentRowsStale);

  function isFresh(got) {
    return got.rows.length > 0 && fingerprint(got.rows) !== staleFp;
  }

  /**
   * Opens YouTube's transcript panel and scrapes it.
   * The click is MANDATORY: on a fresh page load the segment count is 0 even though the
   * button is present — the transcript is lazy-loaded on panel open and is NOT sitting in
   * ytInitialData. Verified: 0 segments before click, populated after.
   */
  async function extractTranscript({ timeoutMs = 15000 } = {}) {
    // DON'T MOVE THE PAGE. Two distinct scroll sources have to be defeated:
    //  1. Our own scrollIntoView nudge — now allowed ONLY in hidden background tabs.
    //  2. YouTube itself: clicking #expand / "Show transcript" makes YouTube scroll the
    //     description or panel into view (observed +1820px, sometimes landing AFTER extraction
    //     returns because it's a smooth scroll). So once we've clicked anything, pin the scroll
    //     back on every poll tick and for a short window after returning. Genuine user input
    //     (wheel/touch/keys) cancels pinning instantly so the reader is never yanked around.
    const sx = window.scrollX, sy = window.scrollY;
    let acted = false, userMoved = false;
    const sawUser = () => { userMoved = true; };
    const USER_EVENTS = ['wheel', 'touchmove', 'keydown', 'mousedown'];
    USER_EVENTS.forEach((e) => window.addEventListener(e, sawUser, { passive: true }));
    const cleanup = () => USER_EVENTS.forEach((e) => window.removeEventListener(e, sawUser));
    const restore = () => { if (acted && !userMoved) try { window.scrollTo(sx, sy); } catch (_) {} };

    try {
      // Already open (e.g. user opened it, or we ran before) — read straight out. isFresh
      // rejects rows fingerprint-stamped at the last SPA navigation: they belong to the
      // PREVIOUS video, and returning them here is how a related-video click used to
      // re-summarize the video you just left.
      let got = readSegments();
      if (isFresh(got)) return ok(got);

      // WHY THIS IS A POLL, NOT A SINGLE CHECK: users reach the watch page by SPA navigation
      // (clicking a video from the feed), and the description / engagement section that holds
      // the "Show transcript" button re-hydrates asynchronously AFTER the click. The old code
      // clicked #expand, waited 150ms once, and if the button wasn't there yet declared "no
      // captions" — so a captioned video failed purely because the button hadn't rendered.
      // Poll for the button before believing it's absent. Only when it genuinely never appears
      // is the video truly caption-less.
      //
      // NO-SCROLL ON VISIBLE PAGES: on the foreground watch page the description is already
      // hydrated, so clicking #expand alone surfaces the button with zero page movement. The
      // scroll nudge (needed on not-yet-rendered background tabs opened by the feed-tile path)
      // is gated on document.hidden — a page the user is looking at is NEVER scrolled, period.
      const btnDeadline = Date.now() + 9000;
      const scrollNudgeAfter = Date.now() + 1500;  // give expand-only a fair chance first
      let btn = null;
      while (Date.now() < btnDeadline) {
        // The button lives inside the collapsed description on many layouts — expand it.
        const exp = document.querySelector('tp-yt-paper-button#expand, #expand, #description-inline-expander #expand');
        if (exp) { acted = true; exp.click(); }
        btn = findTranscriptButton();
        if (btn) break;
        // Hidden-tab-only: nudge the lazy metadata area to render. Restored at the end.
        if (document.hidden && Date.now() > scrollNudgeAfter) {
          acted = true;
          (document.querySelector('ytd-watch-metadata') || document.querySelector('#below'))
            ?.scrollIntoView({ block: 'nearest' });
        }
        await sleep(300);
        restore();
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
      acted = true;
      btn.click();

      const deadline = Date.now() + timeoutMs;
      let reclickAt = Date.now() + 4000;
      while (Date.now() < deadline) {
        await sleep(250);
        restore();
        // A click can get swallowed (button re-rendered under us). If no transcript panel has
        // expanded after a few seconds, click again rather than polling a closed panel to the
        // timeout.
        if (!expandedTranscriptPanel() && Date.now() > reclickAt) {
          findTranscriptButton()?.click();
          reclickAt = Date.now() + 4000;
        }
        got = readSegments();
        // isFresh (not .length): right after the click the panel can still hold the previous
        // video's rows for a beat before YouTube swaps in the new transcript. Keep polling
        // until the content actually changes.
        if (isFresh(got)) return ok(got);
      }
      // Loud failure: button existed, panel opened, still nothing usable. Distinguish "only
      // stale rows" (panel never refreshed for this video) from "no rows" (markup rotated),
      // and say which panel we were looking at — that's the first question when debugging.
      const p = expandedTranscriptPanel();
      const where = p
        ? `open panel ${p.getAttribute('target-id')} with ${p.querySelectorAll('*').length} nodes`
        : 'no transcript panel ever expanded';
      return got.rows.length
        ? { ok: false, reason: 'stale-panel', detail: `Transcript panel still shows the previous video — YouTube never refreshed it (${where})` }
        : {
            ok: false,
            reason: 'no-segments',
            detail: `No transcript rows found (${where}) — selectors likely rotated`,
          };
    } finally {
      restore();
      if (acted && !userMoved) {
        // YouTube's panel/description scroll is smooth and can land AFTER we return — keep
        // pinning for a beat, then detach. Any user input still cancels via sawUser.
        const iv = setInterval(restore, 100);
        setTimeout(() => { clearInterval(iv); cleanup(); }, 1200);
      } else {
        cleanup();
      }
    }
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
