/**
 * WebCheat panel — CE window.
 * Selects the target tab/frame, sends RPC calls to the agent, and displays results.
 */
'use strict';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const state = {
  targets: [],
  tabId: null,
  frameId: null,
  regionId: null,
  scanning: false,
  hasResults: false,
  speed: 1,
  prevSpeed: 1,
  regionPoll: null,
  list: [],        // address list: {key, desc, region, addr, type, value, frozen, freezeId}
  keySeq: 0
};

const FIRST_CMPS = [
  ['eq', 'Exact value'],
  ['unknown', 'Unknown initial value'],
  ['gt', 'Greater than'],
  ['lt', 'Less than'],
  ['between', 'Between']
];

const NEXT_CMPS = [
  ['eq', 'Exact value'],
  ['changed', 'Changed'],
  ['unchanged', 'Unchanged'],
  ['inc', 'Increased'],
  ['dec', 'Decreased'],
  ['incBy', 'Increased by'],
  ['decBy', 'Decreased by'],
  ['gt', 'Greater than'],
  ['lt', 'Less than'],
  ['between', 'Between']
];

const NO_VALUE = new Set(['unknown', 'changed', 'unchanged', 'inc', 'dec']);

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ __wcePanel: true, ...msg }, (res) => {
      if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
      else resolve(res || { error: 'empty response' });
    });
  });
}

async function rpc(cmd, args = {}) {
  if (state.tabId === null || state.frameId === null) return { error: 'no target selected' };
  return bg({ op: 'rpc', tabId: state.tabId, frameId: state.frameId, payload: { cmd, args } });
}

/** Queries the specified frame rather than the selected frame. */
async function rpcFrame(frameId, cmd, args = {}) {
  if (state.tabId === null) return { error: 'no tab selected' };
  return bg({ op: 'rpc', tabId: state.tabId, frameId, payload: { cmd, args } });
}

function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function setStatus(text, cls) {
  $('statusText').textContent = text;
  const dot = $('dot');
  dot.className = 'dot' + (cls ? ' ' + cls : '');
}

/* ------------------------------------------------------------------ *
 * Target selection
 * ------------------------------------------------------------------ */
async function refreshTargets() {
  setStatus('scanning tabs...', 'busy');
  const res = await bg({ op: 'listTargets' });
  if (res.error) { setStatus('error: ' + res.error); return; }

  state.targets = res.result || [];
  const tabSel = $('tabSel');
  const keepTab = state.tabId;
  tabSel.textContent = '';

  if (!state.targets.length) {
    tabSel.append(new Option('— no tabs with the agent —', ''));
    $('frameSel').textContent = '';
    setStatus('no tab found');
    toast('Reload the game tab once (pages opened before the extension was installed do not have the agent).', 6000);
    return;
  }

  for (const t of state.targets) {
    const mark = t.hasMemory ? '[WASM] '
      : t.discarded ? '[discarded] '
      : t.hasAgent ? ''
      : '[no agent] ';
    const label = mark + (t.title.length > 54 ? t.title.slice(0, 54) + '…' : t.title);
    tabSel.append(new Option(label, String(t.tabId)));
  }

  const found = state.targets.find((t) => t.tabId === keepTab);
  const pick = found || state.targets[0];
  tabSel.value = String(pick.tabId);
  selectTab(pick.tabId);
}

function selectTab(tabId) {
  state.tabId = tabId;
  clearTimeout(state.regionPoll);
  const tab = state.targets.find((t) => t.tabId === tabId);
  const frameSel = $('frameSel');
  const regionSel = $('regionSel');
  frameSel.textContent = '';
  if (!tab) return;

  // No agent: the content script was never injected into this tab (it was
  // opened before the extension was installed/reloaded). Tell the user what to do.
  if (!tab.frames.length) {
    state.frameId = null;
    state.regionId = null;
    frameSel.append(new Option(tab.discarded ? '— tab discarded —' : '— no agent —', ''));
    regionSel.textContent = '';
    regionSel.append(new Option('— no agent —', ''));
    setStatus(tab.discarded ? 'tab discarded' : 'no agent', '');
    toast(tab.discarded
      ? 'Chrome has put this tab to sleep. Visit the tab, come back, then click Refresh.'
      : 'This tab has no agent. Click "Reload Tab" — hooks must be installed before the game loads.', 6000);
    return;
  }

  for (const f of tab.frames) {
    const n = f.regions.length;
    const where = f.top ? 'top page' : 'iframe #' + f.frameId;
    const url = f.url.length > 52 ? f.url.slice(0, 52) + '…' : f.url;
    frameSel.append(new Option(`${where} — ${url}${n ? `  (${n} memory region${n === 1 ? '' : 's'})` : ''}`, String(f.frameId)));
  }

  const best = tab.frames[0];
  frameSel.value = String(best.frameId);
  selectFrame(best.frameId);
}

