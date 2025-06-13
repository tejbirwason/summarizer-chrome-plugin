document.getElementById('saveButton').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKeyInput').value;
  chrome.storage.sync.set({ apiKey: apiKey }, () => {
    alert('API key saved.');
  });
});

chrome.storage.sync.get(['apiKey'], (result) => {
  if (result.apiKey) {
    document.getElementById('apiKeyInput').value = result.apiKey;
  }
});
