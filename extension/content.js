(() => {
  if (globalThis.HermesChromeContentLoaded) return;
  globalThis.HermesChromeContentLoaded = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'hermes-content') return false;

    try {
      const core = globalThis.HermesChromeContentCore;
      if (!core) {
        throw new Error('Browser content core is not loaded in this tab');
      }

      let result;
      switch (message.action) {
        case 'ping':
          result = { ready: true, title: document.title, url: document.location.href };
          break;
        case 'snapshot':
          result = core.buildSnapshotFromDocument(document, message.params || {});
          break;
        case 'click':
          result = core.performClick(message.params || {}, document);
          break;
        case 'type':
          result = core.performType(message.params || {}, document);
          break;
        case 'scroll':
          result = core.performScroll(message.params || {}, window);
          break;
        default:
          throw new Error(`Unsupported content action: ${message.action}`);
      }
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }

    return true;
  });
})();
