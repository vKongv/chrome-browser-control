(() => {
  if (globalThis.BrowserControlContentLoaded) return;
  globalThis.BrowserControlContentLoaded = true;
  globalThis.BrowserControlContentCore?.installConsoleCapture?.(window);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'cbc-content') return false;

    try {
      const core = globalThis.BrowserControlContentCore;
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
        case 'query_elements':
          result = core.queryElements(message.params || {}, document);
          break;
        case 'extract_elements':
          result = core.extractElements(message.params || {}, document);
          break;
        case 'click_at':
          result = core.performClickAt(message.params || {}, document);
          break;
        case 'keypress':
          result = core.performKeypress(message.params || {}, document);
          break;
        case 'wait_for':
          result = core.waitForCondition(message.params || {}, document);
          break;
        case 'page_status':
          result = core.pageStatus(document);
          break;
        case 'console_logs':
          result = core.getConsoleLogs(message.params || {});
          break;
        case 'collect_scroll':
          result = core.collectScroll(message.params || {}, document, window);
          break;
        default:
          throw new Error(`Unsupported content action: ${message.action}`);
      }
      Promise.resolve(result)
        .then((resolved) => sendResponse({ ok: true, result: resolved }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }

    return true;
  });
})();
