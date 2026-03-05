// content-dual.js - Config-driven multi-model streaming UI with persistence

// Check if already initialized
if (typeof window.claudeSummarizerInitialized === 'undefined') {
  window.claudeSummarizerInitialized = true;

  // Quota limits
  const QUOTA = {
    MAX_MESSAGES_PER_MODEL: 20,
    MAX_CHARS_PER_MESSAGE: 50000,
    MAX_ORIGINAL_TEXT_CHARS: 100000,
    MAX_SESSIONS: 50
  };

  // State management
  const state = {
    config: null,
    activeTab: null,
    models: {},
    transcript: null,
    originalText: null,
    waitingForFirstToken: false
  };

  // Storage key - normalized URL
  function getStorageKey() {
    const url = new URL(location.href);
    return `session:${url.origin}${url.pathname}`;
  }

  // Format timestamp as relative time
  function formatAge(timestamp) {
    const ageMs = Date.now() - timestamp;
    const hours = Math.floor(ageMs / (1000 * 60 * 60));
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Inject markdown CSS styles
  function injectMarkdownStyles() {
    if (document.getElementById('claude-markdown-styles')) return;

    const style = document.createElement('style');
    style.id = 'claude-markdown-styles';
    style.textContent = `
      .markdown-content h1, .markdown-content h2, .markdown-content h3,
      .markdown-content h4, .markdown-content h5, .markdown-content h6 {
        margin-top: 16px; margin-bottom: 8px; font-weight: 600; line-height: 1.25; color: #e0e0e0;
      }
      .markdown-content h1 { font-size: 1.8em; border-bottom: 1px solid #444; padding-bottom: 4px; }
      .markdown-content h2 { font-size: 1.5em; border-bottom: 1px solid #444; padding-bottom: 4px; }
      .markdown-content h3 { font-size: 1.25em; }
      .markdown-content p { margin-top: 0; margin-bottom: 12px; }
      .markdown-content ul, .markdown-content ol { margin-top: 0; margin-bottom: 12px; padding-left: 24px; }
      .markdown-content li { margin-bottom: 4px; }
      .markdown-content code { background: #3a3a3a; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em; color: #ff79c6; }
      .markdown-content pre { background: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 12px; overflow-x: auto; margin-bottom: 12px; }
      .markdown-content pre code { background: none; padding: 0; color: #e0e0e0; }
      .markdown-content blockquote { border-left: 3px solid #5C5CFF; margin: 12px 0; padding-left: 12px; color: #b0b0b0; font-style: italic; }
      .markdown-content a { color: #5C5CFF; text-decoration: none; }
      .markdown-content strong { font-weight: 600; color: #f0f0f0; }
      .markdown-content hr { border: none; border-top: 1px solid #444; margin: 16px 0; }
      .followup-trigger { color: #5C5CFF; cursor: pointer; font-size: 13px; margin-top: 16px; display: inline-block; }
      .followup-trigger:hover { text-decoration: underline; }
      .followup-inline { display: flex; gap: 8px; margin-top: 12px; }
      .followup-inline input { flex: 1; padding: 8px 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; font-size: 14px; }
      .followup-inline input:focus { outline: none; border-color: #5C5CFF; }
      .followup-inline button { padding: 8px 12px; background: #5C5CFF; border: none; border-radius: 4px; color: white; cursor: pointer; font-size: 14px; }
      .followup-inline button:hover { background: #4646FF; }
      #resume-banner { position: fixed; bottom: 20px; right: 20px; background: #2a2a2a; color: #e0e0e0; padding: 12px 16px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.3); z-index: 10001; display: flex; align-items: center; gap: 12px; font-size: 14px; }
      #resume-banner button { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
      #resume-btn { background: #5C5CFF; color: white; }
      #dismiss-btn { background: transparent; color: #888; }
    `;
    document.head.appendChild(style);
  }

  // Render markdown with XSS protection
  function renderMarkdown(text) {
    if (!text) return '';
    injectMarkdownStyles();
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return text;
    try {
      return DOMPurify.sanitize(marked.parse(text));
    } catch (e) {
      return text;
    }
  }

  // Play completion sound
  function playCompletionSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playNote = (freq, start, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, start);
        gain.gain.exponentialRampToValueAtTime(0.01, start + dur);
        osc.start(start);
        osc.stop(start + dur);
      };
      const now = ctx.currentTime;
      playNote(523.25, now, 0.15);
      playNote(659.25, now + 0.15, 0.2);
    } catch (e) {}
  }

  // Initialize state for models from config
  function initModelsState(config) {
    state.config = config;
    state.activeTab = config.models[0].id;
    state.models = {};
    config.models.forEach(m => {
      state.models[m.id] = {
        messages: [],
        content: '',
        inProgress: false,
        complete: false,
        duration: null
      };
    });
  }

  // Reset state
  function resetState() {
    if (state.config) {
      state.config.models.forEach(m => {
        state.models[m.id] = {
          messages: [],
          content: '',
          inProgress: false,
          complete: false,
          duration: null
        };
      });
    }
    state.transcript = null;
    state.originalText = null;
    state.waitingForFirstToken = false;
  }

  // Create dynamic tabs from config
  function createTabs(tabBar) {
    state.config.models.forEach(model => {
      const tab = document.createElement('button');
      tab.id = `${model.id}-tab`;
      tab.innerHTML = model.icon;
      tab.title = model.name;
      tab.style.cssText = `
        flex: 1; padding: 10px; background: ${state.activeTab === model.id ? '#2a2a2a' : 'transparent'};
        color: #e0e0e0; border: none; border-bottom: 2px solid ${state.activeTab === model.id ? '#5C5CFF' : 'transparent'};
        cursor: pointer; font-size: 20px; transition: all 0.2s; position: relative;
      `;
      tab.onclick = () => switchTab(model.id);

      // Status badge
      const badge = document.createElement('span');
      badge.id = `${model.id}-badge`;
      badge.innerHTML = '•';
      badge.style.cssText = `
        position: absolute; top: 5px; right: 5px; font-size: 20px; display: none;
        color: ${state.models[model.id]?.inProgress ? '#FFC107' : '#50C550'};
      `;
      tab.appendChild(badge);
      tabBar.appendChild(tab);
    });
  }

  // Switch active tab
  function switchTab(tabId) {
    state.activeTab = tabId;

    state.config.models.forEach(model => {
      const tab = document.getElementById(`${model.id}-tab`);
      const content = document.getElementById(`${model.id}-content`);
      if (tab) {
        tab.style.background = model.id === tabId ? '#2a2a2a' : 'transparent';
        tab.style.borderBottom = `2px solid ${model.id === tabId ? '#5C5CFF' : 'transparent'}`;
      }
      if (content) {
        content.style.display = model.id === tabId ? 'block' : 'none';
      }

      // Hide badge for active complete tab
      const badge = document.getElementById(`${model.id}-badge`);
      if (badge && model.id === tabId && state.models[model.id]?.complete) {
        badge.style.display = 'none';
      }
    });

    updateContentDisplay();
  }

  // Update badge for a model
  function updateBadge(modelId) {
    const badge = document.getElementById(`${modelId}-badge`);
    if (!badge) return;

    const modelState = state.models[modelId];
    if (modelState.inProgress) {
      badge.style.color = '#FFC107';
      badge.style.display = modelId !== state.activeTab ? 'block' : 'none';
    } else if (modelState.complete) {
      badge.style.color = '#50C550';
      badge.style.display = modelId !== state.activeTab ? 'block' : 'none';
    } else {
      badge.style.display = 'none';
    }
  }

  // Update content display for active tab
  function updateContentDisplay() {
    const modelId = state.activeTab;
    const modelState = state.models[modelId];
    const contentEl = document.getElementById(`${modelId}-content`);
    if (!contentEl || !modelState) return;

    contentEl.innerHTML = renderMarkdown(modelState.content) || '<div style="color: #888; padding: 20px; text-align: center;">Loading...</div>';

    // Add "Ask about this..." link if complete and not already showing input
    if (modelState.complete && !modelState.inProgress) {
      const existingTrigger = contentEl.querySelector('.followup-trigger');
      const existingInline = contentEl.querySelector('.followup-inline');
      if (!existingTrigger && !existingInline) {
        const trigger = document.createElement('div');
        trigger.className = 'followup-trigger';
        trigger.textContent = '💬 Ask about this...';
        trigger.onclick = () => showInlineFollowup(modelId, contentEl, trigger);
        contentEl.appendChild(trigger);
      }
    }
  }

  // Show inline followup input
  function showInlineFollowup(modelId, contentEl, trigger) {
    trigger.remove();

    const container = document.createElement('div');
    container.className = 'followup-inline';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask a follow-up...';
    input.onkeydown = (e) => { if (e.key === 'Enter') sendFollowupFrom(modelId, input, container); };

    const btn = document.createElement('button');
    btn.textContent = '➤';
    btn.onclick = () => sendFollowupFrom(modelId, input, container);

    container.appendChild(input);
    container.appendChild(btn);
    contentEl.appendChild(container);
    input.focus();
  }

  // Send followup from inline input
  function sendFollowupFrom(modelId, input, container) {
    const question = input?.value?.trim();
    if (!question) return;

    container.remove();

    const modelState = state.models[modelId];
    modelState.messages.push({ role: 'user', content: question });
    modelState.content += `\n\n---\n\n**You:** ${question}\n\n**Assistant:** `;
    modelState.inProgress = true;
    modelState.complete = false;
    updateBadge(modelId);
    updateContentDisplay();

    chrome.runtime.sendMessage({
      action: 'followup',
      modelId: modelId,
      messages: modelState.messages
    });
  }

  // Create the main panel
  function createDualTabPanel() {
    let container = document.getElementById('claude-summary-container');
    if (container) container.remove();

    container = document.createElement('div');
    container.id = 'claude-summary-container';
    container.style.cssText = `
      position: fixed; top: 20px; right: 20px; width: 420px; max-height: 85vh;
      background: #1e1e1e; color: #e0e0e0; padding: 0; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3); z-index: 10000; font-size: 16px;
      line-height: 1.6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; flex-direction: column;
    `;

    // Drag handle
    const dragHandle = document.createElement('div');
    dragHandle.style.cssText = `
      height: 35px; background: #2a2a2a; border-radius: 8px 8px 0 0; cursor: move;
      display: flex; align-items: center; padding: 0 15px; flex-shrink: 0;
    `;

    let isDragging = false, dragStartX = 0, dragStartY = 0, elementStartX = 0, elementStartY = 0;
    dragHandle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      dragStartX = e.clientX; dragStartY = e.clientY;
      const rect = container.getBoundingClientRect();
      elementStartX = rect.left; elementStartY = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      container.style.left = `${elementStartX + e.clientX - dragStartX}px`;
      container.style.top = `${elementStartY + e.clientY - dragStartY}px`;
      container.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => isDragging = false);

    // Title
    const title = document.createElement('span');
    title.textContent = 'AI Summary';
    title.style.cssText = 'color: #e0e0e0; font-size: 14px; font-weight: 500;';
    dragHandle.appendChild(title);

    // Header buttons
    const headerBtns = document.createElement('div');
    headerBtns.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-left: auto;';

    // Copy text/transcript button (always visible)
    const copyBtn = document.createElement('button');
    copyBtn.id = 'copy-text-btn';
    copyBtn.innerHTML = '📄';
    copyBtn.title = state.transcript ? 'Copy transcript' : 'Copy text';
    copyBtn.style.cssText = `
      border: none; background: none; font-size: 16px; cursor: pointer; color: #e0e0e0;
      padding: 4px 8px; display: flex; border-radius: 4px;
    `;
    copyBtn.onclick = () => {
      const textToCopy = state.transcript || state.originalText;
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          copyBtn.innerHTML = '✓';
          setTimeout(() => copyBtn.innerHTML = '📄', 1500);
        });
      }
    };

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.innerHTML = '🔄';
    resetBtn.title = 'Regenerate';
    resetBtn.style.cssText = 'border: none; background: none; font-size: 16px; cursor: pointer; color: #e0e0e0; padding: 4px 8px; border-radius: 4px;';
    resetBtn.onclick = () => {
      if (!state.originalText) return;
      resetState();
      state.config.models.forEach(m => {
        state.models[m.id].inProgress = true;
        updateBadge(m.id);
      });
      state.waitingForFirstToken = true;
      chrome.runtime.sendMessage({ action: 'summarizeDual', text: state.originalText });
    };

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = 'border: none; background: none; font-size: 20px; cursor: pointer; color: #e0e0e0; padding: 0; width: 25px; height: 25px; border-radius: 4px;';
    closeBtn.onclick = () => {
      container.remove();
      resetState();
    };

    headerBtns.appendChild(copyBtn);
    headerBtns.appendChild(resetBtn);
    headerBtns.appendChild(closeBtn);
    dragHandle.appendChild(headerBtns);

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display: flex; gap: 0; padding: 10px 15px 0 15px; background: #1e1e1e; border-bottom: 1px solid #444; flex-shrink: 0;';
    createTabs(tabBar);

    // Content area
    const contentArea = document.createElement('div');
    contentArea.style.cssText = 'flex: 1; overflow-y: auto; padding: 20px; min-height: 200px;';

    // Create content divs for each model
    state.config.models.forEach(model => {
      const contentDiv = document.createElement('div');
      contentDiv.id = `${model.id}-content`;
      contentDiv.className = 'markdown-content';
      contentDiv.style.cssText = `display: ${model.id === state.activeTab ? 'block' : 'none'}; white-space: normal; line-height: 1.6; padding: 4px;`;

      const modelState = state.models[model.id];
      if (modelState.inProgress && !modelState.content) {
        contentDiv.innerHTML = `<div style="text-align: center; color: #888; padding: 40px 20px;"><div style="font-size: 24px; margin-bottom: 10px;">${model.icon}</div><div>Generating...</div></div>`;
      } else if (modelState.content) {
        contentDiv.innerHTML = renderMarkdown(modelState.content);
      } else {
        contentDiv.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Loading...</div>';
      }
      contentArea.appendChild(contentDiv);
    });

    container.appendChild(dragHandle);
    container.appendChild(tabBar);
    container.appendChild(contentArea);
    document.body.appendChild(container);

    return container;
  }


  // Save session to storage
  let saveCount = 0;
  async function saveSession() {
    const key = getStorageKey();

    const sessionData = {
      originalText: (state.originalText || '').slice(0, QUOTA.MAX_ORIGINAL_TEXT_CHARS),
      models: {},
      timestamp: Date.now()
    };

    Object.keys(state.models).forEach(modelId => {
      let messages = state.models[modelId].messages || [];
      messages = messages.map(m => ({
        ...m,
        content: (m.content || '').slice(0, QUOTA.MAX_CHARS_PER_MESSAGE)
      }));
      if (messages.length > QUOTA.MAX_MESSAGES_PER_MODEL) {
        messages = messages.slice(-QUOTA.MAX_MESSAGES_PER_MODEL);
      }

      sessionData.models[modelId] = {
        messages: messages,
        content: state.models[modelId].content,
        duration: state.models[modelId].duration,
        complete: state.models[modelId].complete
      };
    });

    await chrome.storage.local.set({ [key]: sessionData });

    saveCount++;
    if (saveCount % 10 === 0) {
      await cleanupOldSessions();
    }
  }

  // LRU cleanup
  async function cleanupOldSessions() {
    const all = await chrome.storage.local.get(null);
    const sessions = Object.entries(all)
      .filter(([k]) => k.startsWith('session:'))
      .map(([k, v]) => ({ key: k, timestamp: v.timestamp }))
      .sort((a, b) => b.timestamp - a.timestamp);

    if (sessions.length > QUOTA.MAX_SESSIONS) {
      const toDelete = sessions.slice(QUOTA.MAX_SESSIONS).map(s => s.key);
      await chrome.storage.local.remove(toDelete);
    }
  }

  // Check for previous session
  async function checkPreviousSession() {
    if (!state.config) return;

    const key = getStorageKey();
    const data = await chrome.storage.local.get(key);

    if (data[key]) {
      const session = data[key];
      const ageMs = Date.now() - session.timestamp;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);

      if (ageDays < 7) {
        showResumeBanner(session);
      }
    }
  }

  // Show resume banner
  function showResumeBanner(session) {
    if (document.getElementById('resume-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'resume-banner';

    const text = document.createElement('span');
    text.textContent = `📝 Previous summary (${formatAge(session.timestamp)})`;

    const resumeBtn = document.createElement('button');
    resumeBtn.id = 'resume-btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.onclick = () => {
      restoreSession(session);
      banner.remove();
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.id = 'dismiss-btn';
    dismissBtn.textContent = '✕';
    dismissBtn.onclick = () => banner.remove();

    banner.appendChild(text);
    banner.appendChild(resumeBtn);
    banner.appendChild(dismissBtn);
    document.body.appendChild(banner);
  }

  // Restore session
  function restoreSession(session) {
    state.originalText = session.originalText;

    Object.keys(session.models).forEach(modelId => {
      if (state.models[modelId]) {
        state.models[modelId] = {
          ...state.models[modelId],
          ...session.models[modelId]
        };
      }
    });

    createDualTabPanel();
    updateContentDisplay();
  }

  // Inject FABs
  function injectFABs() {
    // Spinner keyframe
    const spinStyle = document.createElement('style');
    spinStyle.textContent = `@keyframes fab-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`;
    document.head.appendChild(spinStyle);

    const fabContainer = document.createElement('div');
    fabContainer.id = 'fab-container';
    fabContainer.style.cssText = `
      position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
      display: none; gap: 8px; z-index: 10000;
    `;

    function makeFab(emoji, bg, hoverBg, title) {
      const btn = document.createElement('button');
      btn.className = 'fab';
      btn.innerHTML = emoji;
      btn.title = title;
      btn._emoji = emoji;
      btn._bg = bg;
      btn.style.cssText = `
        width: 40px; height: 40px; border-radius: 50%; background: ${bg}; color: white;
        border: none; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        display: flex; align-items: center; justify-content: center; font-size: 18px;
        transition: background-color 0.2s, opacity 0.2s; position: relative;
      `;
      btn.onmouseover = () => { if (!btn.disabled) btn.style.background = hoverBg; };
      btn.onmouseout = () => { if (!btn.disabled) btn.style.background = bg; };
      btn.setLoading = (loading) => {
        btn.disabled = loading;
        btn.style.opacity = loading ? '0.7' : '1';
        btn.style.cursor = loading ? 'wait' : 'pointer';
        btn.innerHTML = loading ? '<div style="width:16px;height:16px;border:2px solid #fff;border-top:2px solid transparent;border-radius:50%;animation:fab-spin 1s linear infinite;"></div>' : btn._emoji;
      };
      return btn;
    }

    const summarizeFab = makeFab('✨', '#5C5CFF', '#4A4AD9', 'Summarize');
    const draftFab = makeFab('✒️', '#55BF55', '#45A545', 'Draft response');
    const ccFab = makeFab('🖥️', '#333', '#444', 'Open in Claude Code');

    summarizeFab.onclick = () => {
      const selectedText = window.getSelection().toString();
      if (!selectedText) return;

      state.originalText = selectedText;
      resetState();
      state.originalText = selectedText;
      state.config.models.forEach(m => {
        state.models[m.id].inProgress = true;
      });
      state.waitingForFirstToken = true;
      summarizeFab.setLoading(true);
      chrome.runtime.sendMessage({ action: 'summarizeDual', text: selectedText });
    };

    draftFab.onclick = () => {
      const selectedText = window.getSelection().toString();
      if (!selectedText) return;
      chrome.runtime.sendMessage({ action: 'draft', text: selectedText });
    };

    ccFab.onclick = () => {
      const selectedText = window.getSelection().toString();
      if (!selectedText) return;
      ccFab.setLoading(true);
      chrome.runtime.sendMessage({ action: 'openInCC', text: selectedText });
    };

    document.addEventListener('selectionchange', () => {
      const selection = window.getSelection().toString().trim();
      fabContainer.style.display = selection ? 'flex' : 'none';
    });

    fabContainer.appendChild(summarizeFab);
    fabContainer.appendChild(draftFab);
    fabContainer.appendChild(ccFab);
    document.body.appendChild(fabContainer);
  }

  // Message listener
  chrome.runtime.onMessage.addListener((request) => {
    // Config error
    if (request.action === 'configError') {
      console.error('AI Config Error:', request.error);
      return;
    }

    // Initialize summary state
    if (request.action === 'initSummary') {
      state.originalText = request.originalText;
      state.transcript = request.transcript;

      if (request.config && !state.config) {
        initModelsState(request.config);
      }

      state.config.models.forEach(m => {
        state.models[m.id].messages = [];
        state.models[m.id].content = '';
        state.models[m.id].inProgress = true;
        state.models[m.id].complete = false;
        state.models[m.id].duration = null;
      });

      // Set flag so panel is created on first token
      state.waitingForFirstToken = true;
    }

    // Set initial message per model
    if (request.action === 'setInitialMessage') {
      if (state.models[request.modelId]) {
        state.models[request.modelId].messages = [request.initialMessage];
      }
    }

    // Update summary (delta)
    if (request.action === 'updateSummary') {
      const modelId = request.modelId;
      if (!state.models[modelId]) return;

      // Show panel on first token
      if (state.waitingForFirstToken) {
        state.waitingForFirstToken = false;
        const fab = document.querySelector('.fab[title="Summarize"]');
        if (fab && fab.setLoading) fab.setLoading(false);
        createDualTabPanel();
      }

      // Append delta to content (works for both initial and followup)
      state.models[modelId].content += request.delta;
      state.models[modelId].inProgress = true;

      if (modelId === state.activeTab) {
        updateContentDisplay();
      }
      updateBadge(modelId);
    }

    // Summary complete
    if (request.action === 'summaryComplete') {
      const modelId = request.modelId;
      if (!state.models[modelId]) return;

      state.models[modelId].inProgress = false;
      state.models[modelId].complete = true;
      state.models[modelId].duration = request.duration;

      // Store assistant response
      state.models[modelId].messages.push({
        role: 'assistant',
        content: request.response
      });

      updateBadge(modelId);
      if (modelId === state.activeTab) {
        updateContentDisplay();
      }
      playCompletionSound();
      saveSession();
    }

    // Summary error
    if (request.action === 'summaryError') {
      const modelId = request.modelId;
      if (!state.models[modelId]) return;

      state.models[modelId].inProgress = false;

      // Rollback pending user message on error
      const msgs = state.models[modelId].messages;
      if (msgs.length > 0 && msgs[msgs.length - 1].role === 'user') {
        msgs.pop();
      }

      state.models[modelId].content = `Error: ${request.error}`;
      if (modelId === state.activeTab) {
        updateContentDisplay();
      }
      updateBadge(modelId);
    }

    // Open in CC complete/error
    if (request.action === 'openInCCComplete' || request.action === 'openInCCError') {
      const fab = document.querySelector('.fab[title="Open in Claude Code"]');
      if (fab && fab.setLoading) fab.setLoading(false);
      if (request.action === 'openInCCError') console.error('Open in CC error:', request.error);
    }

    // Set transcript
    if (request.action === 'setTranscript') {
      state.transcript = request.transcript;
      const copyBtn = document.getElementById('copy-text-btn');
      if (copyBtn) copyBtn.title = 'Copy transcript';
    }
  });

  // Initialize
  async function init() {
    // Get config from background
    chrome.runtime.sendMessage({ action: 'getConfig' }, (response) => {
      if (response?.config) {
        initModelsState(response.config);
        checkPreviousSession();
      }
    });

    injectFABs();
  }

  init();

} // End initialization check
