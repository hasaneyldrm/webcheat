/**
 * WebCheat agent — MAIN world.
 *
 * Runs in the page's own JavaScript realm. It has three jobs:
 *   1. Capture WebAssembly.Memory objects (the game's "RAM").
 *   2. Scan, write, and freeze that memory in Cheat Engine style.
 *   3. Speed up, slow down, or pause the game using a virtual clock.
 *
 * It must load at document_start: WebAssembly hooks need to be installed before
 * the game instantiates. If the extension was installed while the page was
 * already open, the page must be reloaded once.
 */
(function () {
  'use strict';

  if (window.__WCE__) return;

  /* --------------------------------------------------------------------- *
   * Original references — kept separate so our own hooks do not affect them
   * --------------------------------------------------------------------- */
  var O = {
    now: performance.now.bind(performance),
    dateNow: Date.now.bind(Date),
    raf: window.requestAnimationFrame && window.requestAnimationFrame.bind(window),
    caf: window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window)
  };

  /* --------------------------------------------------------------------- *
   * Value types
   * --------------------------------------------------------------------- */
  var TYPES = {
    i8:  { size: 1, arr: Int8Array,    big: false, get: function (d, o) { return d.getInt8(o); },        set: function (d, o, v) { d.setInt8(o, v); } },
    u8:  { size: 1, arr: Uint8Array,   big: false, get: function (d, o) { return d.getUint8(o); },       set: function (d, o, v) { d.setUint8(o, v); } },
    i16: { size: 2, arr: Int16Array,   big: false, get: function (d, o) { return d.getInt16(o, true); }, set: function (d, o, v) { d.setInt16(o, v, true); } },
    u16: { size: 2, arr: Uint16Array,  big: false, get: function (d, o) { return d.getUint16(o, true); },set: function (d, o, v) { d.setUint16(o, v, true); } },
    i32: { size: 4, arr: Int32Array,   big: false, get: function (d, o) { return d.getInt32(o, true); }, set: function (d, o, v) { d.setInt32(o, v, true); } },
    u32: { size: 4, arr: Uint32Array,  big: false, get: function (d, o) { return d.getUint32(o, true); },set: function (d, o, v) { d.setUint32(o, v, true); } },
    f32: { size: 4, arr: Float32Array, big: false, get: function (d, o) { return d.getFloat32(o, true); },set: function (d, o, v) { d.setFloat32(o, v, true); } },
    f64: { size: 8, arr: Float64Array, big: false, get: function (d, o) { return d.getFloat64(o, true); },set: function (d, o, v) { d.setFloat64(o, v, true); } },
    i64: { size: 8, arr: BigInt64Array,  big: true, get: function (d, o) { return d.getBigInt64(o, true); }, set: function (d, o, v) { d.setBigInt64(o, v, true); } },
    u64: { size: 8, arr: BigUint64Array, big: true, get: function (d, o) { return d.getBigUint64(o, true); },set: function (d, o, v) { d.setBigUint64(o, v, true); } }
  };

  function parseValue(type, raw) {
    var t = TYPES[type];
    if (!t) throw new Error('unknown type: ' + type);
    if (t.big) return BigInt(String(raw).trim());
    var n = Number(raw);
    if (!isFinite(n)) throw new Error('invalid number: ' + raw);
    return n;
  }

  // JSON cannot carry BigInt values, so convert them to strings.
  function outValue(v) { return typeof v === 'bigint' ? v.toString() : v; }

  /* --------------------------------------------------------------------- *
   * Regions — scannable memory areas
   * --------------------------------------------------------------------- */
  var regions = [];
  var regionSeq = 0;
  var OrigMemory = window.WebAssembly && window.WebAssembly.Memory;

  function addWasmMemory(mem, label) {
    if (!OrigMemory || !(mem instanceof OrigMemory)) return;
    for (var i = 0; i < regions.length; i++) if (regions[i].memory === mem) return;
    regions.push({
      id: 'wasm:' + (regionSeq++),
      kind: 'wasm',
      label: label || 'WebAssembly.Memory',
      memory: mem,
      buffer: function () { return mem.buffer; }
    });
  }

  function addBufferRegion(buf, label) {
    if (!(buf instanceof ArrayBuffer)) return;
    for (var i = 0; i < regions.length; i++) if (regions[i].kind === 'buffer' && regions[i].buffer() === buf) return;
    regions.push({
      id: 'buf:' + (regionSeq++),
      kind: 'buffer',
      label: label || 'ArrayBuffer',
      memory: null,
      buffer: function () { return buf; }
    });
  }

  function getRegion(id) {
    for (var i = 0; i < regions.length; i++) if (regions[i].id === id) return regions[i];
    throw new Error('region not found: ' + id);
  }

  /* --------------------------------------------------------------------- *
   * WebAssembly hooks
   * --------------------------------------------------------------------- */
  (function hookWasm() {
    var WA = window.WebAssembly;
    if (!WA) return;

    function harvest(result, importObject) {
      try {
        var im = importObject && importObject.env && importObject.env.memory;
        if (im) addWasmMemory(im, 'imports.env.memory');
      } catch (e) { /* the import object may be exotic */ }
      try {
        var inst = result && result.instance ? result.instance : result;
        var ex = inst && inst.exports;
        if (ex) {
          for (var k in ex) {
            try { if (ex[k] instanceof OrigMemory) addWasmMemory(ex[k], 'exports.' + k); } catch (e2) {}
          }
        }
      } catch (e3) {}
    }

    try {
      WA.Memory = new Proxy(OrigMemory, {
        construct: function (target, args) {
          var m = Reflect.construct(target, args);
          addWasmMemory(m, 'new WebAssembly.Memory');
          return m;
        }
      });
    } catch (e) {}

    try {
      var OrigInstance = WA.Instance;
      WA.Instance = new Proxy(OrigInstance, {
        construct: function (target, args) {
          var i = Reflect.construct(target, args);
          harvest(i, args[1]);
          return i;
        }
      });
    } catch (e) {}

    ['instantiate', 'instantiateStreaming'].forEach(function (name) {
      var orig = WA[name];
      if (typeof orig !== 'function') return;
      WA[name] = function () {
        var args = arguments;
        var p = orig.apply(this, args);
        if (p && typeof p.then === 'function') {
          return p.then(function (r) { harvest(r, args[1]); return r; });
        }
        return p;
      };
    });
  })();

  /**
   * Late discovery: capture Emscripten/Unity modules missed by the hooks.
   * (This applies when the extension is installed after the page has loaded.)
   */
  var lastSweep = 0;
  function sweepGlobals() {
    // Scanning globals on every "hello" is expensive: the tab list probes every
    // frame, and pages such as YouTube expose thousands of globals.
    var t0 = O.now();
    if (t0 - lastSweep < 1500) return;
    lastSweep = t0;

    var seen = 0;
    var names;
    try { names = Object.getOwnPropertyNames(window); } catch (e) { return; }
    for (var i = 0; i < names.length && seen < 4000; i++) {
      seen++;
      var v;
      try { v = window[names[i]]; } catch (e) { continue; }
      if (!v || typeof v !== 'object') continue;
      try {
        if (v.wasmMemory instanceof OrigMemory) addWasmMemory(v.wasmMemory, names[i] + '.wasmMemory');
        if (v.HEAPU8 && v.HEAPU8.buffer instanceof ArrayBuffer) addBufferRegion(v.HEAPU8.buffer, names[i] + '.HEAPU8');
        if (v.Module) {
          if (v.Module.wasmMemory instanceof OrigMemory) addWasmMemory(v.Module.wasmMemory, names[i] + '.Module.wasmMemory');
          if (v.Module.HEAPU8 && v.Module.HEAPU8.buffer instanceof ArrayBuffer) addBufferRegion(v.Module.HEAPU8.buffer, names[i] + '.Module.HEAPU8');
        }
      } catch (e) { /* a getter may throw */ }
    }
  }

  function listRegions() {
    sweepGlobals();
    return regions.map(function (r) {
      var size = 0, shared = false;
      try {
        var b = r.buffer();
        size = b.byteLength;
        shared = typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer;
      } catch (e) {}
      return { id: r.id, kind: r.kind, label: r.label, size: size, shared: shared };
    });
  }

  /** Detect the game engine on the page for diagnostics. */
  function detectEngine() {
    var hits = [];
    var probes = [
      ['Unity', 'unityInstance'], ['Unity', 'UnityLoader'], ['Unity', 'createUnityInstance'],
      ['Emscripten', 'Module'], ['Godot', 'Godot'], ['Godot', 'Engine'],
      ['Cocos', 'cc'], ['Phaser', 'Phaser'], ['PixiJS', 'PIXI'],
      ['Construct', 'C3'], ['Three.js', 'THREE'], ['PlayCanvas', 'pc']
    ];
    for (var i = 0; i < probes.length; i++) {
      try { if (window[probes[i][1]] != null && hits.indexOf(probes[i][0]) < 0) hits.push(probes[i][0]); } catch (e) {}
    }
    return hits;
  }

  /* --------------------------------------------------------------------- *
   * Scan engine
   * --------------------------------------------------------------------- */
  var MAX_RESULTS = 4000000;   // ~16 MB offset table
  var SLICE = 4000000;         // slots processed per tick

  var scan = null;   // active scan state
  var job = null;    // running scan job

  /**
   * Types tried by an "All" scan, matching CE's "All" value type.
   * u8/u16/u32 are intentionally omitted: i8/i16/i32 already match the same bit
   * patterns; only signedness interpretation changes. Doubling the lanes is not worth it.
   */
  var MULTI_TYPES = ['i8', 'i16', 'i32', 'i64', 'f32', 'f64'];

  var INT_RANGE = {
    i8: [-128, 127], u8: [0, 255],
    i16: [-32768, 32767], u16: [0, 65535],
    i32: [-2147483648, 2147483647], u32: [0, 4294967295]
  };

  /** Whether a value can be represented by this type, used to prune empty lanes in "All" mode. */
  function fitsType(typeName, raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (s === '') return false;
    if (typeName === 'f32' || typeName === 'f64') return isFinite(Number(s));
    if (!/^-?\d+$/.test(s)) return false;           // decimal values do not fit integer types
    var t = TYPES[typeName];
    if (t.big) {
      try {
        var bv = BigInt(s);
        return typeName === 'u64'
          ? (bv >= BigInt(0) && bv < (BigInt(1) << BigInt(64)))
          : (bv >= -(BigInt(1) << BigInt(63)) && bv < (BigInt(1) << BigInt(63)));
      } catch (e) { return false; }
    }
    var r = INT_RANGE[typeName];
    var n = Number(s);
    return !r || (n >= r[0] && n <= r[1]);
  }

  /**
   * Scan state. Results are split into lanes: the results for lane i occupy
   * offs[laneEnd[i-1] .. laneEnd[i]) and use types[i]. Single-type scans have
   * one lane; "All" scans have one lane per type.
   */
  function freshScan(regionId, types, aligned, multi) {
    return {
      region: regionId,
      types: types,        // lane type names
      multi: !!multi,
      aligned: aligned !== false,
      mode: 'none',        // 'none' | 'all' | 'list'
      offs: null,          // Uint32Array — matching byte offsets
      laneEnd: [],         // end index of each lane in offs
      count: 0,
      prevNum: null,       // Float64Array — previous values
      prevBig: null,       // full precision for a single-type 64-bit scan
      snap: null,          // full memory copy in 'all' mode
      truncated: false
    };
  }

  function typeAt(i) {
    for (var L = 0; L < scan.laneEnd.length; L++) if (i < scan.laneEnd[L]) return scan.types[L];
    return scan.types[scan.types.length - 1];
  }

  function prevAt(i) {
    if (scan.prevBig) return scan.prevBig[i];
    return scan.prevNum ? scan.prevNum[i] : undefined;
  }

  /** BigInt and Number cannot be compared directly; coerce to Number in mixed lanes. */
  function cmpVal(v) { return typeof v === 'bigint' ? Number(v) : v; }

  function storePrev(values, n) {
    var src = values.slice(0, n);
    var single = scan.types.length === 1 ? TYPES[scan.types[0]] : null;
    if (single && single.big) {
      scan.prevBig = scan.types[0] === 'u64' ? BigUint64Array.from(src) : BigInt64Array.from(src);
      scan.prevNum = null;
    } else {
      scan.prevBig = null;
      scan.prevNum = Float64Array.from(src.map(Number));
    }
  }

  // Growable Uint32Array
  function Grow() {
    this.buf = new Uint32Array(1 << 16);
    this.n = 0;
  }
  Grow.prototype.push = function (v) {
    if (this.n === this.buf.length) {
      if (this.n >= MAX_RESULTS) return false;
      var next = new Uint32Array(Math.min(this.buf.length * 2, MAX_RESULTS));
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.n++] = v;
    return true;
  };
  Grow.prototype.done = function () { return this.buf.subarray(0, this.n); };

  function yieldTick() {
    return new Promise(function (res) { O.setTimeout(res, 0); });
  }

  function makePredicate(op, a, b) {
    switch (op) {
      case 'eq':        return function (c) { return c === a; };
      case 'ne':        return function (c) { return c !== a; };
      case 'gt':        return function (c) { return c > a; };
      case 'lt':        return function (c) { return c < a; };
      case 'gte':       return function (c) { return c >= a; };
      case 'lte':       return function (c) { return c <= a; };
      case 'between':   return function (c) { return c >= a && c <= b; };
      case 'changed':   return function (c, p) { return c !== p; };
      case 'unchanged': return function (c, p) { return c === p; };
      case 'inc':       return function (c, p) { return c > p; };
      case 'dec':       return function (c, p) { return c < p; };
      case 'incBy':     return function (c, p) { return c - p === a; };
      case 'decBy':     return function (c, p) { return p - c === a; };
      default: throw new Error('unknown comparison: ' + op);
    }
  }

  var NEEDS_PREV = { changed: 1, unchanged: 1, inc: 1, dec: 1, incBy: 1, decBy: 1 };

  function startJob(total) {
    job = { total: total, done: 0, found: 0, running: true, error: null, cancel: false };
    return job;
  }

  function slotCount(byteLen, typeName, aligned) {
    var t = TYPES[typeName];
    var step = aligned ? t.size : 1;
    return Math.max(0, Math.floor((byteLen - t.size) / step) + 1);
  }

  /** First scan. If type='all', each type is scanned in a separate lane. */
  async function firstScan(opts) {
    var region = getRegion(opts.region);
    var aligned = opts.aligned !== false;
    var multi = opts.type === 'all';
    var types = multi ? MULTI_TYPES.slice() : [opts.type];
    for (var ti = 0; ti < types.length; ti++) {
      if (!TYPES[types[ti]]) throw new Error('unknown type: ' + types[ti]);
    }

    scan = freshScan(opts.region, types, aligned, multi);
    var byteLen = region.buffer().byteLength;

    // --- Unknown value: take a full snapshot instead of storing an address list ---
    if (opts.cmp === 'unknown') {
      var j0 = startJob(byteLen);
      var snap = new Uint8Array(byteLen);
      var CH = 8 << 20;
      for (var off = 0; off < byteLen; off += CH) {
        if (j0.cancel) { j0.running = false; return; }
        // If WASM memory grows during a scan, the old ArrayBuffer is detached.
        // Fail explicitly rather than silently capturing a partial snapshot.
        var live = region.buffer();
        if (live.byteLength < byteLen) throw new Error('memory was resized during the scan — scan again');
        var end0 = Math.min(off + CH, byteLen);
        snap.set(new Uint8Array(live, off, end0 - off), off);
        j0.done = end0;
        await yieldTick();
      }
      scan.mode = 'all';
      scan.snap = snap;
      scan.count = types.reduce(function (s, tn) { return s + slotCount(byteLen, tn, aligned); }, 0);
      j0.found = scan.count;
      j0.running = false;
      return;
    }

    // --- First scan with a value ---
    var cmp = opts.cmp || 'eq';
    // Drop types that cannot represent the value: if the user entered 300,
    // scanning i8 is pointless; for 57.5, integer types are pointless.
    var lanes = types.filter(function (tn) {
      if (!fitsType(tn, opts.value)) return false;
      if (cmp === 'between' && !fitsType(tn, opts.value2)) return false;
      return true;
    });
    if (!lanes.length) throw new Error('"' + opts.value + '" cannot be represented by the selected type(s)');
    scan.types = lanes;

    var totalSlots = lanes.reduce(function (s, tn) { return s + slotCount(byteLen, tn, aligned); }, 0);
    var j = startJob(totalSlots);
    var out = new Grow();
    var prev = [];
    var base = 0;

    for (var li = 0; li < lanes.length; li++) {
      if (j.cancel || scan.truncated) { scan.laneEnd.push(out.n); continue; }

      var tn = lanes[li];
      var t = TYPES[tn];
      var a = parseValue(tn, opts.value);
      var b = cmp === 'between' ? parseValue(tn, opts.value2) : null;
      var pred = makePredicate(cmp, a, b);
      var slots = slotCount(byteLen, tn, aligned);

      if (aligned) {
        // Fast path: iterate directly over the typed array.
        var i = 0;
        while (i < slots) {
          if (j.cancel) break;
          var view = new t.arr(region.buffer());
          var end2 = Math.min(i + SLICE, Math.min(slots, view.length));
          for (; i < end2; i++) {
            if (pred(view[i])) {
              if (!out.push(i * t.size)) { scan.truncated = true; break; }
              prev.push(view[i]);
            }
          }
          j.done = base + i;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
      } else {
        // Unaligned path: use DataView byte by byte.
        var k = 0;
        while (k < slots) {
          if (j.cancel) break;
          var dv = new DataView(region.buffer());
          var end3 = Math.min(k + SLICE, slots);
          for (; k < end3; k++) {
            var v2 = t.get(dv, k);
            if (pred(v2)) {
              if (!out.push(k)) { scan.truncated = true; break; }
              prev.push(v2);
            }
          }
          j.done = base + k;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
      }

      scan.laneEnd.push(out.n);
      base += slots;
    }

    scan.mode = 'list';
    scan.offs = out.done();
    scan.count = out.n;
    storePrev(prev, out.n);
    j.done = j.total;
    j.found = scan.count;
    j.running = false;
  }

  /** Next scan — narrows the current result set while preserving lane structure. */
  async function nextScan(opts) {
    if (!scan || scan.mode === 'none') throw new Error('run a first scan before narrowing');
    var region = getRegion(scan.region);
    var cmp = opts.cmp || 'eq';
    var usesPrev = !!NEEDS_PREV[cmp];
    var wantsValue = !usesPrev || cmp === 'incBy' || cmp === 'decBy';
    var hasValue = opts.value != null && opts.value !== '';
    if (wantsValue && !hasValue) throw new Error('this comparison requires a value');

    var lanes = scan.types;
    var out = new Grow();
    var prev = [];
    var laneEnd = [];
    var exactPrev = !!scan.prevBig;   // single-type 64-bit: BigInt comparison

    /** Skip a lane entirely if it cannot represent this value. */
    function laneUsable(tn) {
      if (!hasValue) return true;
      if (!wantsValue) return true;
      if (!fitsType(tn, opts.value)) return false;
      if (cmp === 'between' && !fitsType(tn, opts.value2)) return false;
      return true;
    }

    function laneCmp(tn) {
      var a = hasValue && wantsValue ? parseValue(tn, opts.value) : null;
      var b = cmp === 'between' && opts.value2 ? parseValue(tn, opts.value2) : null;
      return makePredicate(cmp, a, b);
    }

    if (scan.mode === 'all') {
      // Full scan against the snapshot; the result becomes a sparse list.
      var byteLen = region.buffer().byteLength;
      var snapView = new DataView(scan.snap.buffer);
      var totalSlots = lanes.reduce(function (s, tn) { return s + slotCount(byteLen, tn, scan.aligned); }, 0);
      var j = startJob(totalSlots);
      var base = 0;

      for (var li = 0; li < lanes.length; li++) {
        var tn = lanes[li];
        var t = TYPES[tn];
        var slots = slotCount(byteLen, tn, scan.aligned);

        if (j.cancel || scan.truncated || !laneUsable(tn)) {
          laneEnd.push(out.n);
          base += slots;
          continue;
        }

        var pred = laneCmp(tn);
        var step = scan.aligned ? t.size : 1;
        var i = 0;
        while (i < slots) {
          if (j.cancel) break;
          var dv = new DataView(region.buffer());
          var end = Math.min(i + SLICE, slots);
          for (; i < end; i++) {
            var off = i * step;
            if (off + t.size > scan.snap.length || off + t.size > dv.byteLength) continue;
            var cur = t.get(dv, off);
            var old = t.get(snapView, off);
            if (pred(cur, old)) {
              if (!out.push(off)) { scan.truncated = true; break; }
              prev.push(cur);
            }
          }
          j.done = base + i;
          j.found = out.n;
          if (scan.truncated) break;
          await yieldTick();
        }
        laneEnd.push(out.n);
        base += slots;
      }

      scan.snap = null; // no longer needed; release the memory
      j.done = j.total;
      j.found = out.n;
      j.running = false;
    } else {
      // List mode — check only existing addresses using each lane's own type.
      var j2 = startJob(scan.count);
      var start = 0;

      for (var li2 = 0; li2 < lanes.length; li2++) {
        var tn2 = lanes[li2];
        var t2 = TYPES[tn2];
        var laneStop = scan.laneEnd[li2] != null ? scan.laneEnd[li2] : scan.count;

        if (j2.cancel || !laneUsable(tn2)) {
          j2.done = laneStop;
          laneEnd.push(out.n);
          start = laneStop;
          continue;
        }

        var pred2 = laneCmp(tn2);
        var n = start;
        while (n < laneStop) {
          if (j2.cancel) break;
          var dv2 = new DataView(region.buffer());
          var lim = dv2.byteLength;
          var end2 = Math.min(n + SLICE, laneStop);
          for (; n < end2; n++) {
            var off2 = scan.offs[n];
            if (off2 + t2.size > lim) continue;
            var cur2 = t2.get(dv2, off2);
            var p = usesPrev ? prevAt(n) : undefined;
            // If previous values are numeric, coerce the BigInt side to Number too.
            var c2 = exactPrev ? cur2 : cmpVal(cur2);
            if (pred2(c2, p)) {
              out.push(off2);
              prev.push(cur2);
            }
          }
          j2.done = n;
          j2.found = out.n;
          await yieldTick();
        }
        laneEnd.push(out.n);
        start = laneStop;
      }

      j2.done = j2.total;
      j2.found = out.n;
      j2.running = false;
    }

    scan.mode = 'list';
    scan.offs = out.done();
    scan.laneEnd = laneEnd;
    scan.count = out.n;
    storePrev(prev, out.n);
  }

  /** Result count per lane, used for the per-type summary. */
  function laneCounts() {
    var out = {};
    var start = 0;
    for (var i = 0; i < scan.types.length; i++) {
      var stop = scan.laneEnd[i] != null ? scan.laneEnd[i] : start;
      if (stop > start) out[scan.types[i]] = stop - start;
      start = stop;
    }
    return out;
  }

  function scanResults(offset, limit) {
    if (!scan || scan.mode !== 'list') {
      return {
        total: scan ? scan.count : 0, rows: [], mode: scan ? scan.mode : 'none',
        multi: scan ? scan.multi : false, byType: {}
      };
    }
    var region = getRegion(scan.region);
    var dv = new DataView(region.buffer());
    var rows = [];
    var end = Math.min(offset + limit, scan.count);
    for (var i = offset; i < end; i++) {
      var tn = typeAt(i);
      var t = TYPES[tn];
      var off = scan.offs[i];
      var cur = null;
      try { if (off + t.size <= dv.byteLength) cur = t.get(dv, off); } catch (e) {}
      rows.push({
        addr: off,
        type: tn,
        value: outValue(cur),
        prev: outValue(prevAt(i))
      });
    }
    return {
      total: scan.count, rows: rows, mode: scan.mode, truncated: scan.truncated,
      multi: scan.multi, types: scan.types, byType: laneCounts(), region: scan.region
    };
  }

  /* --------------------------------------------------------------------- *
   * Read / write / freeze
   * --------------------------------------------------------------------- */
  function readAddr(regionId, addr, type) {
    var region = getRegion(regionId);
    var t = TYPES[type];
    var dv = new DataView(region.buffer());
    if (addr < 0 || addr + t.size > dv.byteLength) return null;
    return t.get(dv, addr);
  }

  function writeAddr(regionId, addr, type, value) {
    var region = getRegion(regionId);
    var t = TYPES[type];
    var dv = new DataView(region.buffer());
    if (addr < 0 || addr + t.size > dv.byteLength) throw new Error('address is outside memory');
    t.set(dv, addr, parseValue(type, value));
    return true;
  }

  // Frozen addresses
  var frozen = Object.create(null);
  var freezeSeq = 0;
  var freezeTimer = null;

  function freezeTick() {
    for (var k in frozen) {
      var f = frozen[k];
      try { writeAddr(f.region, f.addr, f.type, f.value); } catch (e) { /* memory may have grown or shrunk */ }
    }
  }

  function setFreeze(entry) {
    var id = entry.id || ('f' + (freezeSeq++));
    frozen[id] = { id: id, region: entry.region, addr: entry.addr, type: entry.type, value: entry.value };
    if (!freezeTimer) freezeTimer = O.setInterval(freezeTick, 16);
    return id;
  }

  function clearFreeze(id) {
    delete frozen[id];
    var any = false;
    for (var k in frozen) { any = true; break; }
    if (!any && freezeTimer) { O.clearInterval(freezeTimer); freezeTimer = null; }
    return true;
  }

  /* --------------------------------------------------------------------- *
   * Virtual clock — speed up / slow down / pause
   * --------------------------------------------------------------------- *
   * Games calculate delta time from performance.now() or rAF timestamps.
   * Advancing the virtual clock faster speeds up the simulation. The code still
   * sees one frame per frame, so physics stays intact and only dt increases.
   */
  var Clock = {
    speed: 1,
    // The extension is injected into <all_urls>. Until speed is changed, the
    // clock remains a complete pass-through and normal browsing is unaffected.
    dirty: false,
    _rBase: O.now(),
    _vBase: O.now(),
    _dBase: O.dateNow(),
    _at: function (real) { return this._vBase + (real - this._rBase) * this.speed; },
    now: function () { return this.dirty ? this._at(O.now()) : O.now(); },
    dateNow: function () {
      return this.dirty ? this._dBase + (O.now() - this._rBase) * this.speed : O.dateNow();
    },
    setSpeed: function (s) {
      var real = O.now();
      // On the first adjustment, start virtual time from the current real time.
      var v = this.dirty ? this._at(real) : real;
      var d = this.dirty ? this._dBase + (real - this._rBase) * this.speed : O.dateNow();
      this._vBase = v;
      this._dBase = d;
      this._rBase = real;
      this.speed = Math.max(0, Number(s) || 0);
      if (this.speed !== 1) this.dirty = true;
    },
    step: function (ms) {
      if (!this.dirty) return;
      this._vBase += ms;
      this._dBase += ms;
    }
  };

  /**
   * Diagnostic counters. These explain why speed control may not work:
   * whether the game loop is in this frame, which clock it reads, and its FPS.
   */
  var stats = { now: 0, dateNow: 0, raf: 0, timeout: 0, interval: 0, rafWindow: [] };

  (function hookClock() {
    try {
      Object.defineProperty(performance, 'now', {
        configurable: true, writable: true,
        value: function now() { stats.now++; return Clock.now(); }
      });
    } catch (e) {}

    try {
      Date.now = function now() { stats.dateNow++; return Math.floor(Clock.dateNow()); };
    } catch (e) {}

    if (O.raf) {
      window.requestAnimationFrame = function (cb) {
        return O.raf(function (ts) {
          stats.raf++;
          var real = O.now();
          stats.rafWindow.push(real);
          while (stats.rafWindow.length && real - stats.rafWindow[0] > 1000) stats.rafWindow.shift();
          cb(Clock.dirty ? Clock.now() : ts);
        });
      };
    }

    // Scale timers by speed: at 2x, 1000 ms becomes 500 ms.
    function scale(delay) {
      var d = Number(delay) || 0;
      if (!Clock.dirty || Clock.speed <= 0) return d;
      return d / Clock.speed;
    }
    window.setTimeout = function (fn, delay) {
      stats.timeout++;
      var rest = Array.prototype.slice.call(arguments, 2);
      return O.setTimeout.apply(window, [fn, scale(delay)].concat(rest));
    };
    window.setInterval = function (fn, delay) {
      stats.interval++;
      var rest = Array.prototype.slice.call(arguments, 2);
      return O.setInterval.apply(window, [fn, scale(delay)].concat(rest));
    };
  })();

  /* --------------------------------------------------------------------- *
   * RPC
   * --------------------------------------------------------------------- */
  /**
   * Starts scanning in the background; errors are returned through progress().
   *
   * The .catch block used to contain "if (job)." If a first scan failed before
   * a job existed (for example, the value could not fit the type), the error
   * disappeared and the panel showed empty results forever. A job is now
   * created with the call, so every error has somewhere to go.
   */
  function launch(fn, args) {
    if (job && job.running) throw new Error('a scan is already running');
    job = { total: 0, done: 0, found: 0, running: true, error: null, cancel: false };
    Promise.resolve()
      .then(function () { return fn(args); })
      .catch(function (e) {
        if (!job) job = { total: 0, done: 0, found: 0, running: false, error: null, cancel: false };
        job.error = String(e && e.message || e);
        job.running = false;
      });
    return { started: true };
  }

  var HANDLERS = {
    hello: function () {
      return {
        ok: true,
        url: location.href,
        title: document.title || '',
        top: window.top === window,
        regions: listRegions(),
        speed: Clock.speed
      };
    },
    regions: function () { return listRegions(); },

    firstScan: function (a) { return launch(firstScan, a); },
    nextScan: function (a) { return launch(nextScan, a); },
    cancelScan: function () { if (job) job.cancel = true; return { ok: true }; },
    progress: function () {
      return job
        ? { running: job.running, done: job.done, total: job.total, found: job.found, error: job.error }
        : { running: false, done: 0, total: 0, found: 0, error: null };
    },
    reset: function () { scan = null; job = null; return { ok: true }; },
    results: function (a) { return scanResults(a.offset || 0, Math.min(a.limit || 200, 1000)); },

    read: function (a) { return { value: outValue(readAddr(a.region, a.addr, a.type)) }; },
    readMany: function (a) {
      return (a.items || []).map(function (it) {
        var v = null;
        try { v = readAddr(it.region, it.addr, it.type); } catch (e) {}
        return { key: it.key, value: outValue(v) };
      });
    },
    write: function (a) { return { ok: writeAddr(a.region, a.addr, a.type, a.value) }; },

    freeze: function (a) { return { id: setFreeze(a) }; },
    unfreeze: function (a) { return { ok: clearFreeze(a.id) }; },

    setSpeed: function (a) { Clock.setSpeed(a.speed); return { speed: Clock.speed }; },
    step: function (a) { Clock.step(Number(a.ms) || 16.6667); return { ok: true }; },
    clock: function () { return { speed: Clock.speed, now: Clock.now() }; },

    diag: function () {
      var regs = listRegions();
      return {
        speed: Clock.speed,
        dirty: Clock.dirty,
        fps: stats.rafWindow.length,
        raf: stats.raf,
        nowReads: stats.now,
        dateReads: stats.dateNow,
        timers: stats.timeout + stats.interval,
        engines: detectEngine(),
        regions: regs.length,
        shared: regs.some(function (r) { return r.shared; }),
        crossOriginIsolated: !!window.crossOriginIsolated,
        workers: typeof Worker !== 'undefined'
      };
    }
  };

  function rpc(payloadJson) {
    var req;
    try { req = JSON.parse(payloadJson); } catch (e) { return { error: 'invalid request' }; }
    var h = HANDLERS[req.cmd];
    if (!h) return { error: 'unknown command: ' + req.cmd };
    try {
      return { result: h(req.args || {}) };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  }

  window.__WCE__ = { rpc: rpc, version: 1 };

  /* --------------------------------------------------------------------- *
   * Bridge to the ISOLATED world
   * --------------------------------------------------------------------- */
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__wce !== 'req') return;
    var res = rpc(d.payload);
    window.postMessage({ __wce: 'res', id: d.id, response: res }, '*');
  });
})();
