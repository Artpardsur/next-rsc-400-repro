#!/usr/bin/env node
// rsc-probe.mjs — воспроизводимый замер обработки битого Next-Router-State-Tree.
// Назначение: отличить InfoLeak / крэш / утечку от безобидного "500 вместо 400".
// Только для авторизованного тестирования своих/разрешённых целей.
//
// Что меряет на КАЖДОЙ цели (--target name=url, можно несколько):
//   1. baseline      — обычный GET (эталон, ждём 200)
//   2. baseline+RSC  — GET с заголовком RSC:1, без state-tree
//   3. malformed[*]  — GET c RSC:1 и битым Next-Router-State-Tree (несколько вариантов)
//      для каждого: код ответа, размер тела, content-type, есть ли признаки стека
//   4. load          — N запросов с битым заголовком, параллельно C штук:
//      распределение кодов, задержки (min/avg/max/p95), дрейф задержки (первая
//      десятина vs последняя — намёк на деградацию), обрывы соединений (крэш).
//
// Память сервера по HTTP не видна. Для локального next-процесса добавь
//   --watch-pid <pid>  — скрипт сам снимет Working Set до и после нагрузки
//   (Windows: tasklist, *nix: ps). На удалённом проде память смотри на сервере.
//
// Запуск (примеры):
//   node rsc-probe.mjs --target dev=http://localhost:3000/
//   node rsc-probe.mjs --target prod=http://localhost:3000/ --requests 500 --concurrency 20
//   node rsc-probe.mjs \
//     --target dev=http://localhost:3000/ \
//     --target prod=https://example.com/ \
//     --requests 400 --concurrency 16 --watch-pid 12345

import { spawnSync } from 'node:child_process';

// ---------- разбор аргументов ----------
const argv = process.argv.slice(2);
const opts = { targets: [], requests: 300, concurrency: 12, timeout: 10000, watchPid: null, insecure: false, path: null, follow: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--target') { const [name, ...rest] = argv[++i].split('='); opts.targets.push({ name, url: rest.join('=') }); }
  else if (a === '--requests') opts.requests = parseInt(argv[++i], 10);
  else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10);
  else if (a === '--timeout') opts.timeout = parseInt(argv[++i], 10);
  else if (a === '--watch-pid') opts.watchPid = argv[++i];
  else if (a === '--follow') opts.follow = true;                   // идти по редиректу (как curl -L): достаёт обработчик за 307
  else if (a === '--insecure') opts.insecure = true;               // не проверять TLS (self-signed)
  else if (a === '--path') opts.path = argv[++i];                  // переопределить путь, напр. /dashboard
  else { console.error('Неизвестный аргумент:', a); process.exit(1); }
}
if (opts.targets.length === 0) {
  console.error('Нужна хотя бы одна --target name=url. См. шапку файла.');
  process.exit(1);
}
if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Битые значения Next-Router-State-Tree — характеризуем, на чём именно падает.
const MALFORMED = [
  { tag: 'junk-string', value: 'xyzzy' },
  { tag: 'bad-json-obj', value: '{"a":1}' },
  { tag: 'empty',        value: '' },
  { tag: 'broken-array', value: '["",{' },
  { tag: 'long-garbage', value: 'x'.repeat(8192) },
];

// Признаки утечки стека/внутренностей в теле ответа.
const LEAK_PATTERNS = [
  /\bat\s+\S+\s+\(/,                 // строка стек-трейса: "at fn (file:line)"
  /\b(Error|TypeError|SyntaxError):/,
  /\/(node_modules|src|app|pages)\//, // пути проекта
  /[A-Za-z]:\\\\/,                   // windows-путь
  /"stack"\s*:/,
  /next@\d|react@\d|\bnode:internal\b/,
];

function leakScan(body) {
  const hits = [];
  for (const re of LEAK_PATTERNS) if (re.test(body)) hits.push(re.source);
  return hits;
}

function sampleRss(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      const line = (out.stdout || '').trim();
      const m = line.match(/"([\d\s.,]+ K)"\s*$/); // последняя колонка — Mem Usage
      if (!m) return null;
      return parseInt(m[1].replace(/[^\d]/g, ''), 10); // КБ
    } else {
      const out = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
      const kb = parseInt((out.stdout || '').trim(), 10);
      return Number.isFinite(kb) ? kb : null;
    }
  } catch { return null; }
}

