document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (confirm('Are you sure you want to clear all cached summaries? This action cannot be undone.')) {
    chrome.runtime.sendMessage({ action: 'clearAllSummaries' }, (response) => {
      const statusDiv = document.getElementById('status');
      statusDiv.style.display = 'block';
      
      if (response && response.success) {
        statusDiv.className = 'success';
        statusDiv.textContent = response.message || 'All summaries cleared successfully!';
      } else {
        statusDiv.className = 'error';
        statusDiv.textContent = 'Failed to clear summaries. Please try again.';
      }
      
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 3000);
    });
  }
});

// ---- Cloud Worker settings ----
const DEFAULT_BASE = 'https://summarizer.goldenoreo.workers.dev';

(async () => {
  const s = await chrome.storage.local.get(['worker:base', 'worker:token']);
  document.getElementById('workerBase').value = s['worker:base'] || DEFAULT_BASE;
  document.getElementById('workerToken').value = s['worker:token'] || '';
})();

document.getElementById('saveWorker').addEventListener('click', async () => {
  const base = document.getElementById('workerBase').value.trim().replace(/\/$/, '');
  const token = document.getElementById('workerToken').value.trim();
  const status = document.getElementById('workerStatus');
  await chrome.storage.local.set({ 'worker:base': base, 'worker:token': token });

  // Save AND verify: a silently-wrong token would otherwise only surface later as a
  // summary that never starts.
  status.textContent = 'testing…';
  status.style.color = '#666';
  try {
    const r = await fetch(`${base}/api/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(r.status === 401 ? 'token rejected' : `HTTP ${r.status}`);
    const j = await r.json();
    status.textContent = `✓ connected — ${j.models.length} models, default ${j.defaultModelId}`;
    status.style.color = 'green';
  } catch (e) {
    status.textContent = `✗ ${e.message}`;
    status.style.color = 'crimson';
  }
});
