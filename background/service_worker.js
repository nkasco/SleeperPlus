chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') {
    return;
  }

  if (message.type === 'SLEEPER_PLUS_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
  }
});