function fmtKb(kb) { return kb == null ? 'н/д' : (kb / 1024).toFixed(1) + ' МБ'; }

// ---------- один запрос ----------
async function doRequest(url, { rsc = false, stateTree = null } = {}) {
  const headers = {};
  if (rsc) headers['RSC'] = '1';
  if (stateTree !== null) headers['Next-Router-State-Tree'] = stateTree;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout);
  const started = performance.now();
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: opts.follow ? 'follow' : 'manual', signal: ctrl.signal });
    const body = await res.text();
    return {
      ok: true, status: res.status,
      bytes: Buffer.byteLength(body),
      ctype: res.headers.get('content-type') || '',
      ms: performance.now() - started,
      body,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : (e.cause?.code || e.code || e.name || 'ERR'), ms: performance.now() - started };
  } finally { clearTimeout(t); }
}

// ---------- нагрузка ----------
async function loadTest(url, stateTree) {
  const total = opts.requests, conc = opts.concurrency;
  const results = new Array(total);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      results[i] = await doRequest(url, { rsc: true, stateTree });
    }
  }
  const rssBefore = sampleRss(opts.watchPid);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const wallMs = performance.now() - t0;
  const rssAfter = sampleRss(opts.watchPid);

  const byStatus = {};
  const errors = {};
  const lat = [];
  for (const r of results) {
    if (r.ok) { byStatus[r.status] = (byStatus[r.status] || 0) + 1; lat.push(r.ms); }
    else errors[r.error] = (errors[r.error] || 0) + 1;
  }
  lat.sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : NaN;
  // дрейф: медиана первой десятины запросов против последней (по порядку отправки)
  const okSeq = results.filter(r => r.ok).map(r => r.ms);
  const dec = Math.max(1, Math.floor(okSeq.length / 10));
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const driftFirst = med(okSeq.slice(0, dec));
  const driftLast = med(okSeq.slice(-dec));

  return {
    total, conc, wallMs, rps: (total / (wallMs / 1000)),
    byStatus, errors,
    latMin: lat[0], latAvg: lat.reduce((a, b) => a + b, 0) / (lat.length || 1), latMax: lat[lat.length - 1], latP95: pct(0.95),
    driftFirst, driftLast,
    rssBefore, rssAfter,
  };
}

