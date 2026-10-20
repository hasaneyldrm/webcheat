/**
 * agent.js'i sahte bir DOM/oyun ortaminda kosturur.
 * Amac: tarama motoru gercekten dogru adresi buluyor mu?
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/agent/agent.js'), 'utf8');

// --- sahte sayfa ortami ---
const listeners = [];
const win = {
  WebAssembly,
  performance: { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 },
  Date,
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 16),
  cancelAnimationFrame: clearTimeout,
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { href: 'https://test.local/game' },
  addEventListener: (t, f) => listeners.push(f),
  postMessage: () => {},
  ArrayBuffer, Uint8Array, DataView, Proxy, Reflect, Promise, Object, Math, JSON, Error, BigInt,
  Int8Array, Uint16Array, Int16Array, Int32Array, Uint32Array, Float32Array, Float64Array,
  BigInt64Array, BigUint64Array, isFinite, Number, String, Array, console
};
win.window = win;
win.self = win;
win.top = win;
win.globalThis = win;
win.document = { title: 'Test Game' };

const ctx = vm.createContext(win);
vm.runInContext(src, ctx);

const A = win.__WCE__;
const call = (cmd, args = {}) => {
  const r = A.rpc(JSON.stringify({ cmd, args }));
  if (r.error) throw new Error(cmd + ': ' + r.error);
  return r.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitScan() {
  for (let i = 0; i < 400; i++) {
    const p = call('progress');
    if (p.error) throw new Error('tarama hatasi: ' + p.error);
    if (!p.running) return p;
    await sleep(10);
  }
  throw new Error('tarama bitmedi');
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};

// --- oyunun "RAM"i: 4 MB WASM bellegi ---
const mem = new win.WebAssembly.Memory({ initial: 64 }); // 64 * 64KB = 4MB
const heap = () => new DataView(mem.buffer);

// Rastgele gurultu + bilinen bir "coin" degiskeni
const noise = new Uint32Array(mem.buffer);
let seed = 12345;
for (let i = 0; i < noise.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; noise[i] = seed % 300; }

const COIN_ADDR = 0x2ABC0;      // hizali (4'un kati)
const HP_ADDR   = 0x11150;
heap().setInt32(COIN_ADDR, 100, true);
heap().setFloat32(HP_ADDR, 57.5, true);

console.log('\n== bolge kesfi ==');
const regions = call('regions');
ok('WASM bellegi yakalandi', regions.length >= 1, JSON.stringify(regions));
const REG = regions[0].id;
ok('boyut 4MB', regions[0].size === 4 * 1024 * 1024, String(regions[0].size));

console.log('\n== i32 tam deger taramasi + daraltma ==');
call('firstScan', { region: REG, type: 'i32', cmp: 'eq', value: '100', aligned: true });
let p = await waitScan();
console.log(`  ilk tarama: ${p.found} aday`);
ok('coin adayi bulundu', p.found > 0);

// oyunda coin 100 -> 250 oldu
heap().setInt32(COIN_ADDR, 250, true);
call('nextScan', { cmp: 'eq', value: '250' });
p = await waitScan();
let res = call('results', { offset: 0, limit: 50 });
ok('daraltma sonrasi tek adres kaldi', res.total === 1, `total=${res.total}`);
ok('adres dogru', res.rows[0] && res.rows[0].addr === COIN_ADDR,
   res.rows[0] ? '0x' + res.rows[0].addr.toString(16) : 'yok');
ok('deger dogru okundu', res.rows[0] && res.rows[0].value === 250);

console.log('\n== yazma ==');
call('write', { region: REG, addr: COIN_ADDR, type: 'i32', value: '999999' });
ok('bellege yazildi', heap().getInt32(COIN_ADDR, true) === 999999, String(heap().getInt32(COIN_ADDR, true)));

console.log('\n== dondurma ==');
const fz = call('freeze', { region: REG, addr: COIN_ADDR, type: 'i32', value: '777' });
await sleep(60);
heap().setInt32(COIN_ADDR, 5, true);   // oyun degeri dusurdu
await sleep(80);
ok('dondurulan deger geri yazildi', heap().getInt32(COIN_ADDR, true) === 777, String(heap().getInt32(COIN_ADDR, true)));
call('unfreeze', { id: fz.id });
await sleep(60);
heap().setInt32(COIN_ADDR, 5, true);
await sleep(80);
ok('cozulunce artik yazilmiyor', heap().getInt32(COIN_ADDR, true) === 5, String(heap().getInt32(COIN_ADDR, true)));

console.log('\n== float taramasi ==');
call('reset');
call('firstScan', { region: REG, type: 'f32', cmp: 'eq', value: '57.5', aligned: true });
p = await waitScan();
res = call('results', { offset: 0, limit: 50 });
ok('f32 degeri bulundu', res.rows.some((r) => r.addr === HP_ADDR), `total=${res.total}`);

console.log('\n== bilinmeyen deger akisi (snapshot -> azaldi) ==');
call('reset');
const SECRET = 0x30000;
heap().setInt32(SECRET, 1234, true);
call('firstScan', { region: REG, type: 'i32', cmp: 'unknown', aligned: true });
p = await waitScan();
ok('snapshot alindi', p.found === 1024 * 1024, String(p.found));

heap().setInt32(SECRET, 1200, true);   // sadece bu adres azaldi
call('nextScan', { cmp: 'dec' });
p = await waitScan();
res = call('results', { offset: 0, limit: 50 });
ok('azalan tek adres yakalandi', res.total === 1 && res.rows[0].addr === SECRET,
   `total=${res.total} addr=${res.rows[0] ? '0x' + res.rows[0].addr.toString(16) : '-'}`);

console.log('\n== degismedi filtresi ==');
call('reset');
call('firstScan', { region: REG, type: 'i32', cmp: 'eq', value: '1200', aligned: true });
await waitScan();
const beforeCount = call('results', { offset: 0, limit: 1 }).total;
call('nextScan', { cmp: 'unchanged' });
await waitScan();
ok('unchanged sayiyi korudu', call('results', { offset: 0, limit: 1 }).total === beforeCount);

console.log('\n== zaman kontrolu ==');
const realBefore = win.performance.now();
ok('varsayilan pass-through', Math.abs(call('clock').now - realBefore) < 50);
call('setSpeed', { speed: 4 });
const t0 = call('clock').now;
await sleep(100);
const t1 = call('clock').now;
const elapsed = t1 - t0;
ok('4x hizda sanal saat ~4 kat akti', elapsed > 250 && elapsed < 600, elapsed.toFixed(1) + 'ms');
call('setSpeed', { speed: 0 });
const p0 = call('clock').now;
await sleep(80);
ok('duraklatinca saat durdu', Math.abs(call('clock').now - p0) < 1);
call('step', { ms: 16.67 });
ok('kare ilerletme saati 16.67ms itti', Math.abs(call('clock').now - p0 - 16.67) < 1);

console.log('\n== "hepsi" (tum tipler) taramasi ==');
call('reset');
const I32_ADDR = 0x40000, F32_ADDR = 0x40100, F64_ADDR = 0x40200;
heap().setInt32(I32_ADDR, 4242, true);
heap().setFloat32(F32_ADDR, 4242, true);
heap().setFloat64(F64_ADDR, 4242, true);

call('firstScan', { region: REG, type: 'all', cmp: 'eq', value: '4242', aligned: true });
p = await waitScan();
res = call('results', { offset: 0, limit: 1000 });
ok('multi bayragi set', res.multi === true);
const found = (addr) => res.rows.some((r) => r.addr === addr);
ok('i32 kopyasi bulundu', found(I32_ADDR), JSON.stringify(res.byType));
ok('f32 kopyasi bulundu', found(F32_ADDR));
ok('f64 kopyasi bulundu', found(F64_ADDR));
// Ayni adres birden fazla lane'de cikabilir — i32 4242'nin alt 2 bayti
// i16 olarak da 4242 eder. CE de aynen boyle davranir.
const hasRow = (addr, type) => res.rows.some((r) => r.addr === addr && r.type === type);
ok('satirlar kendi tipini tasiyor',
   hasRow(I32_ADDR, 'i32') && hasRow(F32_ADDR, 'f32') && hasRow(F64_ADDR, 'f64'),
   JSON.stringify(res.rows.filter((r) => r.addr === I32_ADDR)));
ok('i8 lane\'i elendi (4242 sigmaz)', !res.byType.i8, JSON.stringify(res.byType));
ok('i16 lane\'i tarandi (4242 sigar)', res.byType.i16 > 0, JSON.stringify(res.byType));

// hepsi modunda daraltma: her satir kendi tipiyle yeniden okunmali
heap().setInt32(I32_ADDR, 5000, true);
heap().setFloat32(F32_ADDR, 5000, true);
heap().setFloat64(F64_ADDR, 5000, true);
call('nextScan', { cmp: 'eq', value: '5000' });
await waitScan();
res = call('results', { offset: 0, limit: 1000 });
ok('daraltma uc tipi de korudu', found(I32_ADDR) && found(F32_ADDR) && found(F64_ADDR),
   `total=${res.total} ${JSON.stringify(res.byType)}`);

console.log('\n== ondalik deger sadece float lane\'lerine gider ==');
call('reset');
heap().setFloat32(0x41000, 12.5, true);
call('firstScan', { region: REG, type: 'all', cmp: 'eq', value: '12.5', aligned: true });
await waitScan();
res = call('results', { offset: 0, limit: 500 });
ok('f32 bulundu', res.rows.some((r) => r.addr === 0x41000 && r.type === 'f32'));
ok('tam sayi lane\'i hic taranmadi',
   !res.byType.i8 && !res.byType.i16 && !res.byType.i32 && !res.byType.i64,
   JSON.stringify(res.byType));

console.log('\n== temsil edilemeyen deger sessizce yutulmaz ==');
// Tarama fire-and-forget: hata progress() uzerinden gelmeli, kaybolmamali
call('reset');
call('firstScan', { region: REG, type: 'i8', cmp: 'eq', value: '99999' });
await sleep(30);
const prog = A.rpc(JSON.stringify({ cmd: 'progress', args: {} })).result;
ok('i8\'e sigmayan deger hata olarak bildirildi',
   !prog.running && /cannot be represented/.test(prog.error || ''), prog.error || '(hata yok)');

console.log('\n== teshis ==');
call('setSpeed', { speed: 1 });
const d = call('diag');
ok('diag patlamadan dondu', typeof d === 'object' && d !== null);
ok('bellek sayisi raporlaniyor', d.regions >= 1, String(d.regions));
ok('saat okumalari sayiliyor', d.nowReads > 0, String(d.nowReads));
ok('paylasimli bellek dogru raporlandi', d.shared === false);
ok('rAF olmayan ortamda fps 0', d.fps === 0, String(d.fps));

console.log(`\n${fail === 0 ? 'TUM TESTLER GECTI' : 'BASARISIZ'} — ${pass} gecti, ${fail} kaldi\n`);
process.exit(fail ? 1 : 0);
