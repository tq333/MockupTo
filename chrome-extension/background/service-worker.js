/**
 * Mockup Sync · background service worker
 *
 * Responsibility: handle the ⌘⇧M / Ctrl+Shift+M keyboard shortcut so the user
 * can capture without opening the popup. Behavior mirrors the popup's slim
 * defaults: page-side toast = ON, auto-copy IR JSON = ON, no history.
 */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-active-tab') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const url = tab.url || '';
  if (url.startsWith('chrome:') || url.startsWith('chrome-extension:')
      || url.startsWith('edge:') || url.startsWith('about:')) {
    notify('Mockup Sync', 'Cannot capture chrome:// internal pages.');
    return;
  }

  try {
    // 1. Set page-side flags. Toast is OFF everywhere (per UX spec); user
    //    feedback comes from the toolbar badge flash at the end of this fn.
    //    We also skip the bundle's built-in clipboard write — we own copying.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__mkSkipAutoRun   = true;
        window.__mkSkipClipboard = true;
        window.__mkSkipToast     = true;
      },
    });

    // 2. Inject capture bundle.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['lib/capture.bundle.js'],
    });

    // 3. Run capture, return envelope.
    const [{ result: envelope }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async () => {
        if (typeof window.__mkRun !== 'function') {
          return { __error: 'capture bundle did not expose __mkRun' };
        }
        try { return await window.__mkRun(); }
        catch (e) { return { __error: String(e && e.message || e) }; }
      },
    });

    if (!envelope || envelope.__error) {
      throw new Error((envelope && envelope.__error) || 'Capture returned nothing.');
    }

    const json = JSON.stringify(envelope, null, 2);

    // 4. Auto-copy IR JSON to clipboard. Service workers don't have
    //    navigator.clipboard, so we hop into the page to do it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (text) => navigator.clipboard.writeText(text),
        args: [json],
      });
    } catch (_) { /* clipboard may be denied; the page-side toast still shows result */ }

    flashBadge('OK', '#2e7d32');
  } catch (err) {
    console.error('[mockup-sync/bg] capture failed', err);
    flashBadge('ERR', '#cc3300');
    notify('Mockup Sync — capture failed', String(err && err.message || err));
  }
});

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
}

function notify(title, message) {
  try {
    chrome.notifications && chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title, message,
    });
  } catch (_) { /* noop */ }
}