// ---------- прогон одной цели ----------
async function probeTarget({ name, url }) {
  const u = new URL(url);
  if (opts.path) u.pathname = opts.path;
  const target = u.toString();
  console.log('\n' + '='.repeat(70));
  console.log(`ЦЕЛЬ: ${name}  ->  ${target}`);
  console.log('='.repeat(70));

  // 1-2. эталоны
  const base = await doRequest(target, {});
  const baseRsc = await doRequest(target, { rsc: true });
  console.log('\n[эталоны]');
  console.log(`  обычный GET      : ${fmtResp(base)}`);
  console.log(`  GET + RSC:1      : ${fmtResp(baseRsc)}`);

  // 3. характеризация битых значений
  console.log('\n[битый Next-Router-State-Tree — по вариантам]');
  console.log('  вариант         код   байт   content-type                 признаки стека');
  console.log('  ' + '-'.repeat(78));
  let worstLeak = [];
  for (const m of MALFORMED) {
    const r = await doRequest(target, { rsc: true, stateTree: m.value });
    let leakCol = '—';
    if (r.ok && r.status >= 500) {
      const hits = leakScan(r.body);
      if (hits.length) { leakCol = '⚠ ' + hits.length + ' совпад.'; worstLeak = worstLeak.concat(hits); }
      else leakCol = 'нет';
    }
    const codeCol = r.ok ? String(r.status) : r.error;
    console.log(`  ${pad(m.tag, 14)}  ${pad(codeCol, 4)}  ${pad(r.ok ? String(r.bytes) : '-', 5)}  ${pad((r.ctype || '').slice(0, 26), 26)}  ${leakCol}`);
  }

  // 4. нагрузка самым "показательным" вариантом (junk-string)
  console.log(`\n[нагрузка] ${opts.requests} запросов, параллельно ${opts.concurrency}, битый='xyzzy'`);
  const L = await loadTest(target, 'xyzzy');
  console.log(`  коды ответов     : ${JSON.stringify(L.byStatus)}`);
  console.log(`  обрывы/ошибки    : ${Object.keys(L.errors).length ? JSON.stringify(L.errors) : 'нет'}`);
  console.log(`  пропускная способ: ${L.rps.toFixed(1)} зап/с  (стена ${(L.wallMs/1000).toFixed(1)} с)`);
  console.log(`  задержка, мс     : min ${f(L.latMin)}  avg ${f(L.latAvg)}  p95 ${f(L.latP95)}  max ${f(L.latMax)}`);
  console.log(`  дрейф задержки   : первая 1/10 ${f(L.driftFirst)} мс  →  последняя 1/10 ${f(L.driftLast)} мс`);
  if (opts.watchPid) {
    const grow = (L.rssBefore != null && L.rssAfter != null) ? (L.rssAfter - L.rssBefore) : null;
    console.log(`  память pid ${opts.watchPid}   : ${fmtKb(L.rssBefore)} → ${fmtKb(L.rssAfter)}  (${grow == null ? 'н/д' : (grow >= 0 ? '+' : '') + (grow/1024).toFixed(1) + ' МБ'})`);
  }

  // Вердикт по этой цели
  console.log('\n[вердикт]');
  const verdict = [];
  if (worstLeak.length) verdict.push('⚠ InfoLeak: в теле 5xx есть признаки стека/путей — СТОИТ сообщить (Low).');
  else verdict.push('✔ InfoLeak не обнаружен: тела 5xx без стека/путей.');
  if (Object.keys(L.errors).length) verdict.push('⚠ Под нагрузкой есть обрывы соединений — проверь, не крэшит ли процесс (DoS?).');
  else verdict.push('✔ Под нагрузкой обрывов нет: процесс держится.');
  const driftRatio = (L.driftLast && L.driftFirst) ? L.driftLast / L.driftFirst : 1;
  if (driftRatio > 3) verdict.push(`⚠ Задержка выросла ×${driftRatio.toFixed(1)} к концу прогона — возможна деградация/утечка. Повтори с бо́льшим --requests и --watch-pid.`);
  else verdict.push('✔ Деградации задержки не видно.');
  if (opts.watchPid && L.rssBefore != null && L.rssAfter != null && (L.rssAfter - L.rssBefore) > 50 * 1024) {
    verdict.push('⚠ Working Set вырос >50 МБ — возможна утечка. Повтори прогон дважды подряд и сравни.');
  }
  for (const v of verdict) console.log('  ' + v);
  return { name, worstLeak: worstLeak.length, errors: Object.keys(L.errors).length, driftRatio };
}

// ---------- мелкие форматтеры ----------
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function f(x) { return Number.isFinite(x) ? x.toFixed(1) : 'н/д'; }
function fmtResp(r) {
  if (!r.ok) return `ОШИБКА ${r.error} (${f(r.ms)} мс)`;
  return `${r.status}  ${r.bytes} байт  ${(r.ctype || '').slice(0, 30)}  (${f(r.ms)} мс)`;
}

// ---------- main ----------
console.log('rsc-probe — замер обработки битого Next-Router-State-Tree');
console.log(`node ${process.version}, платформа ${process.platform}`);
console.log(`параметры: requests=${opts.requests} concurrency=${opts.concurrency} timeout=${opts.timeout}мс watch-pid=${opts.watchPid || 'нет'} insecure=${opts.insecure}`);
const summary = [];
for (const t of opts.targets) summary.push(await probeTarget(t));

console.log('\n' + '#'.repeat(70));
console.log('ИТОГ ПО ЦЕЛЯМ');
for (const s of summary) {
  const flags = [];
  if (s.worstLeak) flags.push('InfoLeak');
  if (s.errors) flags.push('обрывы');
  if (s.driftRatio > 3) flags.push('деградация');
  console.log(`  ${pad(s.name, 10)} : ${flags.length ? '⚠ ' + flags.join(', ') : '✔ чисто (error-handling, не уязвимость)'}`);
}
console.log('#'.repeat(70));
