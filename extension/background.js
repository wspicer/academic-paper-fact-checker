// Clicking the toolbar icon opens the side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "fc-selection",
    title: "Fact-check selected text",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "fc-selection" || !tab) return;
  // Open first (must happen inside the user gesture), then hand the text to the panel.
  await chrome.sidePanel.open({ tabId: tab.id });
  await chrome.storage.session.set({
    pendingSelection: { text: info.selectionText, tabId: tab.id, at: Date.now() },
  });
});
