// content-dual.js — the universal summary renderer.
//
// The background service worker OWNS all summary state + persistence (see background.js). This
// content script is a thin, reactive VIEW: on load it asks the background for this URL's job
// state (getPageState) and rehydrates; while a summary streams it appends deltas; it never
// persists anything itself. Because the background keeps generating even with no live tab, a
// summary survives navigating away — and this script simply re-attaches to it when the page
// (or another tab of the same URL) loads.

if (typeof window.claudeSummarizerInitialized === 'undefined') {
  window.claudeSummarizerInitialized = true;

  // === Design tokens (from the readability research) — deep-neutral grays, off-white text,
  // teal + amber accents (deliberately NOT blue). ===
  const T = {
    surface0: '#141414', surface1: '#1b1b1b', surface2: '#262626', surface3: '#323232',
    textPrimary: '#e5e7eb', textSecondary: '#9ca3af', textMuted: '#6b7280', textError: '#f4a3a3',
    accent: '#5be4c8', accentInk: '#04201b', amber: '#f5c164',
    borderSubtle: '#2a2a2a', borderStrong: '#3a3a3a',
    userBubble: '#2b2f3a'
  };

  // === View state — a local mirror of the background's job for THIS url. ===
  const S = {
    config: null,
    url: normUrl(location.href),
    fullUrl: location.href,
    title: document.title,
    activeModelId: null,
    prompt: '',
    isTranscript: false,
    videoId: currentVideoId(),
    models: {},          // modelId -> { messages, streaming, inProgress, complete, usedModel, duration }
    hasSaved: false,     // page already has a saved summary
    view: 'summary',     // 'summary' | 'history'
    foreignUrl: null,    // when viewing ANOTHER page's saved summary (read-only)
    poster: null,        // { dataUrl } | { tooLarge, path } | null
    posterTried: false,
    resyncing: false
  };

  // ---------------------------------------------------------------------------
  // Extension-context liveness (unchanged behaviour: a reloaded extension orphans this script;
  // detect it, stop spinners, tell the user to refresh).
  // ---------------------------------------------------------------------------
  function extensionAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function showStaleBanner() {
    if (document.getElementById('claude-stale-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'claude-stale-banner';
    banner.textContent = '⚠️ Extension was reloaded — refresh this page to use the summarizer.';
    banner.style.cssText = `position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483000;
      background: #4a2c2c; color: #ffd7d7; border: 1px solid #a33; border-radius: 8px; padding: 10px 16px;
      font-size: 13px; font-family: ${'system-ui, -apple-system, sans-serif'}; box-shadow: 0 2px 10px rgba(0,0,0,0.4); cursor: pointer;`;
    banner.onclick = () => location.reload();
    document.body.appendChild(banner);
  }
  function handleDeadContext() {
    document.querySelectorAll('.fab').forEach(fab => { if (fab.setLoading) fab.setLoading(false); });
    showStaleBanner();
  }
  function isContextGone(err) {
    return !extensionAlive() || /context invalidated/i.test(err?.message || '');
  }
  function sendToBackground(msg, callback) {
    if (!extensionAlive()) { handleDeadContext(); return false; }
    try {
      const maybePromise = callback ? chrome.runtime.sendMessage(msg, callback) : chrome.runtime.sendMessage(msg);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch((err) => { if (isContextGone(err)) handleDeadContext(); else console.error('[summarizer] sendMessage failed:', err); });
      }
      return true;
    } catch (e) {
      if (isContextGone(e)) { handleDeadContext(); return false; }
      console.error('[summarizer] sendMessage failed:', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function normUrl(u) {
    try {
      const url = new URL(u);
      let key = `${url.origin}${url.pathname}`;
      // Keep YouTube's ?v= in the key (see background.js normUrl) so each video is its own summary.
      if (/(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/watch') {
        const v = url.searchParams.get('v');
        if (v) key += `?v=${v}`;
      }
      return key;
    } catch (e) { return u || ''; }
  }
  function currentVideoId() {
    try {
      if (/(^|\.)youtube\.com$/.test(location.hostname) && location.pathname === '/watch') {
        return new URLSearchParams(location.search).get('v') || '';
      }
    } catch (e) {}
    return '';
  }

  // YouTube (and many SPAs) change location.href without reloading, so the content script
  // survives with a STALE S.url. Then initSummary arrives with the new video's key, forThisUrl
  // fails, and the panel never opens. Always re-sync identity from the live location.
  function syncPageIdentity() {
    const live = location.href;
    const n = normUrl(live);
    if (n === S.url && live === S.fullUrl) {
      // Same key — still refresh title/videoId (SPA title often lags the first paint).
      S.title = document.title || S.title;
      S.videoId = currentVideoId() || S.videoId;
      return false;
    }
    const hadPanel = Boolean(document.getElementById('claude-summary-container'));
    S.url = n;
    S.fullUrl = live;
    S.title = document.title || S.title;
    S.videoId = currentVideoId();
    S.models = {};
    S.hasSaved = false;
    S.foreignUrl = null;
    S.poster = null;
    S.posterTried = false;
    S.activeModelId = S.activeModelId || S.config?.models?.[0]?.id || null;
    S._pillDismissed = false;
    if (hadPanel) {
      const p = document.getElementById('claude-summary-container');
      if (p) p.remove();
    }
    dismissReopenPill();
    // Rehydrate any saved/in-progress job for the page we just landed on (auto-opens if streaming).
    loadPageState(false);
    return true;
  }

  /** Open the panel if closed — used so stream events still surface when initSummary was missed. */
  function ensurePanelOpen() {
    S.view = 'summary';
    openPanel();
  }
  function formatAge(ts) {
    if (!ts) return '';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
  function allModels() {
    if (!S.config) return [];
    return [...(S.config.models || []), ...(S.config.alternateModels || [])];
  }
  function modelMeta(id) {
    const m = allModels().find(x => x.id === id);
    return m ? { id: m.id, name: m.name, icon: m.icon } : null;
  }
  function activeMeta() {
    const m = S.models[S.activeModelId];
    return (m && m.usedModel) || modelMeta(S.activeModelId) || (S.config?.models?.[0] && modelMeta(S.config.models[0].id)) || { id: '', name: 'AI', icon: '✨' };
  }
  function ensureLocalModel(id) {
    if (!S.models[id]) {
      S.models[id] = { messages: [], streaming: '', inProgress: false, complete: false, usedModel: modelMeta(id), duration: null };
    }
    return S.models[id];
  }
  function renderMarkdown(text) {
    if (!text) return '';
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return escapeHtml(text);
    try { return DOMPurify.sanitize(marked.parse(text)); } catch (e) { return escapeHtml(text); }
  }
  function escapeHtml(s) {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
  }
  function playCompletionSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const note = (freq, start, dur) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        gain.gain.setValueAtTime(0.25, start); gain.gain.exponentialRampToValueAtTime(0.01, start + dur);
        osc.start(start); osc.stop(start + dur);
      };
      const now = ctx.currentTime; note(523.25, now, 0.14); note(659.25, now + 0.14, 0.18);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Styles — one injected sheet using the token palette. Classes prefixed `cs-`.
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('cs-styles')) return;
    const s = document.createElement('style');
    s.id = 'cs-styles';
    s.textContent = `
      @keyframes cs-spin { to { transform: rotate(360deg); } }
      @keyframes cs-pulse { 0%,100% { opacity: .25; } 50% { opacity: 1; } }
      #claude-summary-container, #claude-summary-container * { box-sizing: border-box; }
      #claude-summary-container {
        position: fixed; top: 20px; right: 20px; width: 420px; height: min(85vh, 760px);
        background: ${T.surface0}; color: ${T.textPrimary}; border: 1px solid ${T.borderSubtle};
        border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.55); z-index: 2147483600;
        display: flex; flex-direction: column; overflow: hidden;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 15.5px; line-height: 1.5;
      }
      .cs-masthead { background: ${T.surface0}; border-bottom: 1px solid ${T.borderSubtle}; flex-shrink: 0; }
      .cs-titlebar { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 14px; cursor: move; }
      .cs-title { font-size: 13.5px; font-weight: 600; color: ${T.textPrimary}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
      .cs-iconbtn { border: none; background: none; color: ${T.textSecondary}; cursor: pointer; font-size: 15px;
        width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
        transition: background .15s, color .15s; padding: 0; }
      .cs-iconbtn:hover { background: ${T.surface2}; color: ${T.textPrimary}; }
      .cs-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
      .cs-modelpick { display: flex; align-items: center; gap: 6px; background: ${T.surface2}; border: 1px solid ${T.borderStrong};
        color: ${T.textPrimary}; border-radius: 9px; padding: 6px 10px; cursor: pointer; font-size: 13px; font-weight: 500;
        flex: 1; min-width: 0; }
      .cs-modelpick:hover { border-color: ${T.accent}; }
      .cs-modelpick .cs-mp-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: left; }
      .cs-modelpick .cs-mp-caret { color: ${T.textMuted}; font-size: 10px; }
      .cs-tbtn { border: 1px solid ${T.borderStrong}; background: ${T.surface2}; color: ${T.textSecondary}; cursor: pointer;
        border-radius: 9px; padding: 6px 9px; font-size: 13px; display: flex; align-items: center; gap: 5px; transition: all .15s; }
      .cs-tbtn:hover { color: ${T.textPrimary}; border-color: ${T.accent}; }
      .cs-tbtn.cs-on { color: ${T.accentInk}; background: ${T.accent}; border-color: ${T.accent}; }
      .cs-promptbox { padding: 2px 10px 12px; }
      .cs-promptbox textarea { width: 100%; background: ${T.surface2}; border: 1px solid ${T.borderStrong}; color: ${T.textPrimary};
        border-radius: 9px; padding: 9px 11px; font: inherit; font-size: 13px; line-height: 1.5; resize: vertical; min-height: 64px; display: block; }
      .cs-promptbox textarea:focus { outline: none; border-color: ${T.accent}; }
      .cs-promptbox .cs-prow { display: flex; gap: 8px; margin-top: 9px; align-items: center; flex-wrap: wrap; }
      .cs-promptbox .cs-prow .cs-hint { flex-basis: 100%; margin: 2px 0 0; }
      .cs-hint { color: ${T.textMuted}; font-size: 11.5px; line-height: 1.4; }
      .cs-btn-primary { background: ${T.accent}; color: ${T.accentInk}; border: none; border-radius: 8px; padding: 8px 14px;
        font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
      .cs-btn-primary:hover { filter: brightness(1.07); }
      .cs-btn-primary:disabled { opacity: .5; cursor: default; filter: none; }
      .cs-btn-ghost { background: none; color: ${T.textSecondary}; border: 1px solid ${T.borderStrong}; border-radius: 8px;
        padding: 8px 14px; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
      .cs-btn-ghost:hover { color: ${T.textPrimary}; border-color: ${T.borderStrong}; background: ${T.surface2}; }

      .cs-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 16px; background: ${T.surface1}; }
      .cs-scroll::-webkit-scrollbar { width: 10px; }
      .cs-scroll::-webkit-scrollbar-thumb { background: ${T.surface3}; border-radius: 10px; border: 2px solid ${T.surface1}; }

      .cs-poster { margin: 0 0 14px; border: 1px solid ${T.borderStrong}; border-radius: 10px; overflow: hidden; cursor: zoom-in; background: ${T.surface2}; }
      .cs-poster img { display: block; width: 100%; height: auto; }
      .cs-poster-large { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }

      .cs-summary { color: ${T.textPrimary}; }
      .cs-turn { margin-top: 14px; }
      .cs-turn-label { font-size: 12.5px; font-weight: 600; color: ${T.textMuted}; margin-bottom: 5px; }
      .cs-user { display: flex; justify-content: flex-end; }
      .cs-user .cs-user-inner { max-width: 86%; background: ${T.userBubble}; color: ${T.textPrimary};
        border-radius: 13px 13px 4px 13px; padding: 9px 12px; font-size: 14.5px; white-space: pre-wrap; word-wrap: break-word; }
      .cs-assistant { color: ${T.textPrimary}; }
      .cs-generating { display: flex; align-items: center; gap: 9px; color: ${T.textSecondary}; padding: 14px 2px; font-size: 14px; }
      .cs-dot { width: 8px; height: 8px; border-radius: 50%; background: ${T.amber}; animation: cs-pulse 1.1s ease-in-out infinite; }
      .cs-skel { height: 12px; border-radius: 6px; background: ${T.surface3}; margin: 10px 0; animation: cs-pulse 1.4s ease-in-out infinite; }
      .cs-caret { display: inline-block; width: 7px; height: 15px; margin-left: 2px; background: ${T.accent}; vertical-align: text-bottom; animation: cs-pulse 1s ease-in-out infinite; border-radius: 2px; }
      .cs-error { color: ${T.textError}; background: rgba(244,163,163,.08); border: 1px solid rgba(244,163,163,.25); border-radius: 9px; padding: 10px 12px; font-size: 14px; }
      .cs-meta { color: ${T.textMuted}; font-size: 11.5px; margin-top: 8px; }

      .cs-composer { flex-shrink: 0; border-top: 1px solid ${T.borderSubtle}; background: ${T.surface0}; padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
      .cs-composer textarea { flex: 1; background: ${T.surface2}; border: 1px solid ${T.borderStrong}; color: ${T.textPrimary};
        border-radius: 11px; padding: 9px 12px; font: inherit; font-size: 14.5px; line-height: 1.4; resize: none; min-height: 40px; max-height: 120px; }
      .cs-composer textarea:focus { outline: none; border-color: ${T.accent}; }
      .cs-send { flex-shrink: 0; width: 40px; height: 40px; border-radius: 11px; border: none; background: ${T.accent}; color: ${T.accentInk};
        font-size: 17px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .cs-send:disabled { opacity: .4; cursor: default; }

      /* Jump-to-latest (appears when a response streams offscreen while the reader is scrolled up) */
      .cs-jump { position: absolute; right: 16px; bottom: 74px; z-index: 3; display: none; align-items: center; gap: 6px;
        background: ${T.accent}; color: ${T.accentInk}; border: none; border-radius: 999px; padding: 7px 13px;
        font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); }
      .cs-jump:hover { filter: brightness(1.07); }

      /* History */
      .cs-hist-item { display: flex; gap: 10px; padding: 11px 12px; border: 1px solid ${T.borderSubtle}; border-radius: 11px;
        margin-bottom: 9px; cursor: pointer; background: ${T.surface2}; transition: border-color .15s, background .15s; }
      .cs-hist-item:hover { border-color: ${T.accent}; background: ${T.surface3}; }
      .cs-hist-ico { font-size: 18px; line-height: 1.3; flex-shrink: 0; }
      .cs-hist-body { min-width: 0; flex: 1; }
      .cs-hist-title { font-size: 14px; font-weight: 600; color: ${T.textPrimary}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .cs-hist-snip { font-size: 12.5px; color: ${T.textSecondary}; margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .cs-hist-meta { font-size: 11.5px; color: ${T.textMuted}; margin-top: 5px; display: flex; gap: 8px; align-items: center; }
      .cs-hist-del { border: none; background: none; color: ${T.textMuted}; cursor: pointer; font-size: 14px; align-self: center; padding: 4px; border-radius: 6px; }
      .cs-hist-del:hover { color: ${T.textError}; background: ${T.surface0}; }
      .cs-empty { color: ${T.textMuted}; text-align: center; padding: 40px 20px; font-size: 14px; }

      /* Model dropdown */
      .cs-menu { position: absolute; background: ${T.surface2}; border: 1px solid ${T.borderStrong}; border-radius: 11px;
        padding: 5px; z-index: 2147483601; min-width: 210px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
      .cs-menu-h { color: ${T.textMuted}; font-size: 11px; padding: 6px 10px 4px; letter-spacing: .04em; text-transform: uppercase; }
      .cs-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none;
        color: ${T.textPrimary}; font: inherit; font-size: 13.5px; padding: 8px 10px; cursor: pointer; border-radius: 8px; }
      .cs-menu-item:hover { background: ${T.surface3}; }
      .cs-menu-item .cs-check { margin-left: auto; color: ${T.accent}; }

      /* Reopen pill (page already summarized) */
      #cs-reopen-pill { position: fixed; bottom: 20px; right: 20px; z-index: 2147483500; display: flex; align-items: center; gap: 8px;
        background: ${T.surface2}; color: ${T.textPrimary}; border: 1px solid ${T.borderStrong}; border-radius: 999px;
        padding: 9px 14px 9px 12px; font-family: system-ui, -apple-system, sans-serif; font-size: 13px; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.4); transition: border-color .15s, transform .15s; }
      #cs-reopen-pill:hover { border-color: ${T.accent}; transform: translateY(-1px); }
      #cs-reopen-pill .cs-pill-x { color: ${T.textMuted}; font-size: 15px; margin-left: 2px; }

      /* Markdown */
      .cs-md h1,.cs-md h2,.cs-md h3,.cs-md h4 { margin: 16px 0 8px; font-weight: 600; line-height: 1.3; color: ${T.textPrimary}; letter-spacing: -.01em; }
      .cs-md h1 { font-size: 19px; } .cs-md h2 { font-size: 17px; } .cs-md h3 { font-size: 15.5px; } .cs-md h4 { font-size: 14.5px; }
      .cs-md p { margin: 0 0 .75em; }
      .cs-md ul,.cs-md ol { margin: 0 0 .75em; padding-left: 22px; } .cs-md li { margin-bottom: 4px; }
      .cs-md a { color: ${T.accent}; text-decoration: none; } .cs-md a:hover { text-decoration: underline; }
      .cs-md strong { font-weight: 600; color: ${T.textPrimary}; }
      .cs-md code { background: #202020; color: #f0d9b5; padding: .1em .35em; border-radius: 4px; font-family: "SF Mono", Menlo, monospace; font-size: 13px; }
      .cs-md pre { background: #1a1a1a; border: 1px solid ${T.borderSubtle}; border-radius: 10px; padding: 12px; overflow-x: auto; margin: 0 0 .75em; }
      .cs-md pre code { background: none; color: ${T.textPrimary}; padding: 0; }
      .cs-md blockquote { border-left: 3px solid ${T.accent}; margin: 12px 0; padding: 2px 0 2px 12px; color: ${T.textSecondary}; }
      .cs-md hr { border: none; border-top: 1px solid ${T.borderSubtle}; margin: 16px 0; }
      .cs-md table { border-collapse: collapse; width: 100%; margin: 0 0 .75em; font-size: 13.5px; }
      .cs-md th,.cs-md td { border: 1px solid ${T.borderStrong}; padding: 6px 9px; text-align: left; }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ===========================================================================
  // FABs (selection actions): ✨ Summarize + 🖥️ Open in Claude Code.
  // ===========================================================================
  function injectFABs() {
    injectStyles();
    const bar = document.createElement('div');
    bar.id = 'fab-container';
    bar.style.cssText = `position: fixed; top: 18px; left: 50%; transform: translateX(-50%); display: none; gap: 8px; z-index: 2147483500;`;

    function makeFab(emoji, bg, title) {
      const btn = document.createElement('button');
      btn.className = 'fab';
      btn.innerHTML = emoji; btn.title = title; btn._emoji = emoji;
      btn.style.cssText = `width: 42px; height: 42px; border-radius: 50%; background: ${bg}; color: ${T.textPrimary};
        border: 1px solid ${T.borderStrong}; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.4);
        display: flex; align-items: center; justify-content: center; font-size: 18px; transition: transform .12s, filter .12s;`;
      btn.onmouseover = () => { if (!btn.disabled) btn.style.transform = 'scale(1.08)'; };
      btn.onmouseout = () => { if (!btn.disabled) btn.style.transform = 'scale(1)'; };
      btn.setLoading = (loading) => {
        btn.disabled = loading;
        btn.style.cursor = loading ? 'wait' : 'pointer';
        btn.innerHTML = loading
          ? `<div style="width:16px;height:16px;border:2px solid ${T.accent};border-top-color:transparent;border-radius:50%;animation:cs-spin 1s linear infinite;"></div>`
          : btn._emoji;
      };
      return btn;
    }

    const summarizeFab = makeFab('✨', T.surface2, 'Summarize selection');
    const ccFab = makeFab('🖥️', T.surface2, 'Open selection in Claude Code');

    summarizeFab.onclick = () => {
      const text = window.getSelection().toString().trim();
      if (!text) return;
      summarizeFab.setLoading(true);
      startNewSummary(text);
    };
    ccFab.onclick = () => {
      const text = window.getSelection().toString().trim();
      if (!text) return;
      ccFab.setLoading(true);
      sendToBackground({ action: 'openInCC', text, title: S.title, url: S.fullUrl });
    };

    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection().toString().trim();
      bar.style.display = sel ? 'flex' : 'none';
    });

    bar.appendChild(summarizeFab);
    bar.appendChild(ccFab);
    document.body.appendChild(bar);
  }

  function startNewSummary(text) {
    // Optimistically open the panel with a generating state for the preferred model.
    const modelId = S.activeModelId || S.config?.models?.[0]?.id;
    S.isTranscript = false;
    S.activeModelId = modelId;
    const m = ensureLocalModel(modelId);
    m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false;
    S.view = 'summary';
    openPanel();
    sendToBackground({ action: 'summarizeDual', text, url: S.fullUrl, title: S.title, prompt: S.prompt || undefined });
  }

  // ===========================================================================
  // Panel construction
  // ===========================================================================
  function panelEl() { return document.getElementById('claude-summary-container'); }

  function openPanel() {
    injectStyles();
    let panel = panelEl();
    if (!panel) { panel = buildPanel(); S._freshOpen = true; }  // land at the last meaningful turn (P11)
    dismissReopenPill();
    // The panel now shows the generating state, so the selection FAB's spinner is redundant.
    document.querySelectorAll('.fab').forEach(f => { if (f.setLoading) f.setLoading(false); });
    render();
    return panel;
  }
  function closePanel() {
    const p = panelEl();
    if (p) p.remove();
    if (S.foreignUrl) {
      // We were viewing another page's summary — restore THIS page's own state so the reopen
      // pill (and any later reopen) reflects the current page, not the one we were browsing.
      S.foreignUrl = null; S.poster = null; S.posterTried = false;
      loadPageState(false);
      return;
    }
    maybeShowReopenPill();
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'claude-summary-container';

    // --- Masthead ---
    const masthead = document.createElement('div');
    masthead.className = 'cs-masthead';

    const titlebar = document.createElement('div');
    titlebar.className = 'cs-titlebar';
    enableDrag(titlebar, panel);

    const titleEl = document.createElement('div');
    titleEl.className = 'cs-title';
    titleEl.id = 'cs-title';
    titleEl.textContent = 'AI Summary';

    const histBtn = iconBtn('🕘', 'History', () => toggleHistory());
    const copyBtn = iconBtn('📄', 'Copy source text', copySource);
    copyBtn.id = 'cs-copy';
    const closeBtn = iconBtn('✕', 'Close', closePanel);

    titlebar.appendChild(titleEl);
    titlebar.appendChild(histBtn);
    titlebar.appendChild(copyBtn);
    titlebar.appendChild(closeBtn);

    // --- Toolbar: model picker + prompt toggle + regenerate ---
    const toolbar = document.createElement('div');
    toolbar.className = 'cs-toolbar';
    toolbar.id = 'cs-toolbar';

    const picker = document.createElement('button');
    picker.className = 'cs-modelpick';
    picker.id = 'cs-modelpick';
    picker.onclick = (e) => { e.stopPropagation(); showModelMenu(picker); };
    picker.innerHTML = `<span class="cs-mp-ico"></span><span class="cs-mp-name"></span><span class="cs-mp-caret">▾</span>`;

    const promptBtn = document.createElement('button');
    promptBtn.className = 'cs-tbtn'; promptBtn.id = 'cs-prompt-toggle'; promptBtn.title = 'Edit prompt';
    promptBtn.innerHTML = '✎'; promptBtn.onclick = () => togglePromptBox();

    const regenBtn = document.createElement('button');
    regenBtn.className = 'cs-tbtn'; regenBtn.id = 'cs-regen'; regenBtn.title = 'Regenerate';
    regenBtn.innerHTML = '↻'; regenBtn.onclick = () => regenerate();

    toolbar.appendChild(picker);
    toolbar.appendChild(promptBtn);
    toolbar.appendChild(regenBtn);

    // --- Prompt editor (hidden by default) ---
    const promptBox = document.createElement('div');
    promptBox.className = 'cs-promptbox'; promptBox.id = 'cs-promptbox'; promptBox.style.display = 'none';
    const ta = document.createElement('textarea');
    ta.id = 'cs-prompt-input'; ta.placeholder = 'Summarization instructions…';
    const prow = document.createElement('div'); prow.className = 'cs-prow';
    const applyBtn = document.createElement('button'); applyBtn.className = 'cs-btn-primary'; applyBtn.textContent = 'Apply & regenerate';
    applyBtn.onclick = () => applyPrompt();
    const resetPromptBtn = document.createElement('button'); resetPromptBtn.className = 'cs-btn-ghost'; resetPromptBtn.textContent = 'Reset';
    resetPromptBtn.onclick = () => { ta.value = defaultPromptText(); };
    const phint = document.createElement('span'); phint.className = 'cs-hint'; phint.textContent = 'Applies to this page + becomes your default';
    prow.appendChild(applyBtn); prow.appendChild(resetPromptBtn); prow.appendChild(phint);
    promptBox.appendChild(ta); promptBox.appendChild(prow);

    masthead.appendChild(titlebar);
    masthead.appendChild(toolbar);
    masthead.appendChild(promptBox);

    // --- Scroll region ---
    const scroll = document.createElement('div');
    scroll.className = 'cs-scroll'; scroll.id = 'cs-scroll';

    // --- Composer ---
    const composer = document.createElement('div');
    composer.className = 'cs-composer'; composer.id = 'cs-composer';
    const input = document.createElement('textarea');
    input.id = 'cs-followup'; input.rows = 1; input.placeholder = 'Ask a follow-up…';
    input.oninput = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
    };
    const send = document.createElement('button');
    send.className = 'cs-send'; send.id = 'cs-send'; send.innerHTML = '➤'; send.onclick = () => sendFollowup();
    composer.appendChild(input);
    composer.appendChild(send);

    // Jump-to-latest pill (shown by the scroll engine when a reply streams offscreen).
    const jump = document.createElement('button');
    jump.id = 'cs-jump'; jump.className = 'cs-jump';
    jump.innerHTML = '↓ Jump to latest';
    jump.onclick = () => { scroll.scrollTop = scroll.scrollHeight; jump.style.display = 'none'; };

    // A scroll is intent: update the jump affordance as the reader moves (P2/P9).
    scroll.addEventListener('scroll', () => updateJump(scroll), { passive: true });

    panel.appendChild(masthead);
    panel.appendChild(scroll);
    panel.appendChild(composer);
    panel.appendChild(jump);
    document.body.appendChild(panel);
    return panel;
  }

  function iconBtn(glyph, title, onclick) {
    const b = document.createElement('button');
    b.className = 'cs-iconbtn'; b.title = title; b.textContent = glyph; b.onclick = onclick;
    return b;
  }

  function enableDrag(handle, panel) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = `${ox + e.clientX - sx}px`;
      panel.style.top = `${oy + e.clientY - sy}px`;
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ===========================================================================
  // Scroll engineering (per shadcn's "scroll is intent" principles): follow the live edge ONLY
  // while the reader is at it; if they scroll up (or select text), keep their place and surface a
  // jump-to-latest. New turns start near the top; reopens land at the last meaningful turn.
  // ===========================================================================
  const LIVE_EDGE_PX = 60;
  function nearLiveEdge(el) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < LIVE_EDGE_PX;
  }
  function hasSelectionIn(el) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    return el.contains(sel.anchorNode);
  }
  function scrollElNearTop(scroll, el) {
    if (!el) return;
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 10;
  }
  function lastUserTurnEl(scroll) {
    const users = scroll.querySelectorAll('.cs-user');
    return users[users.length - 1] || null;
  }
  function updateJump(scroll) {
    const jb = document.getElementById('cs-jump');
    if (!jb || !scroll) return;
    const m = S.models[S.activeModelId];
    const streaming = Boolean(m && m.inProgress) && !S.foreignUrl;
    jb.style.display = (streaming && !nearLiveEdge(scroll)) ? 'flex' : 'none';
  }
  function applyScrollBehavior(scroll, ctx) {
    if (S._freshOpen) {
      // P11: reopen at the last meaningful turn (last user message), not the absolute bottom —
      // unless it's a live stream, which follows the edge.
      S._freshOpen = false;
      if (ctx.streaming) scroll.scrollTop = scroll.scrollHeight;
      else { const lu = lastUserTurnEl(scroll); if (lu) scrollElNearTop(scroll, lu); else scroll.scrollTop = 0; }
    } else if (S._scrollNewTurnTop) {
      // P4/P5: a new follow-up turn starts near the top; its answer then streams into the space
      // below (which may be offscreen — P7 — surfaced by the jump button — P9).
      S._scrollNewTurnTop = false;
      const lu = lastUserTurnEl(scroll);
      if (lu) scrollElNearTop(scroll, lu); else scroll.scrollTop = scroll.scrollHeight;
    } else if (ctx.streaming) {
      // P1/P2/P3: follow only if the reader was at the edge and isn't selecting; else keep their
      // exact place (deltas append below, so the saved scrollTop still points at the same line).
      if (ctx.wasFollowing && !ctx.hadSelection) scroll.scrollTop = scroll.scrollHeight;
      else scroll.scrollTop = ctx.prevTop;
    } else {
      // P12: a re-layout of completed content must not move the reader.
      scroll.scrollTop = ctx.prevTop;
    }
    updateJump(scroll);
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function render() {
    const panel = panelEl();
    if (!panel) return;
    if (S.view === 'history') { renderHistory(); return; }
    renderSummaryView();
  }

  function renderSummaryView() {
    const scroll = document.getElementById('cs-scroll');
    const composer = document.getElementById('cs-composer');
    const toolbar = document.getElementById('cs-toolbar');
    const promptBox = document.getElementById('cs-promptbox');
    if (!scroll) return;

    // Capture the reader's scroll intent BEFORE we rebuild the DOM (the rebuild resets scrollTop).
    const prevTop = scroll.scrollTop;
    const wasFollowing = nearLiveEdge(scroll);
    const hadSelection = hasSelectionIn(scroll);

    // Viewing another page's saved summary is read-only: chatting/regenerating here would target
    // the wrong URL (and its deltas would fail this page's url-guard), so hide those affordances.
    const foreign = Boolean(S.foreignUrl);
    if (composer) composer.style.display = foreign ? 'none' : 'flex';
    if (toolbar) toolbar.style.display = foreign ? 'none' : 'flex';
    if (foreign && promptBox) promptBox.style.display = 'none';

    // Title + model picker labels
    const titleEl = document.getElementById('cs-title');
    if (titleEl) titleEl.textContent = S.title || 'AI Summary';
    refreshModelPicker();

    const m = S.models[S.activeModelId];
    scroll.textContent = '';

    if (foreign) {
      const bar = document.createElement('div');
      bar.style.cssText = `display:flex; align-items:center; gap:8px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid ${T.borderSubtle};`;
      const note = document.createElement('span'); note.className = 'cs-hint'; note.style.flex = '1'; note.textContent = 'Saved summary (read-only)';
      const open = document.createElement('button'); open.className = 'cs-btn-ghost'; open.textContent = 'Open page ↗';
      open.onclick = () => { try { window.open(S.foreignUrl, '_blank'); } catch (e) {} };
      bar.appendChild(note); bar.appendChild(open);
      scroll.appendChild(bar);
    }

    // Inline poster (YouTube graphic), if available.
    if (S.poster && S.poster.dataUrl) {
      const box = document.createElement('div');
      box.className = 'cs-poster';
      box.title = 'Open poster';
      const img = document.createElement('img');
      img.src = S.poster.dataUrl; img.alt = 'Generated poster';
      box.appendChild(img);
      box.onclick = () => sendToBackground({ action: 'openGraphic', graphicPath: S.poster.path });
      scroll.appendChild(box);
    } else if (S.poster && S.poster.tooLarge) {
      const box = document.createElement('div');
      box.className = 'cs-poster cs-poster-large';
      box.innerHTML = `<span>🖼️</span><span class="cs-hint">Poster ready — too large to preview inline.</span>`;
      const open = document.createElement('button'); open.className = 'cs-btn-ghost'; open.textContent = 'Open';
      open.onclick = () => sendToBackground({ action: 'openGraphic', graphicPath: S.poster.path });
      box.appendChild(open);
      scroll.appendChild(box);
    }

    if (!m) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No summary yet. Select text and hit ✨, or open a YouTube video.';
      scroll.appendChild(empty);
      updateComposerEnabled();
      return;
    }

    // Conversation turns.
    const msgs = m.messages || [];
    let renderedSummary = false;
    for (let i = 0; i < msgs.length; i++) {
      const turn = msgs[i];
      if (i === 0 && turn.role === 'user') continue; // the instruction+source turn is internal
      if (turn.role === 'assistant') {
        if (!renderedSummary) { scroll.appendChild(renderSummaryBlock(turn.content)); renderedSummary = true; }
        else scroll.appendChild(renderAssistantTurn(turn.content));
      } else if (turn.role === 'user') {
        scroll.appendChild(renderUserTurn(turn.content));
      }
    }

    // In-flight streaming / thinking.
    if (m.inProgress) {
      const text = m.streaming || '';
      if (!renderedSummary) {
        if (text) { scroll.appendChild(renderSummaryBlock(text, true)); renderedSummary = true; }
        else scroll.appendChild(renderGenerating('summary'));
      } else {
        if (text) scroll.appendChild(renderAssistantTurn(text, true));
        else scroll.appendChild(renderGenerating('reply'));
      }
    } else if (m.complete && m.duration) {
      const meta = document.createElement('div');
      meta.className = 'cs-meta';
      const um = m.usedModel || modelMeta(S.activeModelId) || {};
      meta.textContent = `${um.icon || ''} ${um.name || ''} · ${(m.duration / 1000).toFixed(1)}s`;
      scroll.appendChild(meta);
    }

    updateComposerEnabled();
    applyScrollBehavior(scroll, {
      streaming: Boolean(m.inProgress) && !foreign,
      wasFollowing, prevTop, hadSelection
    });
  }

  function renderSummaryBlock(text, streaming) {
    const el = document.createElement('div');
    el.className = 'cs-summary cs-md';
    el.innerHTML = renderMarkdown(text);
    if (streaming) el.appendChild(caret());
    return el;
  }
  function renderAssistantTurn(text, streaming) {
    const wrap = document.createElement('div');
    wrap.className = 'cs-turn';
    const label = document.createElement('div'); label.className = 'cs-turn-label'; label.textContent = 'Assistant';
    const body = document.createElement('div'); body.className = 'cs-assistant cs-md';
    body.innerHTML = renderMarkdown(text);
    if (streaming) body.appendChild(caret());
    wrap.appendChild(label); wrap.appendChild(body);
    return wrap;
  }
  function renderUserTurn(text) {
    const wrap = document.createElement('div');
    wrap.className = 'cs-turn cs-user';
    const inner = document.createElement('div'); inner.className = 'cs-user-inner';
    inner.textContent = text;
    wrap.appendChild(inner);
    return wrap;
  }
  function renderGenerating(kind) {
    const el = document.createElement('div');
    const phase = S.models[S.activeModelId]?.phase;
    if (kind === 'summary') {
      el.className = 'cs-assistant';
      const g = document.createElement('div'); g.className = 'cs-generating';
      const um = activeMeta();
      const label = phase === 'transcript' ? 'Fetching transcript…' : `Generating with ${escapeHtml(um.name || 'AI')}…`;
      g.innerHTML = `<span class="cs-dot"></span> ${label}`;
      el.appendChild(g);
      for (let i = 0; i < 3; i++) { const sk = document.createElement('div'); sk.className = 'cs-skel'; sk.style.width = (90 - i * 12) + '%'; el.appendChild(sk); }
    } else {
      el.className = 'cs-turn';
      el.innerHTML = `<div class="cs-turn-label">Assistant</div><div class="cs-generating"><span class="cs-dot"></span> Thinking…</div>`;
    }
    return el;
  }
  function caret() { const c = document.createElement('span'); c.className = 'cs-caret'; return c; }

  function updateComposerEnabled() {
    const input = document.getElementById('cs-followup');
    const send = document.getElementById('cs-send');
    const m = S.models[S.activeModelId];
    const canChat = Boolean(m && m.messages && m.messages.some(x => x.role === 'assistant') && !m.inProgress);
    if (input) { input.disabled = !canChat; input.placeholder = m && m.inProgress ? 'Generating…' : 'Ask a follow-up…'; }
    if (send) send.disabled = !canChat;
  }

  function refreshModelPicker() {
    const picker = document.getElementById('cs-modelpick');
    if (!picker) return;
    const meta = activeMeta();
    picker.querySelector('.cs-mp-ico').textContent = meta.icon || '✨';
    picker.querySelector('.cs-mp-name').textContent = meta.name || 'Model';
  }

  // ===========================================================================
  // Model picker dropdown
  // ===========================================================================
  function showModelMenu(anchor) {
    const existing = document.getElementById('cs-model-menu');
    if (existing) { existing._close(); return; }
    const menu = document.createElement('div');
    menu.id = 'cs-model-menu'; menu.className = 'cs-menu';
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 6}px`;

    const h = document.createElement('div'); h.className = 'cs-menu-h'; h.textContent = 'Summarize with'; menu.appendChild(h);

    const currentId = activeMeta().id;
    allModels().forEach(mdl => {
      const item = document.createElement('button');
      item.className = 'cs-menu-item';
      item.innerHTML = `<span>${mdl.icon || ''}</span><span>${escapeHtml(mdl.name)}</span>`;
      if (mdl.id === currentId) { const c = document.createElement('span'); c.className = 'cs-check'; c.textContent = '✓'; item.appendChild(c); }
      item.onclick = () => { close(); chooseModel(mdl.id); };
      menu.appendChild(item);
    });

    const onAway = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
    function close() { menu.remove(); document.removeEventListener('click', onAway); }
    menu._close = close;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', onAway), 0);
  }

  function chooseModel(id) {
    // Remember as the default everywhere.
    try { chrome.storage.local.set({ 'pref:defaultModel': id }); } catch (e) {}
    const meta = modelMeta(id);
    const hasSummary = S.models[S.activeModelId]?.messages?.some(x => x.role === 'assistant');
    if (hasSummary || S.models[S.activeModelId]?.inProgress) {
      // Regenerate the current page's summary with the chosen model.
      regenerate(id);
    } else {
      S.activeModelId = id;
      ensureLocalModel(id).usedModel = meta;
      refreshModelPicker();
    }
  }

  // ===========================================================================
  // Prompt editor
  // ===========================================================================
  function defaultPromptText() {
    const m = S.config?.models?.find(x => x.id === S.activeModelId);
    return (m && m.prompt) || S.config?.defaultPrompt || '';
  }
  function togglePromptBox() {
    const box = document.getElementById('cs-promptbox');
    const btn = document.getElementById('cs-prompt-toggle');
    if (!box) return;
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (btn) btn.classList.toggle('cs-on', show);
    if (show) {
      const ta = document.getElementById('cs-prompt-input');
      ta.value = S.prompt || defaultPromptText();
      ta.focus();
    }
  }
  function applyPrompt() {
    const ta = document.getElementById('cs-prompt-input');
    const prompt = (ta?.value || '').trim();
    if (!prompt) return;
    S.prompt = prompt;
    try { chrome.storage.local.set({ 'pref:defaultPrompt': prompt }); } catch (e) {}
    togglePromptBox();
    // Re-run the current summary with the new instructions (needs an existing source in the job).
    if (S.hasSaved || S.models[S.activeModelId]?.messages?.length) {
      regenerate(S.activeModelId, prompt);
    }
  }

  // ===========================================================================
  // Regenerate / follow-up (reactive — the UI updates when background echoes back).
  // ===========================================================================
  function regenerate(modelId, prompt) {
    modelId = modelId || S.activeModelId;
    const m = ensureLocalModel(modelId);
    m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false;
    S.activeModelId = modelId;
    render();
    sendToBackground({ action: 'regenerate', url: S.fullUrl, modelId, prompt: (prompt != null ? prompt : S.prompt) || undefined });
  }

  function sendFollowup() {
    const input = document.getElementById('cs-followup');
    const q = (input?.value || '').trim();
    if (!q) return;
    const m = S.models[S.activeModelId];
    if (!m || m.inProgress) return;
    input.value = ''; input.style.height = 'auto';
    m.messages.push({ role: 'user', content: q });
    m.streaming = ''; m.inProgress = true; m.complete = false;
    S._scrollNewTurnTop = true;   // P4/P5: start the new turn near the top
    render();
    sendToBackground({ action: 'followup', url: S.fullUrl, modelId: S.activeModelId, question: q });
  }

  function copySource() {
    // The background owns the source text — fetch it and copy. Fall back to the summary if the
    // job has no source (shouldn't happen for a real summary).
    const flash = () => { const b = document.getElementById('cs-copy'); if (b) { b.textContent = '✓'; setTimeout(() => b.textContent = '📄', 1400); } };
    const url = S.foreignUrl || S.fullUrl;
    sendToBackground({ action: 'getSource', url }, (resp) => {
      let text = resp && resp.text;
      if (!text) {
        const m = S.models[S.activeModelId];
        const summary = (m?.messages || []).find(x => x.role === 'assistant');
        text = summary?.content || m?.streaming || '';
      }
      if (text) navigator.clipboard.writeText(text).then(flash);
    });
  }

  // ===========================================================================
  // History view
  // ===========================================================================
  function toggleHistory() {
    if (S.view === 'history') { S.view = 'summary'; render(); return; }
    S.view = 'history'; renderHistory();
  }
  function renderHistory() {
    const scroll = document.getElementById('cs-scroll');
    const composer = document.getElementById('cs-composer');
    const toolbar = document.getElementById('cs-toolbar');
    const promptBox = document.getElementById('cs-promptbox');
    const titleEl = document.getElementById('cs-title');
    if (!scroll) return;
    if (composer) composer.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    if (promptBox) promptBox.style.display = 'none';
    if (titleEl) titleEl.textContent = 'Past summaries';

    scroll.textContent = '';
    const loading = document.createElement('div'); loading.className = 'cs-empty'; loading.textContent = 'Loading…';
    scroll.appendChild(loading);

    sendToBackground({ action: 'listSummaries' }, (resp) => {
      if (S.view !== 'history') return;
      scroll.textContent = '';
      const list = (resp && resp.summaries) || [];
      if (!list.length) {
        const empty = document.createElement('div'); empty.className = 'cs-empty';
        empty.textContent = 'No summaries yet. They’ll show up here after you summarize a page or video.';
        scroll.appendChild(empty);
        return;
      }
      list.forEach(item => scroll.appendChild(renderHistItem(item)));
    });
  }
  function renderHistItem(item) {
    const row = document.createElement('div'); row.className = 'cs-hist-item';
    const ico = document.createElement('div'); ico.className = 'cs-hist-ico';
    ico.textContent = item.isTranscript ? '🎬' : (item.modelIcon || '📄');
    const body = document.createElement('div'); body.className = 'cs-hist-body';
    const title = document.createElement('div'); title.className = 'cs-hist-title';
    title.textContent = item.title || item.url || 'Untitled';
    const snip = document.createElement('div'); snip.className = 'cs-hist-snip'; snip.textContent = item.snippet || '';
    const meta = document.createElement('div'); meta.className = 'cs-hist-meta';
    const parts = [];
    if (item.modelName) parts.push(`${item.modelIcon || ''} ${item.modelName}`.trim());
    parts.push(formatAge(item.timestamp));
    if (item.inProgress) parts.push('⏳ generating');
    meta.textContent = parts.join('  ·  ');
    body.appendChild(title); body.appendChild(snip); body.appendChild(meta);

    const del = document.createElement('button'); del.className = 'cs-hist-del'; del.title = 'Delete'; del.textContent = '🗑';
    del.onclick = (e) => { e.stopPropagation(); sendToBackground({ action: 'deleteSummary', url: item.url }, () => { row.remove(); }); };

    row.onclick = () => openHistItem(item);
    row.appendChild(ico); row.appendChild(body); row.appendChild(del);
    return row;
  }
  function openHistItem(item) {
    if (normUrl(item.fullUrl || item.url) === S.url) {
      // It's this page — load its own (live) state, editable.
      S.foreignUrl = null;
      S.view = 'summary';
      loadPageState(true);
      return;
    }
    // Another page's summary — load it read-only into the panel.
    sendToBackground({ action: 'getPageState', url: item.fullUrl || item.url }, (state) => {
      if (!state || !state.exists) return;
      hydrateFrom(state);
      S.foreignUrl = item.fullUrl || item.url;
      S.poster = null; S.posterTried = false;   // load the foreign video's poster, not this page's
      S.view = 'summary';
      render();
      maybeLoadPoster();
    });
  }

  // ===========================================================================
  // Reopen pill (page already summarized)
  // ===========================================================================
  function maybeShowReopenPill() {
    if (!S.hasSaved || panelEl() || document.getElementById('cs-reopen-pill')) return;
    const pill = document.createElement('div');
    pill.id = 'cs-reopen-pill';
    const meta = activeMeta();
    const label = document.createElement('span');
    label.innerHTML = `<span style="margin-right:6px">${meta.icon || '📄'}</span>Summary ready`;
    const x = document.createElement('span'); x.className = 'cs-pill-x'; x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); dismissReopenPill(true); };
    pill.appendChild(label); pill.appendChild(x);
    pill.onclick = () => { S.view = 'summary'; openPanel(); };
    document.body.appendChild(pill);
  }
  function dismissReopenPill(permanent) {
    const p = document.getElementById('cs-reopen-pill');
    if (p) p.remove();
    if (permanent) S._pillDismissed = true;
  }

  // ===========================================================================
  // Poster (YouTube generated graphic → inline)
  // ===========================================================================
  function maybeLoadPoster() {
    if (S.posterTried || !S.videoId) return;
    S.posterTried = true;
    sendToBackground({ action: 'getPoster', videoId: S.videoId }, (resp) => {
      if (!resp) return;
      if (resp.type === 'graphic' && resp.dataUrl) { S.poster = { dataUrl: resp.dataUrl, path: resp.path }; }
      else if (resp.error === 'too_large') { S.poster = { tooLarge: true, path: resp.path }; }
      else return;
      if (panelEl() && S.view === 'summary') render();
    });
  }

  // ===========================================================================
  // Rehydration + state sync
  // ===========================================================================
  function hydrateFrom(state, opts) {
    opts = opts || {};
    S.title = state.title || S.title;
    S.prompt = state.prompt || S.prompt;
    S.isTranscript = Boolean(state.isTranscript);
    S.activeModelId = state.activeModelId || S.activeModelId || S.config?.models?.[0]?.id;
    S.videoId = state.videoId || S.videoId;
    S.models = {};
    Object.keys(state.models || {}).forEach(id => {
      const sm = state.models[id];
      S.models[id] = {
        messages: sm.messages || [],
        streaming: sm.streaming || '',
        inProgress: Boolean(sm.inProgress),
        complete: Boolean(sm.complete),
        usedModel: sm.usedModel || modelMeta(id),
        duration: sm.duration || null
      };
    });
    S.hasSaved = Object.values(S.models).some(m => (m.messages || []).some(x => x.role === 'assistant'));
  }

  function loadPageState(autoOpen) {
    sendToBackground({ action: 'getPageState', url: S.fullUrl }, (state) => {
      if (!state || !state.exists) return;
      S.foreignUrl = null;
      hydrateFrom(state);
      const anyInProgress = Object.values(S.models).some(m => m.inProgress);
      if (autoOpen || anyInProgress) {
        S.view = 'summary';
        openPanel();
        maybeLoadPoster();
      } else if (S.hasSaved) {
        if (!S._pillDismissed) maybeShowReopenPill();
        maybeLoadPoster();
      }
    });
  }

  function requestResync() {
    if (S.resyncing) return;
    S.resyncing = true;
    sendToBackground({ action: 'getPageState', url: S.fullUrl }, (state) => {
      S.resyncing = false;
      if (!state || !state.exists) return;
      // Merge streaming/messages for the active model without clobbering the view identity.
      Object.keys(state.models || {}).forEach(id => {
        const sm = state.models[id];
        const lm = ensureLocalModel(id);
        lm.messages = sm.messages || lm.messages;
        lm.streaming = sm.streaming || '';
        lm.inProgress = Boolean(sm.inProgress);
        lm.complete = Boolean(sm.complete);
        lm.usedModel = sm.usedModel || lm.usedModel;
        lm.duration = sm.duration || lm.duration;
      });
      if (panelEl() && S.view === 'summary') render();
    });
  }

  // ===========================================================================
  // Message listener — reacts to the background's job broadcasts for THIS url.
  // ===========================================================================
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'configError') { console.error('AI Config Error:', request.error); return; }

    // Keep S.url aligned with the live tab BEFORE any url guard. Critical on YouTube SPA nav.
    syncPageIdentity();

    if (request.action === 'togglePanel') {
      if (panelEl()) { closePanel(); }
      else {
        // Prefer this page's own summary; if there's none, open straight to history.
        sendToBackground({ action: 'getPageState', url: S.fullUrl }, (state) => {
          if (state && state.exists) { S.foreignUrl = null; hydrateFrom(state); S.view = 'summary'; openPanel(); maybeLoadPoster(); }
          else { S.view = 'history'; openPanel(); }
        });
      }
      return;
    }

    // A url guard: only messages for the page we're rendering apply (a stale job for a URL we
    // navigated away from can still target this tab id). Compare against the LIVE page key,
    // not a snapshot taken at first inject.
    const liveKey = normUrl(location.href);
    const forThisUrl = request.url && (request.url === liveKey || request.url === S.url);

    if (request.action === 'initSummary' && forThisUrl) {
      if (request.config && !S.config) S.config = request.config;
      S.foreignUrl = null;   // a fresh summary on this page takes over any read-only view
      S.title = request.title || S.title;
      S.prompt = request.prompt || S.prompt;
      S.activeModelId = request.modelId;
      const m = ensureLocalModel(request.modelId);
      m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false;
      m.usedModel = request.usedModel || modelMeta(request.modelId);
      m.phase = request.phase || null;   // 'transcript' → panel shows "Fetching transcript…" instantly
      ensurePanelOpen();
      return;
    }

    // While a foreign (read-only) summary is on screen, ignore live deltas for THIS page — the
    // background still accumulates + persists them; the own view rehydrates when we return to it.
    if (S.foreignUrl && ['regenStart', 'followupStart', 'updateSummary', 'summaryComplete', 'summaryError'].includes(request.action)) {
      return;
    }

    if (request.action === 'regenStart' && forThisUrl) {
      S.activeModelId = request.modelId;
      if (request.prompt != null) S.prompt = request.prompt;
      const m = ensureLocalModel(request.modelId);
      m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false;
      m.usedModel = request.usedModel || modelMeta(request.modelId);
      ensurePanelOpen();
      return;
    }

    if (request.action === 'followupStart' && forThisUrl) {
      const m = ensureLocalModel(request.modelId);
      const last = m.messages[m.messages.length - 1];
      if (!last || last.role !== 'user' || last.content !== request.question) {
        m.messages.push({ role: 'user', content: request.question });
      }
      m.inProgress = true; m.complete = false; m.streaming = '';
      S.activeModelId = request.modelId;
      S._scrollNewTurnTop = true;   // P4/P5: new turn near the top
      ensurePanelOpen();
      return;
    }

    if (request.action === 'updateSummary' && forThisUrl) {
      const m = ensureLocalModel(request.modelId);
      if (typeof request.streamingLength === 'number' && m.streaming.length + request.delta.length !== request.streamingLength) {
        // Missed a delta (likely reconnected mid-stream) — pull the authoritative snapshot.
        ensurePanelOpen();
        requestResync();
        return;
      }
      m.streaming += request.delta;
      m.inProgress = true;
      m.phase = null;   // real tokens flowing — leave the "fetching transcript" state
      S.activeModelId = request.modelId;
      S.hasSaved = true;
      // Open even if initSummary was dropped (SPA url mismatch, closed mid-stream, etc.).
      ensurePanelOpen();
      return;
    }

    if (request.action === 'summaryComplete' && forThisUrl) {
      const m = ensureLocalModel(request.modelId);
      m.inProgress = false; m.complete = true; m.duration = request.duration;
      if (request.message) m.messages.push(request.message);
      m.streaming = '';
      S.hasSaved = true;
      ensurePanelOpen();
      playCompletionSound();
      maybeLoadPoster();
      return;
    }

    if (request.action === 'summaryError' && forThisUrl) {
      const m = ensureLocalModel(request.modelId);
      m.inProgress = false; m.streaming = '';
      if (m.messages.length && m.messages[m.messages.length - 1].role === 'user') m.messages.pop();
      ensurePanelOpen();
      const scroll = document.getElementById('cs-scroll');
      if (scroll) {
        const err = document.createElement('div'); err.className = 'cs-error';
        err.textContent = `Error: ${request.error}`;
        scroll.appendChild(err);
      }
      updateComposerEnabled();
      return;
    }

    // FAB spinner clear on CC open done.
    if (request.action === 'openInCCComplete' || request.action === 'openInCCError') {
      document.querySelectorAll('.fab').forEach(f => { if (f.setLoading) f.setLoading(false); });
      if (request.action === 'openInCCError') console.error('Open in CC error:', request.error);
      return;
    }
  });

  // ===========================================================================
  // Init
  // ===========================================================================
  function init() {
    injectStyles();
    injectFABs();

    // Escape closes the panel (a keyboard interaction is intent — but don't steal it from a
    // text field the reader is typing in; blur first so their draft isn't lost on the first tap).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !panelEl()) return;
      const ae = document.activeElement;
      if (ae && (ae.id === 'cs-followup' || ae.id === 'cs-prompt-input') && ae.value) { ae.blur(); return; }
      closePanel();
    });

    // YouTube SPA: video→video without reload. Also popstate / hash for other SPAs.
    const onSpaNav = () => { try { syncPageIdentity(); } catch (e) { /* ignore */ } };
    document.addEventListener('yt-navigate-finish', onSpaNav);
    window.addEventListener('yt-navigate-finish', onSpaNav);
    window.addEventListener('popstate', onSpaNav);
    // Fallback: YouTube sometimes updates the URL without firing yt-navigate-finish promptly.
    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; onSpaNav(); }
    }, 1000);

    sendToBackground({ action: 'getConfig' }, (response) => {
      if (response?.config) {
        S.config = response.config;
        S.activeModelId = S.config.models?.[0]?.id || null;
        // Apply remembered default model, if any.
        try {
          chrome.storage.local.get(['pref:defaultModel', 'pref:defaultPrompt'], (prefs) => {
            const dm = prefs && prefs['pref:defaultModel'];
            if (dm && allModels().some(m => m.id === dm)) S.activeModelId = dm;
            if (prefs && prefs['pref:defaultPrompt']) S.prompt = prefs['pref:defaultPrompt'];
            loadPageState(false);
          });
        } catch (e) {
          loadPageState(false);
        }
      }
    });
  }

  init();
}