/**
 * Queries regions LIVE when a frame is selected instead of trusting the
 * listTargets cache. Games may create WASM late (common in Playables), which
 * would otherwise leave the panel stuck at "no memory."
 */
async function selectFrame(frameId) {
  state.frameId = frameId;
  state.regionId = null;
  clearTimeout(state.regionPoll);

  const regionSel = $('regionSel');
  regionSel.textContent = '';
  regionSel.append(new Option('— querying… —', ''));
  setStatus('looking for memory…', 'busy');

  await pollRegions(0);
}

/** Retries for a few seconds until memory appears (the game may still be loading). */
async function pollRegions(attempt) {
  const askedFrame = state.frameId;
  const res = await rpc('regions');
  if (state.frameId !== askedFrame) return;   // the user changed frames in the meantime

  const regionSel = $('regionSel');
  const regions = (!res.error && res.result) || [];

  if (!regions.length) {
    regionSel.textContent = '';
    regionSel.append(new Option('— no memory found —', ''));
    state.regionId = null;
    // After 3 failed attempts, probe other frames live and switch to one with WASM.
    // Playable games often run in a nested iframe; do not make the user search manually.
    if (attempt === 3) {
      const better = await findFrameWithMemory();
      if (better !== null && better !== state.frameId) {
        $('frameSel').value = String(better);
        toast('The game was found in ' + (better === 0 ? 'the top page' : 'iframe #' + better) + '; switched to it.', 3500);
        selectFrame(better);
        return;
      }
    }

    if (attempt < 20) {
      setStatus(`looking for memory… (${attempt + 1})`, 'busy');
      state.regionPoll = setTimeout(() => pollRegions(attempt + 1), 1000);
    } else {
      setStatus('no memory', '');
      toast('This frame has no WASM memory. The game may use pure JavaScript or run in another iframe.', 5000);
    }
    return;
  }

  const keep = state.regionId;
  regionSel.textContent = '';
  for (const r of regions) {
    const tag = r.shared ? ' [shared]' : '';
    regionSel.append(new Option(`${r.label} — ${fmtBytes(r.size)}${tag}`, r.id));
  }
  regionSel.value = regions.some((r) => r.id === keep) ? keep : regions[0].id;
  state.regionId = regionSel.value;
  setStatus(`connected — ${regions.length} memory region${regions.length === 1 ? '' : 's'}`, 'on');

  if (regions.some((r) => r.shared)) {
    toast('Memory is shared (pthread). The game loop may run in a Worker — ' +
          'scanning will work, but time control may have no effect.', 7000);
  }
}

