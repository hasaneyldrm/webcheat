/**
 * WebCheat service worker.
 *
 * It has two jobs:
 *   1. Open the CE window when the extension icon is clicked.
 *   2. Route RPC traffic between the panel and target frames.
 */

const PANEL_URL = 'src/ui/panel.html';
let panelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (e) {
      panelWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL_URL),
    type: 'popup',
    width: 1180,
    height: 820
  });
  panelWindowId = win.id;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === panelWindowId) panelWindowId = null;
});

/**
 * Send an RPC call to a single frame.
 *
 * timeoutMs is required: for suspended, frozen, or worker-less tabs, sendMessage
 * neither returns a response nor sets lastError, so it hangs forever. One broken
 * tab used to block the entire tab list.
 */
function rpc(tabId, frameId, payload, timeoutMs = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    if (timeoutMs > 0) setTimeout(() => done({ error: 'timeout' }), timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, { __wce: 'rpc', payload }, { frameId }, (res) => {
        if (chrome.runtime.lastError) done({ error: chrome.runtime.lastError.message });
        else done(res || { error: 'empty response' });
      });
    } catch (e) {
      done({ error: String(e && e.message || e) });
    }
  });
}

const PROBE_TIMEOUT = 1500;

/**
 * List scannable targets.
 *
 * Tabs WITHOUT the agent are also listed. The game tab was often opened before
 * the extension was installed or reloaded, so it has no content script.
 * Previously those tabs disappeared from the list and looked impossible to
 * find. They now appear with a "no agent" marker and the panel offers Reload Tab.
 */
async function listTargets() {
  const tabs = await chrome.tabs.query({});

  const results = await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) return null;

    const base = {
      tabId: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      discarded: !!tab.discarded,
      frames: [],
      hasAgent: false,
      hasMemory: false
    };

    // Do not wake a discarded tab; show it as discarded in the list.
    if (tab.discarded) return base;

    let frames = [];
    try {
      frames = (await chrome.webNavigation.getAllFrames({ tabId: tab.id })) || [];
    } catch (e) {
      frames = [{ frameId: 0, url: tab.url }];
    }

    const live = (await Promise.all(frames.map(async (fr) => {
      const res = await rpc(tab.id, fr.frameId, { cmd: 'hello' }, PROBE_TIMEOUT);
      if (!res || res.error || !res.result) return null;
      return {
        frameId: fr.frameId,
        url: res.result.url || fr.url,
        top: !!res.result.top,
        regions: res.result.regions || [],
        speed: res.result.speed
      };
    }))).filter(Boolean);

    live.sort((a, b) => (b.regions.length - a.regions.length) || (a.frameId - b.frameId));
    base.frames = live;
    base.hasAgent = live.length > 0;
    base.hasMemory = live.some((f) => f.regions.length > 0);
    return base;
  }));

  const out = results.filter(Boolean);
  // Sort WASM tabs first, then tabs with an agent, and tabs without one last.
  out.sort((a, b) =>
    (b.hasMemory - a.hasMemory) ||
    (b.hasAgent - a.hasAgent) ||
    (a.tabId - b.tabId)
  );
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__wcePanel !== true) return;

  (async () => {
    try {
      switch (msg.op) {
        case 'listTargets':
          sendResponse({ result: await listTargets() });
          break;
        case 'rpc':
          // Never let the panel wait forever.
          sendResponse(await rpc(msg.tabId, msg.frameId, msg.payload, 20000));
          break;
        case 'reload':
          await chrome.tabs.reload(msg.tabId);
          sendResponse({ result: { ok: true } });
          break;
        default:
          sendResponse({ error: 'unknown operation: ' + msg.op });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
  })();

  return true; // async
});
