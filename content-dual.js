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
  const I = self.CS_ICONS;   // shared line icons (icons.js)

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
    mode: 'summary',     // 'summary' | 'chat' (transcript as context, no summary up front)
    sourceWords: 0,      // chat card: transcript size
    sourcePreview: '',   // chat card: opening lines of the transcript
    foreignUrl: null,    // when viewing ANOTHER page's saved summary (read-only)
    poster: null,        // { url } (R2 poster served by the Worker) | null
    posterTried: false,
    posterState: null,   // null | 'pending' | 'ready' | 'error' — drives the infographic loading view
    noPoster: false,     // true = text-only summary (⚡); false = infographic-first view (✨)
    showText: false,     // infographic mode: reader asked to see the text summary instead
    loadStartedAt: 0,    // for the elapsed counter in the infographic loading view
    resyncing: false
  };

  // ---------------------------------------------------------------------------
  // Extension-context liveness (unchanged behaviour: a reloaded extension orphans this script;
  // detect it, stop spinners, tell the user to refresh).
  // ---------------------------------------------------------------------------
  function extensionAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function showStaleBanner(text) {
    if (document.getElementById('claude-stale-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'claude-stale-banner';
    banner.textContent = text || '⚠️ Extension was reloaded — refresh this page to use the summarizer.';
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
    const hadPanel = Boolean(byId('claude-summary-container'));
    S.url = n;
    S.fullUrl = live;
    S.title = document.title || S.title;
    S.videoId = currentVideoId();
    S.models = {};
    S.hasSaved = false;
    S.foreignUrl = null;
    S.poster = null;
    S.posterTried = false;
    S.posterState = null;
    S.showText = false;
    S.loadStartedAt = 0;
    S.activeModelId = S.activeModelId || S.config?.models?.[0]?.id || null;
    S._pillDismissed = false;
    if (hadPanel) removePanel();
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
  // Model icons: a config `icon` of "claude"/"openai" renders the brand logo (simple-icons,
  // CC0); anything else (emoji, or an old stored icon) renders as escaped text. Inline styles,
  // not a cs- class, so host-page CSS can't resize the SVG.
  const LOGOS = {
    claude: { fill: '#D97757', d: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z' },
    openai: { fill: 'currentColor', d: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z' },
  };
  function iconHTML(icon) {
    const l = LOGOS[icon];
    if (!l) return escapeHtml(icon || '');
    return `<svg viewBox="0 0 24 24" fill="${l.fill}" aria-hidden="true" style="width:1em;height:1em;display:inline-block;vertical-align:-0.125em;flex:none"><path d="${l.d}"/></svg>`;
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
      .cs-iconbtn svg { width: 16px; height: 16px; }
      .cs-tbtn svg { width: 14px; height: 14px; }
      .cs-modelpick .cs-mp-caret svg { width: 13px; height: 13px; }
      .cs-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; }
      .cs-modelpick { display: flex; align-items: center; gap: 6px; background: ${T.surface2}; border: 1px solid ${T.borderStrong};
        color: ${T.textPrimary}; border-radius: 9px; padding: 6px 10px; cursor: pointer; font-size: 13px; font-weight: 500;
        flex: 1; min-width: 0; }
      .cs-modelpick:hover { border-color: ${T.accent}; }
      .cs-modelpick .cs-mp-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; text-align: left; }
      .cs-modelpick .cs-mp-caret { color: ${T.textMuted}; font-size: 10px; display: flex; }
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
      .cs-pv { display: flex; flex-direction: column; gap: 10px; }
      .cs-pv .cs-poster { margin: 0; }
      .cs-pv-bar { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 10px; }
      .cs-pv .cs-pv-bar { margin-bottom: 0; }
      .cs-pv-btn { padding: 6px 12px; }
      .cs-pv-load { aspect-ratio: 16 / 10; border-radius: 10px; border: 1px solid ${T.borderSubtle};
        background: ${T.surface2}; display: flex; flex-direction: column; justify-content: space-between; padding: 16px 16px 12px; }
      .cs-pv-failed { aspect-ratio: auto; min-height: 160px; justify-content: center; align-items: center; gap: 8px; text-align: center; }
      .cs-ghost { display: flex; flex-direction: column; gap: 9px; }
      .cs-gh { background: ${T.surface3}; border-radius: 5px; animation: cs-breathe 2.6s ease-in-out infinite; }
      .cs-gh-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 4px 0; }
      .cs-gh-grid .cs-gh { aspect-ratio: 3 / 4; border-radius: 6px; }
      @keyframes cs-breathe { 0%, 100% { opacity: .35; } 50% { opacity: .8; } }
      @media (prefers-reduced-motion: reduce) { .cs-gh { animation: none; opacity: .5; } }
      .cs-pv-foot { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
      .cs-pv-label { color: ${T.textSecondary}; font-size: 13.5px; font-weight: 500; }
      #cs-lightbox { position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,.92);
        display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: zoom-out; }
      #cs-lightbox img { max-width: 100vw; max-height: 100vh; object-fit: contain; cursor: zoom-in; }
      #cs-lightbox.cs-lb-zoom { display: block; overflow: auto; }
      #cs-lightbox.cs-lb-zoom img { max-width: none; max-height: none; width: 100%; height: auto; cursor: zoom-out; }
      .cs-lb-tools { position: fixed; top: 14px; right: 14px; display: flex; gap: 8px; }
      .cs-lb-tools button { width: 38px; height: 38px; border-radius: 50%; border: 1px solid rgba(255,255,255,.25);
        background: rgba(20,20,20,.75); color: #fff; font-size: 16px; cursor: pointer; }
      .cs-lb-tools button:hover { background: rgba(60,60,60,.9); }

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
      .cs-meta { color: ${T.textMuted}; font-size: 11.5px; margin-top: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .cs-dashlink { background: none; border: none; color: ${T.accent}; cursor: pointer; font: inherit; font-size: 11.5px; padding: 0; opacity: .85; transition: opacity .12s; }
      .cs-dashlink:hover { opacity: 1; text-decoration: underline; }

      .cs-composer { flex-shrink: 0; border-top: 1px solid ${T.borderSubtle}; background: ${T.surface0}; padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
      .cs-composer textarea { flex: 1; background: ${T.surface2}; border: 1px solid ${T.borderStrong}; color: ${T.textPrimary};
        border-radius: 11px; padding: 9px 12px; font: inherit; font-size: 14.5px; line-height: 1.4; resize: none; min-height: 40px; max-height: 120px; }
      .cs-composer textarea:focus { outline: none; border-color: ${T.accent}; }
      .cs-send { flex-shrink: 0; width: 40px; height: 40px; border-radius: 11px; border: none; background: ${T.accent}; color: ${T.accentInk};
        font-size: 17px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
      .cs-send:disabled { opacity: .4; cursor: default; }
      .cs-send svg { width: 18px; height: 18px; }

      /* Chat mode: transcript card + starter chips */
      .cs-src { background: ${T.surface2}; border: 1px solid ${T.borderSubtle}; border-radius: 11px; padding: 11px 13px; margin-bottom: 12px; }
      .cs-src-h { display: flex; align-items: center; gap: 7px; color: ${T.accent}; font-size: 13px; font-weight: 600; }
      .cs-src-h svg { width: 15px; height: 15px; }
      .cs-src-meta { color: ${T.textMuted}; font-size: 12px; margin-top: 3px; }
      .cs-src-snip { color: ${T.textSecondary}; font-size: 12.5px; line-height: 1.45; margin-top: 8px; padding-left: 9px;
        border-left: 2px solid ${T.surface3}; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .cs-src-snip.cs-open { display: block; -webkit-line-clamp: unset; }
      .cs-src-more { background: none; border: none; color: ${T.accent}; font: inherit; font-size: 12px; padding: 0; margin-top: 5px; cursor: pointer; }
      .cs-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 4px; }
      .cs-chip { display: flex; align-items: center; gap: 6px; background: none; border: 1px solid ${T.borderStrong}; color: ${T.textPrimary};
        border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 12.5px; cursor: pointer; transition: border-color .15s, background .15s; }
      .cs-chip:hover { border-color: ${T.accent}; background: ${T.surface2}; }
      .cs-chip.cs-accent { color: ${T.accent}; border-color: rgba(91,228,200,.45); }
      .cs-chip svg { width: 13px; height: 13px; }

      /* Jump-to-latest (appears when a response streams offscreen while the reader is scrolled up) */
      .cs-jump svg { width: 14px; height: 14px; }
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
      #cs-reopen-pill .cs-pill-x { color: ${T.textMuted}; font-size: 15px; margin-left: 2px; display: flex; }
      #cs-reopen-pill svg { width: 14px; height: 14px; }

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

    function makeFab(icon, bg, title) {
      const btn = document.createElement('button');
      btn.className = 'fab';
      btn.innerHTML = icon; btn.title = title; btn._emoji = icon;
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

    // TWO FABs: ✨ full (summary + explain-viz infographic) and ⚡ quick (summary only, the
    // Worker skips the infographic). The ⚡ took the slot the old 🖥️ "Open in Claude Code" FAB
    // held — that path died when the native hosts were removed (background no longer handles
    // openInCC), so this reuses its footprint for something that works.
    const summarizeFab = makeFab(I.sparkles, T.surface2, 'Infographic summary');
    const quickFab = makeFab(I.zap, T.surface2, 'Text summary (no infographic)');

    summarizeFab.onclick = () => {
      const text = window.getSelection().toString().trim();
      if (!text) return;
      summarizeFab.setLoading(true);
      startNewSummary(text, false);
    };
    quickFab.onclick = () => {
      const text = window.getSelection().toString().trim();
      if (!text) return;
      quickFab.setLoading(true);
      startNewSummary(text, true);
    };

    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection().toString().trim();
      bar.style.display = sel ? 'flex' : 'none';
    });

    bar.appendChild(summarizeFab);
    bar.appendChild(quickFab);
    document.body.appendChild(bar);
  }

  function startNewSummary(text, noPoster) {
    // Optimistically open the panel with a generating state for the preferred model.
    const modelId = S.activeModelId || S.config?.models?.[0]?.id;
    S.isTranscript = false;
    S.mode = 'summary';
    S.activeModelId = modelId;
    const m = ensureLocalModel(modelId);
    m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false; m.error = null;
    resetPosterView(noPoster);
    S.view = 'summary';
    openPanel();
    sendToBackground({ action: 'summarizeDual', text, url: S.fullUrl, title: S.title, prompt: S.prompt || undefined, noPoster: Boolean(noPoster) });
  }

  // ===========================================================================
  // Panel construction
  // ===========================================================================
  // The panel can live in this page or in a Document Picture-in-Picture window (always on top,
  // stays visible across tabs). Every panel lookup goes through pdoc()/byId() so it works in both.
  let pipWin = null;
  function pdoc() { return pipWin ? pipWin.document : document; }
  function byId(id) { return pdoc().getElementById(id); }
  function panelEl() { return byId('claude-summary-container'); }
  function removePanel() {
    const p = panelEl();
    if (p) p.remove();
    if (pipWin) { const w = pipWin; pipWin = null; w.close(); }
  }

  async function togglePip() {
    if (pipWin) { dockPanel(); return; }
    const panel = panelEl();
    if (!panel || !window.documentPictureInPicture) return;
    const r = panel.getBoundingClientRect();
    let w;
    try {
      w = await documentPictureInPicture.requestWindow({ width: Math.round(r.width), height: Math.round(r.height) });
    } catch (e) { console.warn('Pop-out failed:', e); return; }
    const styles = document.getElementById('cs-styles');
    if (styles) w.document.head.appendChild(styles.cloneNode(true));
    const fit = w.document.createElement('style');
    fit.textContent = `
      html, body { margin: 0; height: 100%; background: ${T.surface0}; }
      #claude-summary-container { position: static; width: 100%; height: 100vh; border: none; border-radius: 0; box-shadow: none; }
      .cs-titlebar { cursor: default; }`;
    w.document.head.appendChild(fit);
    w.document.title = S.title || 'AI Summary';
    w.document.body.appendChild(panel);
    w.document.addEventListener('keydown', onEscape);
    // Closing the PiP window (its own ✕, or the opener navigating) docks the panel back.
    w.addEventListener('pagehide', () => { if (pipWin === w) dockPanel(); });
    pipWin = w;
    refreshPipButton();
  }
  function dockPanel() {
    const w = pipWin;
    if (!w) return;
    const panel = panelEl();
    pipWin = null;
    if (panel) {
      document.body.appendChild(panel);
      panel.style.left = ''; panel.style.top = ''; panel.style.right = '';
    }
    try { w.close(); } catch (e) {}
    refreshPipButton();
  }
  function refreshPipButton() {
    const b = byId('cs-pip');
    if (!b) return;
    b.textContent = pipWin ? '⤓' : '⧉';
    b.title = pipWin ? 'Dock back into the page' : 'Pop out (stays on top across tabs)';
  }

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
    removePanel();
    if (S.foreignUrl) {
      // We were viewing another page's summary — restore THIS page's own state so the reopen
      // pill (and any later reopen) reflects the current page, not the one we were browsing.
      S.foreignUrl = null; S.poster = null; S.posterTried = false; S.posterState = null; S.showText = false;
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

    const histBtn = iconBtn(I.history, 'History', () => toggleHistory());
    const copyBtn = iconBtn(I.copy, 'Copy source text', copySource);
    copyBtn.id = 'cs-copy';
    const closeBtn = iconBtn(I.x, 'Close', closePanel);
    const pipBtn = iconBtn(I.pip, 'Pop out (stays on top across tabs)', () => togglePip());
    pipBtn.id = 'cs-pip';
    if (!window.documentPictureInPicture) pipBtn.style.display = 'none';

    titlebar.appendChild(titleEl);
    titlebar.appendChild(histBtn);
    titlebar.appendChild(copyBtn);
    titlebar.appendChild(pipBtn);
    titlebar.appendChild(closeBtn);

    // --- Toolbar: model picker + prompt toggle + regenerate ---
    const toolbar = document.createElement('div');
    toolbar.className = 'cs-toolbar';
    toolbar.id = 'cs-toolbar';

    const picker = document.createElement('button');
    picker.className = 'cs-modelpick';
    picker.id = 'cs-modelpick';
    picker.onclick = (e) => { e.stopPropagation(); showModelMenu(picker); };
    picker.innerHTML = `<span class="cs-mp-ico"></span><span class="cs-mp-name"></span><span class="cs-mp-caret">${I.chevronDown}</span>`;

    const promptBtn = document.createElement('button');
    promptBtn.className = 'cs-tbtn'; promptBtn.id = 'cs-prompt-toggle'; promptBtn.title = 'Edit prompt';
    promptBtn.innerHTML = I.pencil; promptBtn.onclick = () => togglePromptBox();

    const regenBtn = document.createElement('button');
    regenBtn.className = 'cs-tbtn'; regenBtn.id = 'cs-regen'; regenBtn.title = 'Regenerate';
    regenBtn.innerHTML = I.refresh; regenBtn.onclick = () => regenerate();

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
    send.className = 'cs-send'; send.id = 'cs-send'; send.innerHTML = I.send; send.onclick = () => sendFollowup();
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
    pdoc().body.appendChild(panel);
    return panel;
  }

  function iconBtn(icon, title, onclick) {
    const b = document.createElement('button');
    b.className = 'cs-iconbtn'; b.title = title; b.innerHTML = icon; b.onclick = onclick;
    return b;
  }

  function enableDrag(handle, panel) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON' || pipWin) return;
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
    const sel = (pipWin || window).getSelection();
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
    const jb = byId('cs-jump');
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
    const scroll = byId('cs-scroll');
    const composer = byId('cs-composer');
    const toolbar = byId('cs-toolbar');
    const promptBox = byId('cs-promptbox');
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
    // Chat mode has no summary instruction to edit or regenerate — "Summarize instead" lives in
    // the scroll region as a chip.
    const chat = S.mode === 'chat';
    ['cs-prompt-toggle', 'cs-regen'].forEach(id => { const b = byId(id); if (b) b.style.display = chat ? 'none' : 'flex'; });
    if (chat && promptBox) promptBox.style.display = 'none';

    // Title + model picker labels
    const titleEl = byId('cs-title');
    if (titleEl) titleEl.textContent = S.title || 'AI Summary';
    refreshModelPicker();

    const m = S.models[S.activeModelId];
    scroll.textContent = '';
    stopElapsedTicker();

    // Infographic mode (✨): the panel shows the poster, never the text, unless the reader asks.
    if (m && !S.noPoster && !S.showText && S.mode !== 'chat') {
      if (composer) composer.style.display = 'none';
      renderPosterView(scroll, m);
      return;
    }

    if (foreign) {
      const bar = document.createElement('div');
      bar.style.cssText = `display:flex; align-items:center; gap:8px; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid ${T.borderSubtle};`;
      const note = document.createElement('span'); note.className = 'cs-hint'; note.style.flex = '1'; note.textContent = 'Saved summary (read-only)';
      const open = document.createElement('button'); open.className = 'cs-btn-ghost'; open.textContent = 'Open page ↗';
      open.onclick = () => { try { window.open(S.foreignUrl, '_blank'); } catch (e) {} };
      bar.appendChild(note); bar.appendChild(open);
      scroll.appendChild(bar);
    }

    // Infographic summary opened as text: offer the way back to the poster.
    if (!S.noPoster && S.showText) {
      const back = document.createElement('div'); back.className = 'cs-pv-bar';
      back.appendChild(pvButton('🖼️ Show infographic', () => { S.showText = false; render(); }));
      scroll.appendChild(back);
    }

    if (!m) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = 'No summary yet. Select text and hit ✨, or open a YouTube video.';
      scroll.appendChild(empty);
      updateComposerEnabled();
      return;
    }

    if (chat) {
      if (m.phase === 'transcript') { scroll.appendChild(renderGenerating('summary')); updateComposerEnabled(); return; }
      scroll.appendChild(renderSourceCard());
      if (!(m.messages || []).some(x => x.role === 'assistant') && !m.inProgress && !foreign) scroll.appendChild(renderStarterChips());
    }

    // Conversation turns. A chat has no summary, so every answer renders as a normal turn.
    const msgs = m.messages || [];
    let renderedSummary = chat;
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
      const label = document.createElement('span');
      label.innerHTML = `${iconHTML(um.icon)} ${escapeHtml(um.name || '')} · ${(m.duration / 1000).toFixed(1)}s`;
      meta.appendChild(label);
      // Deep link to this exact summary on the hosted dashboard (the "Cloudflare page"). The
      // background builds the URL because it holds the Worker base + token; we just open it.
      const dash = document.createElement('button');
      dash.className = 'cs-dashlink';
      dash.textContent = 'View on dashboard ↗';
      dash.title = 'Open this summary on the dashboard';
      const linkFor = S.foreignUrl || S.fullUrl;
      dash.onclick = () => {
        sendToBackground({ action: 'getDashboardLink', url: linkFor }, (resp) => {
          if (resp?.ok && resp.url) { try { window.open(resp.url, '_blank'); } catch (e) {} }
        });
      };
      meta.appendChild(dash);
      scroll.appendChild(meta);
    }

    updateComposerEnabled();
    applyScrollBehavior(scroll, {
      streaming: Boolean(m.inProgress) && !foreign,
      wasFollowing, prevTop, hadSelection
    });
  }

  // Chat mode: what the model has been given, before anything is sent.
  function renderSourceCard() {
    const card = document.createElement('div'); card.className = 'cs-src';
    const h = document.createElement('div'); h.className = 'cs-src-h';
    h.innerHTML = I.transcript;
    h.appendChild(document.createTextNode('Transcript loaded'));
    const meta = document.createElement('div'); meta.className = 'cs-src-meta';
    const words = S.sourceWords ? `${S.sourceWords.toLocaleString()} words` : 'Transcript';
    const hasTurns = (S.models[S.activeModelId]?.messages || []).some(x => x.role === 'assistant');
    meta.textContent = hasTurns ? words : `${words} · nothing sent yet — ask anything`;
    card.appendChild(h); card.appendChild(meta);
    if (S.sourcePreview) {
      const snip = document.createElement('div'); snip.className = 'cs-src-snip';
      snip.textContent = S.sourcePreview + (S.sourceWords > 50 ? '…' : '');
      const more = document.createElement('button'); more.className = 'cs-src-more'; more.textContent = 'Show all';
      more.onclick = () => {
        sendToBackground({ action: 'getSource', url: S.foreignUrl || S.fullUrl }, (resp) => {
          if (!resp?.text) return;
          snip.textContent = resp.text; snip.classList.add('cs-open'); more.remove();
        });
      };
      card.appendChild(snip); card.appendChild(more);
    }
    return card;
  }

  const STARTERS = ['What are the key takeaways?', 'What’s the most surprising claim?', 'Explain it like I’m new to this', 'Give me a 5-bullet outline'];
  function renderStarterChips() {
    const row = document.createElement('div'); row.className = 'cs-chips';
    STARTERS.forEach(q => {
      const c = document.createElement('button'); c.className = 'cs-chip'; c.textContent = q;
      c.onclick = () => { const input = byId('cs-followup'); if (input) { input.value = q; sendFollowup(); } };
      row.appendChild(c);
    });
    const sum = document.createElement('button'); sum.className = 'cs-chip cs-accent';
    sum.innerHTML = I.sparkles; sum.appendChild(document.createTextNode('Summarize instead'));
    sum.onclick = () => { S.mode = 'summary'; regenerate(S.activeModelId); };
    row.appendChild(sum);
    return row;
  }

  // ===========================================================================
  // Infographic view (✨ mode): loading state → poster → full-screen lightbox
  // ===========================================================================
  function resetPosterView(noPoster) {
    S.noPoster = Boolean(noPoster);
    S.poster = null; S.posterTried = false; S.posterState = null; S.showText = false;
    S.loadStartedAt = Date.now();
    clearTimeout(posterPollTimer);
  }

  function pvButton(label, onclick, title) {
    const b = document.createElement('button');
    b.className = 'cs-btn-ghost cs-pv-btn'; b.textContent = label; b.onclick = onclick;
    if (title) b.title = title;
    return b;
  }

  function posterStage(m) {
    if (m.inProgress && m.phase === 'transcript') return { step: 1, label: 'Fetching transcript' };
    if (m.inProgress) return { step: 2, label: 'Reading the video' };
    return { step: 3, label: 'Drawing the infographic' };
  }

  function renderPosterView(scroll, m) {
    const wrap = document.createElement('div'); wrap.className = 'cs-pv';

    if (S.poster && S.poster.url) {
      const box = document.createElement('div');
      box.className = 'cs-poster'; box.title = 'View full screen';
      const img = document.createElement('img');
      img.src = S.poster.url; img.alt = `Infographic summary of ${S.title || 'this page'}`;
      img.onerror = () => { S.posterState = 'error'; S.poster = null; render(); };
      box.appendChild(img);
      box.onclick = () => openLightbox(S.poster.url);
      wrap.appendChild(box);
      const bar = document.createElement('div'); bar.className = 'cs-pv-bar';
      bar.appendChild(pvButton('⛶ Full screen', () => openLightbox(S.poster.url)));
      bar.appendChild(pvButton('📝 Text', () => { S.showText = true; render(); }, 'Show the text summary'));
      wrap.appendChild(bar);
      scroll.appendChild(wrap);
      scroll.scrollTop = 0;
      return;
    }

    const hasText = (m.messages || []).some(x => x.role === 'assistant');
    const failed = m.error || S.posterState === 'error' || (!m.inProgress && !hasText);
    if (failed) {
      const card = document.createElement('div'); card.className = 'cs-pv-load cs-pv-failed';
      const t = document.createElement('div'); t.className = 'cs-pv-label';
      t.textContent = m.error ? 'The summary failed.' : "The infographic didn't come through.";
      const sub = document.createElement('div'); sub.className = 'cs-hint';
      sub.textContent = m.error ? String(m.error) : 'The text summary is still available.';
      card.appendChild(t); card.appendChild(sub);
      wrap.appendChild(card);
      const bar = document.createElement('div'); bar.className = 'cs-pv-bar';
      if (hasText) bar.appendChild(pvButton('📝 Show text summary', () => { S.showText = true; render(); }));
      bar.appendChild(pvButton('↻ Try again', () => regenerate()));
      wrap.appendChild(bar);
      scroll.appendChild(wrap);
      return;
    }

    // Loading: a faint ghost of a poster layout that slowly breathes, plus one quiet status line.
    const stage = posterStage(m);
    const card = document.createElement('div'); card.className = 'cs-pv-load';
    const ghost = document.createElement('div'); ghost.className = 'cs-ghost';
    ghost.innerHTML = `
      <div class="cs-gh" style="width:58%;height:13px"></div>
      <div class="cs-gh" style="width:34%;height:8px"></div>
      <div class="cs-gh-grid">
        <div class="cs-gh"></div><div class="cs-gh"></div><div class="cs-gh"></div><div class="cs-gh"></div>
      </div>
      <div class="cs-gh" style="width:82%;height:7px"></div>`;
    ghost.querySelectorAll('.cs-gh').forEach((g, i) => { g.style.animationDelay = `${i * 0.18}s`; });
    const foot = document.createElement('div'); foot.className = 'cs-pv-foot';
    const label = document.createElement('div'); label.className = 'cs-pv-label';
    label.textContent = stage.label;
    const el = document.createElement('div'); el.className = 'cs-hint'; el.id = 'cs-pv-elapsed';
    el.dataset.step = stage.step;
    foot.appendChild(label); foot.appendChild(el);
    card.appendChild(ghost); card.appendChild(foot);
    wrap.appendChild(card);
    if (hasText) {
      const bar = document.createElement('div'); bar.className = 'cs-pv-bar';
      bar.appendChild(pvButton('📝 Read text while you wait', () => { S.showText = true; render(); }));
      wrap.appendChild(bar);
    }
    scroll.appendChild(wrap);
    startElapsedTicker();
  }

  let elapsedTimer = null;
  function startElapsedTicker() {
    const start = S.loadStartedAt || Date.now();   // don't write it: it marks a run started HERE
    const tick = () => {
      const el = byId('cs-pv-elapsed');
      if (!el) { stopElapsedTicker(); return; }
      const s = Math.floor((Date.now() - start) / 1000);
      el.textContent = `Step ${el.dataset.step} of 3 · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    elapsedTimer = setInterval(tick, 1000);
  }
  function stopElapsedTicker() { clearInterval(elapsedTimer); elapsedTimer = null; }

  // Full-screen lightbox over the page itself (no new tab). Click the image to toggle between
  // fit-to-screen and actual size; Esc or ✕ closes; ⛶ or F goes browser-fullscreen.
  function openLightbox(url) {
    closeLightbox();
    const ov = document.createElement('div'); ov.id = 'cs-lightbox';
    const img = document.createElement('img'); img.src = url; img.alt = `Infographic summary of ${S.title || 'this page'}`;
    img.onclick = (e) => { e.stopPropagation(); ov.classList.toggle('cs-lb-zoom'); };
    const tools = document.createElement('div'); tools.className = 'cs-lb-tools';
    const mk = (glyph, title, fn) => {
      const b = document.createElement('button'); b.textContent = glyph; b.title = title;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      tools.appendChild(b);
    };
    mk('⛶', 'Browser full screen (F)', () => toggleLbFullscreen(ov));
    mk('↗', 'Open original in a new tab', () => { try { window.open(url, '_blank'); } catch (_) {} });
    mk('✕', 'Close (Esc)', closeLightbox);
    ov.appendChild(img); ov.appendChild(tools);
    ov.onclick = () => closeLightbox();
    document.body.appendChild(ov);
    document.addEventListener('keydown', lbKeys, true);
  }
  // Capture phase so YouTube's own shortcuts (f, k, space, arrows) don't fire under the overlay.
  function lbKeys(e) {
    const ov = document.getElementById('cs-lightbox');
    if (!ov) { document.removeEventListener('keydown', lbKeys, true); return; }
    e.stopPropagation();
    if (e.key === 'Escape') { if (!document.fullscreenElement) { e.preventDefault(); closeLightbox(); } }
    else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleLbFullscreen(ov); }
    else if (e.key === ' ') { e.preventDefault(); }
  }
  function toggleLbFullscreen(ov) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (ov.requestFullscreen) ov.requestFullscreen().catch(() => {});
  }
  function closeLightbox() {
    const ov = document.getElementById('cs-lightbox');
    if (!ov) return;
    if (document.fullscreenElement === ov) document.exitFullscreen().catch(() => {});
    ov.remove();
    document.removeEventListener('keydown', lbKeys, true);
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
    const input = byId('cs-followup');
    const send = byId('cs-send');
    const m = S.models[S.activeModelId];
    // A chat is ready as soon as its context turn exists; a summary needs its first answer.
    const ready = S.mode === 'chat' ? Boolean(m && m.messages && m.messages.length) : Boolean(m && m.messages && m.messages.some(x => x.role === 'assistant'));
    const canChat = ready && !m.inProgress;
    const idle = S.mode === 'chat' && !m?.messages?.some(x => x.role === 'assistant') ? 'Ask anything about this video…' : 'Ask a follow-up…';
    if (input) { input.disabled = !canChat; input.placeholder = m && m.inProgress ? 'Generating…' : idle; }
    if (send) send.disabled = !canChat;
  }

  function refreshModelPicker() {
    const picker = byId('cs-modelpick');
    if (!picker) return;
    const meta = activeMeta();
    picker.querySelector('.cs-mp-ico').innerHTML = iconHTML(meta.icon || '✨');
    picker.querySelector('.cs-mp-name').textContent = meta.name || 'Model';
  }

  // ===========================================================================
  // Model picker dropdown
  // ===========================================================================
  function showModelMenu(anchor) {
    const existing = byId('cs-model-menu');
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
      item.innerHTML = `<span>${iconHTML(mdl.icon)}</span><span>${escapeHtml(mdl.name)}</span>`;
      if (mdl.id === currentId) { const c = document.createElement('span'); c.className = 'cs-check'; c.textContent = '✓'; item.appendChild(c); }
      item.onclick = () => { close(); chooseModel(mdl.id); };
      menu.appendChild(item);
    });

    const onAway = (e) => { if (!menu.contains(e.target) && e.target !== anchor) close(); };
    const doc = pdoc();
    function close() { menu.remove(); doc.removeEventListener('click', onAway); }
    menu._close = close;
    doc.body.appendChild(menu);
    setTimeout(() => doc.addEventListener('click', onAway), 0);
  }

  function chooseModel(id) {
    // Remember as the default everywhere.
    try { chrome.storage.local.set({ 'pref:defaultModel': id }); } catch (e) {}
    const meta = modelMeta(id);
    if (S.mode === 'chat') {
      // Never regenerate a chat into a summary. The next question goes to the new model, and the
      // background/Worker carry the conversation over.
      const prev = S.models[S.activeModelId];
      if (prev?.inProgress) return;
      const m = ensureLocalModel(id);
      if (id !== S.activeModelId && prev) { m.messages = [...prev.messages]; m.complete = true; m.inProgress = false; m.streaming = ''; }
      m.usedModel = meta;
      S.activeModelId = id;
      render();
      return;
    }
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
    const box = byId('cs-promptbox');
    const btn = byId('cs-prompt-toggle');
    if (!box) return;
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (btn) btn.classList.toggle('cs-on', show);
    if (show) {
      const ta = byId('cs-prompt-input');
      ta.value = S.prompt || defaultPromptText();
      ta.focus();
    }
  }
  function applyPrompt() {
    const ta = byId('cs-prompt-input');
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
    const input = byId('cs-followup');
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
    const flash = () => { const b = byId('cs-copy'); if (b) { b.innerHTML = I.check; setTimeout(() => b.innerHTML = I.copy, 1400); } };
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
    const scroll = byId('cs-scroll');
    const composer = byId('cs-composer');
    const toolbar = byId('cs-toolbar');
    const promptBox = byId('cs-promptbox');
    const titleEl = byId('cs-title');
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
    ico.innerHTML = item.mode === 'chat' ? '💬' : iconHTML(item.isTranscript ? '🎬' : (item.modelIcon || '📄'));
    const body = document.createElement('div'); body.className = 'cs-hist-body';
    const title = document.createElement('div'); title.className = 'cs-hist-title';
    title.textContent = item.title || item.url || 'Untitled';
    const snip = document.createElement('div'); snip.className = 'cs-hist-snip'; snip.textContent = item.snippet || '';
    const meta = document.createElement('div'); meta.className = 'cs-hist-meta';
    const parts = [];
    if (item.modelName) parts.push(`${iconHTML(item.modelIcon)} ${escapeHtml(item.modelName)}`.trim());
    parts.push(escapeHtml(formatAge(item.timestamp)));
    if (item.inProgress) parts.push('⏳ generating');
    meta.innerHTML = parts.join('&nbsp; ·&nbsp; ');
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
      S.poster = null; S.posterTried = false; S.posterState = null; S.showText = false;   // the foreign page's poster, not this one's
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
    label.innerHTML = `<span style="margin-right:6px">${iconHTML(meta.icon || '📄')}</span>${S.mode === 'chat' ? 'Chat ready' : 'Summary ready'}`;
    const x = document.createElement('span'); x.className = 'cs-pill-x'; x.innerHTML = I.x;
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
  // The poster lands a minute or two after the summary, so while the Worker reports it as
  // 'generating' we re-ask every 15s (capped). A posterReady broadcast short-circuits this.
  let posterPollTimer = null;
  function maybeLoadPoster(attempt = 0) {
    if (S.noPoster) return;
    if (S.posterTried && attempt === 0) return;
    S.posterTried = true;
    clearTimeout(posterPollTimer);
    const forUrl = S.foreignUrl || S.fullUrl;
    sendToBackground({ action: 'getPoster', url: forUrl }, (resp) => {
      if (!resp || (S.foreignUrl || S.fullUrl) !== forUrl) return; // navigated away meanwhile
      const m = S.models[S.activeModelId];
      // 'none' right after the summary lands only means the Worker hasn't written the poster
      // row yet, so keep waiting a little. Give up after ~5 min.
      // Only a run started in this page can be waiting on a not-yet-written poster row; an old
      // saved summary with no poster opens straight to its text.
      const fresh = S.loadStartedAt && Date.now() - S.loadStartedAt < 10 * 60e3;
      if (resp.type === 'none' && !fresh) { S.showText = true; if (panelEl() && S.view === 'summary') render(); return; }
      const stillComing = resp.type === 'pending' || (resp.type === 'none' && m && m.complete && attempt < 6);
      if (resp.type === 'poster' && resp.url) {
        S.poster = { url: resp.url }; S.posterState = 'ready';
      } else if (stillComing && attempt < 40) {
        S.posterState = 'pending';
        posterPollTimer = setTimeout(() => maybeLoadPoster(attempt + 1), 8000);
        return;
      } else if (resp.type === 'error' || stillComing || (m && m.complete)) {
        S.posterState = 'error';
      } else {
        return;
      }
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
    S.mode = state.mode || 'summary';
    S.sourceWords = state.sourceWords || 0;
    S.sourcePreview = state.sourcePreview || '';
    S.noPoster = Boolean(state.noPoster);
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
    S.hasSaved = Object.values(S.models).some(m => (m.messages || []).some(x => x.role === 'assistant')) ||
      (S.mode === 'chat' && Boolean(state.hasSource));
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
    if (request.action === 'configError') {
      // Background can't run anything. Stop every spinner on the page (selection FABs and the
      // YouTube player/tile buttons) and say why, instead of leaving them rotating forever.
      console.error('AI Config Error:', request.error);
      document.querySelectorAll('.fab, #yt-btn-container button, .yt-sum-tile-btn')
        .forEach(b => { if (b.setLoading) b.setLoading(false); });
      const m = S.activeModelId && S.models?.[S.activeModelId];
      if (m && m.inProgress) { m.inProgress = false; m.streaming = ''; m.phase = null; m.error = request.error; render(); }
      showStaleBanner(`⚠️ ${request.error}`);
      return;
    }

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
      // A brand-new run resets the infographic view; the second initSummary of the same YouTube
      // run (after the transcript arrives) keeps the elapsed counter going.
      if (request.phase === 'transcript' || !m.inProgress) resetPosterView(request.noPoster);
      else S.noPoster = Boolean(request.noPoster);
      m.messages = []; m.streaming = ''; m.inProgress = true; m.complete = false; m.error = null;
      m.usedModel = request.usedModel || modelMeta(request.modelId);
      m.phase = request.phase || null;   // 'transcript' → panel shows "Fetching transcript…" instantly
      S.mode = request.mode || 'summary';
      S.sourceWords = 0; S.sourcePreview = '';
      ensurePanelOpen();
      return;
    }

    // Chat job is set up: transcript is context, nothing generated. Show the card + composer.
    if (request.action === 'chatReady' && forThisUrl) {
      S.foreignUrl = null;
      S.mode = 'chat';
      S.activeModelId = request.modelId;
      S.sourceWords = request.sourceWords || 0;
      S.sourcePreview = request.sourcePreview || '';
      S.hasSaved = true;
      const m = ensureLocalModel(request.modelId);
      m.messages = [{ role: 'user', content: '' }];   // the internal context turn (never rendered)
      m.streaming = ''; m.inProgress = false; m.complete = true; m.phase = null;
      m.usedModel = request.usedModel || modelMeta(request.modelId);
      ensurePanelOpen();
      const input = byId('cs-followup');
      if (input) input.focus();
      return;
    }

    // While a foreign (read-only) summary is on screen, ignore live deltas for THIS page — the
    // background still accumulates + persists them; the own view rehydrates when we return to it.
    if (S.foreignUrl && ['regenStart', 'followupStart', 'updateSummary', 'summaryComplete', 'summaryError'].includes(request.action)) {
      return;
    }

    if (request.action === 'regenStart' && forThisUrl) {
      S.activeModelId = request.modelId;
      S.mode = 'summary';
      if (request.prompt != null) S.prompt = request.prompt;
      const m = ensureLocalModel(request.modelId);
      // No poster yet (it failed or never came)? This run gets another shot at one.
      if (!S.poster) { S.posterTried = false; S.posterState = null; S.loadStartedAt = Date.now(); }
      m.error = null;
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

    if (request.action === 'posterReady' && forThisUrl && !S.foreignUrl) {
      S.posterTried = false;
      maybeLoadPoster();
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
      m.inProgress = false; m.streaming = ''; m.phase = null; m.error = request.error || 'Unknown error';
      // (In a chat, index 0 is the context turn — never pop that, only a pending question.)
      const keep = S.mode === 'chat' ? 1 : 0;
      if (m.messages.length > keep && m.messages[m.messages.length - 1].role === 'user') m.messages.pop();
      // A chat that failed before its transcript arrived has no context to talk to.
      if (S.mode === 'chat' && !m.messages.length) S.mode = 'summary';
      ensurePanelOpen();
      if (!S.noPoster && !S.showText && S.mode !== 'chat') { render(); return; }
      const scroll = byId('cs-scroll');
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
  function onEscape(e) {
    if (e.key !== 'Escape' || !panelEl()) return;
    const ae = pdoc().activeElement;
    if (ae && (ae.id === 'cs-followup' || ae.id === 'cs-prompt-input') && ae.value) { ae.blur(); return; }
    closePanel();
  }

  function init() {
    injectStyles();
    injectFABs();

    // Escape closes the panel (a keyboard interaction is intent — but don't steal it from a
    // text field the reader is typing in; blur first so their draft isn't lost on the first tap).
    document.addEventListener('keydown', onEscape);

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