/** Probes all tab frames live and returns the first one with WASM memory. */
async function findFrameWithMemory() {
  const tab = state.targets.find((t) => t.tabId === state.tabId);
  if (!tab) return null;

  const probes = await Promise.all(tab.frames.map(async (f) => {
    const res = await rpcFrame(f.frameId, 'regions');
    const n = (!res.error && res.result) ? res.result.length : 0;
    return { frameId: f.frameId, n };
  }));

  const hit = probes.filter((p) => p.n > 0).sort((a, b) => b.n - a.n)[0];
  return hit ? hit.frameId : null;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */
function fillCmp(list) {
  const sel = $('cmpSel');
  const keep = sel.value;
  sel.textContent = '';
  for (const [v, label] of list) sel.append(new Option(label, v));
  if (list.some(([v]) => v === keep)) sel.value = keep;
  onCmpChange();
}

function onCmpChange() {
  const cmp = $('cmpSel').value;
  $('valInput').disabled = NO_VALUE.has(cmp);
  $('val2Wrap').classList.toggle('hidden', cmp !== 'between');
}

async function doScan(kind) {
  if (!state.regionId) { toast('Select a memory region to scan first.'); return; }
  const cmp = $('cmpSel').value;
  const args = {
    region: state.regionId,
    type: $('typeSel').value,
    aligned: $('alignedChk').checked,
    cmp,
    value: $('valInput').value,
    value2: $('val2Input').value
  };

  if (!NO_VALUE.has(cmp) && args.value.trim() === '') { toast('Enter a value.'); return; }

  const res = await rpc(kind, args);
  if (res.error) { toast('Error: ' + res.error); return; }

  state.scanning = true;
  setScanUI(true);
  pollProgress();
}

function setScanUI(busy) {
  $('firstBtn').disabled = busy;
  $('nextBtn').disabled = busy || !state.hasResults;
  $('newBtn').disabled = busy;
  $('cancelBtn').classList.toggle('hidden', !busy);
  setStatus(busy ? 'scanning...' : 'connected', busy ? 'busy' : 'on');
}

async function pollProgress() {
  const res = await rpc('progress');
  if (res.error) { state.scanning = false; setScanUI(false); toast('Error: ' + res.error); return; }
  const p = res.result;

  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  $('progBar').style.width = pct + '%';
  $('foundText').innerHTML = `Found: <b>${p.found.toLocaleString('en-US')}</b>` +
    (p.running ? ` — %${pct.toFixed(0)}` : '');

  if (p.error) {
    state.scanning = false;
    setScanUI(false);
    toast('Scan error: ' + p.error);
    return;
  }

  if (p.running) { setTimeout(pollProgress, 150); return; }

  state.scanning = false;
  $('progBar').style.width = '100%';
  await loadResults();
  setScanUI(false);
}

async function loadResults() {
  const res = await rpc('results', { offset: 0, limit: 300 });
  if (res.error) { toast('Error: ' + res.error); return; }
  const r = res.result;

  state.hasResults = r.total > 0 || r.mode === 'all';
  $('nextBtn').disabled = !state.hasResults;
  fillCmp(state.hasResults ? NEXT_CMPS : FIRST_CMPS);

  const body = $('resBody');
  body.textContent = '';

  if (r.mode === 'all') {
    $('resHint').classList.remove('hidden');
    $('resHint').innerHTML = '<b>Snapshot captured.</b> Change the value in the game, then select ' +
      '<b>Increased / Decreased / Changed</b> for the <b>Next Scan</b>. This is the classic unknown-value workflow.';
    $('foundText').innerHTML = `Snapshot: <b>${r.total.toLocaleString('en-US')}</b> candidate addresses`;
    return;
  }

  $('resHint').classList.toggle('hidden', r.rows.length > 0);
  if (r.truncated) toast(`Results were capped at ${(4000000).toLocaleString('en-US')} addresses — scan for a narrower value.`, 5000);

  // For an "All" scan, summarize the number of matches for each type.
  if (r.multi && r.byType && Object.keys(r.byType).length) {
    const parts = Object.entries(r.byType).map(([t, n]) => `${t}:${n.toLocaleString('en-US')}`);
    $('foundText').innerHTML = `Found: <b>${r.total.toLocaleString('en-US')}</b> — ${parts.join(' · ')}`;
  }

  for (const row of r.rows) {
    const tr = document.createElement('tr');
    tr.className = 'dbl';
    tr.title = 'Double-click → add to address list';
    tr.append(
      td('0x' + row.addr.toString(16).toUpperCase()),
      td(row.type || ''),
      td(String(row.value)),
      td(row.prev == null ? '' : String(row.prev))
    );
    tr.addEventListener('dblclick', () => addToList(row.addr, row.type, row.value));
    body.append(tr);
  }

  if (r.total > r.rows.length) {
    const tr = document.createElement('tr');
    const cell = td(`… ${(r.total - r.rows.length).toLocaleString('en-US')} more results (narrow the scan)`);
    cell.colSpan = 4;
    cell.style.color = 'var(--muted)';
    tr.append(cell);
    body.append(tr);
  }
}

function td(text) {
  const c = document.createElement('td');
  c.textContent = text;
  return c;
}

/* ------------------------------------------------------------------ *
 * Address list
 * ------------------------------------------------------------------ */
/** Address-list entries require a concrete type; "all" cannot be used there. */
function concreteType(t) {
  return t && t !== 'all' ? t : (($('typeSel').value !== 'all' && $('typeSel').value) || 'i32');
}

function addToList(addr, type, value) {
  const entry = {
    key: 'k' + (state.keySeq++),
    desc: '',
    region: state.regionId,
    addr,
    type: concreteType(type),
    value: value == null ? '' : String(value),
    frozen: false,
    freezeId: null
  };
  state.list.push(entry);
  renderList();
}

function renderList() {
  const body = $('listBody');
  body.textContent = '';

  for (const e of state.list) {
    const tr = document.createElement('tr');

    // freeze
    const frz = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = e.frozen;
    chk.addEventListener('change', () => toggleFreeze(e, chk.checked));
    frz.append(chk);

    // description
    const desc = document.createElement('td');
    const dIn = document.createElement('input');
    dIn.type = 'text';
    dIn.value = e.desc;
    dIn.placeholder = 'coin, can...';
    dIn.addEventListener('change', () => { e.desc = dIn.value; });
    desc.append(dIn);

    // address + type
    const addr = td('0x' + e.addr.toString(16).toUpperCase());

    const typ = document.createElement('td');
    const tSel = document.createElement('select');
    for (const opt of $('typeSel').options) {
      if (opt.value === 'all') continue;   // list rows require a concrete type
      tSel.append(new Option(opt.value, opt.value));
    }
    tSel.value = e.type;
    tSel.addEventListener('change', () => { e.type = tSel.value; if (e.frozen) toggleFreeze(e, true); });
    typ.append(tSel);

    // value
    const val = document.createElement('td');
    const vIn = document.createElement('input');
    vIn.type = 'text';
    vIn.value = e.value;
    vIn.dataset.key = e.key;
    vIn.addEventListener('change', async () => {
      const res = await rpc('write', { region: e.region, addr: e.addr, type: e.type, value: vIn.value });
      if (res.error) { toast('Could not write: ' + res.error); return; }
      e.value = vIn.value;
      if (e.frozen) toggleFreeze(e, true);   // refresh the frozen value
      toast('Written: 0x' + e.addr.toString(16).toUpperCase() + ' = ' + vIn.value, 1400);
    });
    val.append(vIn);

    // remove
    const act = document.createElement('td');
    const x = document.createElement('button');
    x.className = 'cell-x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', async () => {
      if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
      state.list = state.list.filter((o) => o !== e);
      renderList();
    });
    act.append(x);

    tr.append(frz, desc, addr, typ, val, act);
    body.append(tr);
  }
}

