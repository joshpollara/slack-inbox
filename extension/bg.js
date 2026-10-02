const INBOX_URL = chrome.runtime.getURL("inbox.html");

chrome.action.onClicked.addListener(async () => {
  const open = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [INBOX_URL] });
  if (open.length > 0) {
    await chrome.tabs.update(open[0].tabId, { active: true });
    await chrome.windows.update(open[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: INBOX_URL });
});
