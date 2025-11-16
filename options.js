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
