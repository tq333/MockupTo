/**
 * Mockup Sync · Chrome Extension popup (slim version)
 *
 * Behavior:
 *   - Header shows brand icon + name + version
 *   - Page-info card shows page title + LIVE canvas width (px)
 *     · Polled every 250ms so resizing the browser updates the readout.
 *   - One big yellow button captures the active tab.
 *   - Defaults (no UI controls):  toast = OFF,  auto-copy IR JSON = ON
 *   - No history, no download checkbox.
 */

const $ = (id) => document.getElementById(id);

const els = {
  pageTitle:  $('pageTitle'),
  pageMeta:   $('pageMeta'),
  captureBtn: $('captureBtn'),
  status:     $('status'),
  extVersion: $('extVersion'),
  mappingVer: $('mappingVer'),
  reloadBtn:  $('reloadBtn'),
};

// ─── Live width polling state ───────────────────────────────────────────────
const WIDTH_POLL_MS = 250;
let _widthTimer  = null;
let _activeTabId = null;
let _widthPaused = false;
let _lastWidth   = null;

// ─── Init ────────────────────────────────────────────────────────────────────

(async function init() {
  els.extVersion.textContent = 'v' + chrome.runtime.getManifest().version;

  await refreshActiveTab();
  startWidthPolling();

  els.captureBtn.addEventListener('click', onCaptureClick);
  els.reloadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.reload();
  });

  window.addEventListener('unload', stopWidthPolling);
})();

// ─── Active tab info ─────────────────────────────────────────────────────────

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  _activeTabId = tab.id || null;
  els.pageTitle.textContent = tab.title || '(untitled)';

  const url = tab.url || '';
  const blocked =
    url.startsWith('chrome:') || url.startsWith('chrome-extension:') ||
    url.startsWith('edge:')   || url.startsWith('about:') || url === '';

  if (blocked) {
    els.captureBtn.disabled = true;
    els.pageMeta.textContent = '画布宽度：— px';
    setStatus('warn', 'Chrome 内部页面无法捕获。请打开任意 http/https/file 网页再试。');
    _widthPaused = true;
    return;
  }

  // Prime once so the user doesn't see "—" for the first tick.
  await pollCanvasWidthOnce();
}

// ─── Live canvas-width polling ──────────────────────────────────────────────

function startWidthPolling() {
  stopWidthPolling();
  _widthTimer = setInterval(pollCanvasWidthOnce, WIDTH_POLL_MS);
}
function stopWidthPolling() {
  if (_widthTimer) { clearInterval(_widthTimer); _widthTimer = null; }
}

async function pollCanvasWidthOnce() {
  if (_widthPaused || !_activeTabId) return;
  try {
    const [{ result: w }] = await chrome.scripting.executeScript({
      target: { tabId: _activeTabId },
      world: 'MAIN',
      func: () => Math.round(
        document.documentElement.clientWidth || window.innerWidth || 0
      ),
    });
    if (w && w !== _lastWidth) {
      _lastWidth = w;
      els.pageMeta.textContent = '画布宽度：' + w + ' px';
    } else if (!w && _lastWidth !== null) {
      _lastWidth = null;
      els.pageMeta.textContent = '画布宽度：— px';
    }
  } catch (_) {
    // Tab navigated to chrome:// or got closed mid-poll.
    _widthPaused = true;
    els.pageMeta.textContent = '画布宽度：— px';
  }
}

// ─── Capture flow ────────────────────────────────────────────────────────────

async function onCaptureClick() {
  els.captureBtn.disabled = true;
  _widthPaused = true;
  setStatus('busy', '捕获中… DOM walking, font waiting, IR building.');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab.');

    // Hardcoded defaults — no UI controls now.
    const showToast = false;   // page-side toast off (popup already shows status)
    const wantCopy  = true;    // always auto-copy IR JSON

    // 1. Set page-side flags before injecting bundle.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: (showToast) => {
        window.__mkSkipAutoRun   = true;
        window.__mkSkipClipboard = true;
        window.__mkSkipToast     = !showToast;
      },
      args: [showToast],
    });

    // 2. Inject capture bundle.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      files: ['lib/capture.bundle.js'],
    });

    // 3. Run capture and pull back IR envelope.
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

    if (!envelope) throw new Error('Capture returned nothing.');
    if (envelope.__error) throw new Error(envelope.__error);

    const json  = JSON.stringify(envelope, null, 2);
    const stats = (envelope.meta && envelope.meta.stats) || {};

    // 4. Auto-copy.
    if (wantCopy) {
      await navigator.clipboard.writeText(json).catch(() => {});
    }

    // 5. Refresh canvas width readout from the actual captured root.
    const rootWidth = pickRootWidth(envelope);
    if (rootWidth) {
      _lastWidth = Math.round(rootWidth);
      els.pageMeta.textContent = '画布宽度：' + _lastWidth + ' px';
    }

    // 6. Update mapping-version chip.
    if (envelope.meta && envelope.meta.mappingVersion) {
      els.mappingVer.textContent = 'mapping ' + envelope.meta.mappingVersion;
    }

    const lines = [
      '✓ 已捕获',
      (stats.nodesTotal || 0) + ' nodes · ' +
      (stats.framesEmitted || 0) + ' frames · ' +
      (stats.textsEmitted || 0) + ' texts · ' +
      (stats.imagesEmitted || 0) + ' imgs',
    ];
    if (wantCopy) lines.push('IR JSON 已复制到剪贴板');
    if (stats.unmapped && stats.unmapped.length) {
      lines.push('⚠ ' + stats.unmapped.length + ' 个节点未映射');
    }
    setStatus('ok', lines.join('\n'));

  } catch (err) {
    console.error('[mockup-sync] capture failed', err);
    setStatus('err', '✗ ' + (err && err.message || String(err)));
  } finally {
    els.captureBtn.disabled = false;
    _widthPaused = false;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(kind, text) {
  els.status.className = 'status ' + kind;
  els.status.textContent = text;
}

/** Walk the IR envelope's root frame and return its width, if available. */
function pickRootWidth(envelope) {
  const root = envelope && envelope.root;
  if (!root) return null;
  if (root.bounds && typeof root.bounds.w === 'number') return root.bounds.w;
  if (root.frame  && typeof root.frame.w  === 'number') return root.frame.w;
  if (root.size   && typeof root.size.w   === 'number') return root.size.w;
  return null;
}