async function toggleFreeze(e, on) {
  if (on) {
    const res = await rpc('freeze', { id: e.freezeId, region: e.region, addr: e.addr, type: e.type, value: e.value });
    if (res.error) { toast('Could not freeze: ' + res.error); return; }
    e.freezeId = res.result.id;
    e.frozen = true;
  } else {
    if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
    e.frozen = false;
    e.freezeId = null;
  }
}

/** Refresh live values for addresses in the list (except frozen entries). */
async function refreshListValues() {
  if (!state.list.length || state.tabId === null) return;
  const items = state.list
    .filter((e) => !e.frozen)
    .map((e) => ({ key: e.key, region: e.region, addr: e.addr, type: e.type }));
  if (!items.length) return;

  const res = await rpc('readMany', { items });
  if (res.error || !res.result) return;

  const focused = document.activeElement;
  for (const row of res.result) {
    if (row.value == null) continue;
    const e = state.list.find((o) => o.key === row.key);
    if (!e) continue;
    e.value = String(row.value);
    const input = document.querySelector(`#listBody input[data-key="${row.key}"]`);
    if (input && input !== focused) input.value = e.value;
  }
}

/* ------------------------------------------------------------------ *
 * Time control
 * ------------------------------------------------------------------ */
const PRESETS = [0.25, 0.5, 1, 2, 4, 8];

function buildPresets() {
  const box = $('presets');
  for (const s of PRESETS) {
    const b = document.createElement('button');
    b.textContent = s + 'x';
    b.dataset.speed = String(s);
    b.addEventListener('click', () => setSpeed(s));
    box.append(b);
  }
}

function applySpeedUI(s) {
  state.speed = s;
  $('speedRange').value = String(Math.round(s * 100));
  $('speedOut').textContent = s.toFixed(2) + 'x';
  for (const b of $('presets').children) {
    b.classList.toggle('on', Number(b.dataset.speed) === s);
  }
  $('pauseBtn').textContent = s === 0 ? 'Resume' : 'Pause';
  $('pauseBtn').classList.toggle('on', s === 0);
  $('stepBtn').disabled = s !== 0;
}

async function setSpeed(s) {
  const res = await rpc('setSpeed', { speed: s });
  if (res.error) { toast('Could not set speed: ' + res.error); return; }
  applySpeedUI(res.result.speed);
}

/**
 * Diagnostics line. Directly explains why speed control may not work:
 * whether the game loop is in this frame, whether it reads the clock, and its FPS.
 */
async function refreshDiag() {
  const el = $('diag');
  if (state.tabId === null || state.frameId === null) { el.textContent = 'no target selected'; return; }

  const res = await rpc('diag');
  if (res.error || !res.result) { el.textContent = 'diagnostics unavailable: ' + (res.error || '?'); return; }
  const d = res.result;

  const lines = [];
  const engines = d.engines.length ? d.engines.join(', ') : 'unknown';
  lines.push(`engine: <b>${engines}</b> · memory regions: <b>${d.regions}</b>`);

  if (d.fps > 0) {
    lines.push(`render loop: <span class="good">${d.fps} fps</span> · clock reads: <b>${d.nowReads.toLocaleString('en-US')}</b>`);
  } else if (d.timers > 0) {
    lines.push(`<span class="warn">no rAF</span> · timer-driven (${d.timers}) · clock reads: <b>${d.nowReads.toLocaleString('en-US')}</b>`);
  } else {
    lines.push('<span class="bad">no game loop is running in this frame</span>');
  }

  if (d.nowReads === 0 && d.dateReads === 0 && d.fps > 0) {
    lines.push('<span class="bad">the game never reads the clock → speed changes have no effect</span>');
  }
  if (d.shared) {
    lines.push('<span class="bad">shared memory (pthread)</span> — the loop may run in a Worker, beyond the reach of time control');
  }
  if (!d.dirty) {
    lines.push('clock: <b>pass-through</b> (speed has not been changed)');
  } else {
    lines.push(`clock: <b>active at ${d.speed}x</b>`);
  }

  el.innerHTML = lines.join('<br>');
}

/* ------------------------------------------------------------------ *
 * Event wiring
 * ------------------------------------------------------------------ */
function wire() {
  $('refreshBtn').addEventListener('click', refreshTargets);
  $('reloadBtn').addEventListener('click', async () => {
    if (state.tabId === null) return;
    const keep = state.tabId;
    await bg({ op: 'reload', tabId: keep });
    setStatus('reloading tab…', 'busy');
    // Let the page load and the agent inject, then refresh automatically.
    setTimeout(async () => {
      state.tabId = keep;
      await refreshTargets();
    }, 1800);
  });

  $('tabSel').addEventListener('change', (e) => selectTab(Number(e.target.value)));
  $('frameSel').addEventListener('change', (e) => selectFrame(Number(e.target.value)));
  $('regionSel').addEventListener('change', (e) => { state.regionId = e.target.value || null; });
  $('cmpSel').addEventListener('change', onCmpChange);

  $('firstBtn').addEventListener('click', () => doScan('firstScan'));
  $('nextBtn').addEventListener('click', () => doScan('nextScan'));
  $('cancelBtn').addEventListener('click', () => rpc('cancelScan'));
  $('newBtn').addEventListener('click', async () => {
    await rpc('reset');
    state.hasResults = false;
    fillCmp(FIRST_CMPS);
    $('resBody').textContent = '';
    $('progBar').style.width = '0';
    $('foundText').textContent = 'No results';
    $('resHint').classList.remove('hidden');
    $('resHint').innerHTML = 'Enter the value exactly as it appears in the game, then click <b>First Scan</b>. ' +
      'Change the value in the game and narrow the results with <b>Next Scan</b>. Double-click a row &rarr; add it to the list.';
    setScanUI(false);
  });

  $('addManualBtn').addEventListener('click', () => {
    const raw = prompt('Address (0x... or decimal):');
    if (!raw) return;
    const addr = raw.trim().toLowerCase().startsWith('0x') ? parseInt(raw.trim(), 16) : parseInt(raw.trim(), 10);
    if (!Number.isFinite(addr) || addr < 0) { toast('Invalid address.'); return; }
    addToList(addr, concreteType(null), '');
  });

  $('clearListBtn').addEventListener('click', async () => {
    for (const e of state.list) if (e.freezeId) await rpc('unfreeze', { id: e.freezeId });
    state.list = [];
    renderList();
  });

  $('speedRange').addEventListener('input', (e) => {
    const s = Number(e.target.value) / 100;
    $('speedOut').textContent = s.toFixed(2) + 'x';
  });
  $('speedRange').addEventListener('change', (e) => setSpeed(Number(e.target.value) / 100));

  $('pauseBtn').addEventListener('click', () => {
    if (state.speed === 0) setSpeed(state.prevSpeed || 1);
    else { state.prevSpeed = state.speed || 1; setSpeed(0); }
  });
  $('stepBtn').addEventListener('click', () => rpc('step', { ms: 1000 / 60 }));
}

/* ------------------------------------------------------------------ *
 * Initialization
 * ------------------------------------------------------------------ */
buildPresets();
fillCmp(FIRST_CMPS);
applySpeedUI(1);
wire();
refreshTargets();

setInterval(() => { if (!state.scanning) refreshListValues(); }, 400);
setInterval(() => { if (!state.scanning) refreshDiag(); }, 1000);
