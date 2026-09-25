/* Throwaway end-to-end check for the auto-run routes.
 * Copies server/index.js to a temp file with the port, log target and
 * backend URL swapped, boots it against a local mock backend, and drives
 * the /api/auto-run/* routes. Never touches the user's real server.
 *
 *   node server/auto-run-e2e-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 3399;
const MOCK_PORT = 3398;
const src = path.join(__dirname, 'index.js');
const tmp = path.join(__dirname, '.tmp-autorun-test.js');

let patched = fs.readFileSync(src, 'utf-8');
patched = patched.replace(/const port = 3000;/, `const port = ${PORT};`);
patched = patched.replace(/filename: 'combined.log'/, `filename: '${path.join(os.tmpdir(), 'autorun-test.log').replace(/\\/g, '/')}'`);
patched = patched.replace(
  /const AUTO_SIGN_BACKEND = 'https:\/\/run-lb\.tanmasports\.com\/v1';/,
  `const AUTO_SIGN_BACKEND = 'http://127.0.0.1:${MOCK_PORT}';`,
);
// The catch-all proxy at the bottom of index.js also hardcodes production
// (URL, transport and port). Without all three the 404 probe below would reach
// the real platform over TLS:443.
patched = patched.replace(
  /const backendUrl = 'https:\/\/run-lb\.tanmasports\.com\/v1' \+ url\.pathname \+ url\.search;/,
  `const backendUrl = 'http://127.0.0.1:${MOCK_PORT}' + url.pathname + url.search;`,
);
patched = patched.replace(/\n      port: 443,/, `\n      port: ${MOCK_PORT},`);
patched = patched.replace('const proxyReq = https.request(options', 'const proxyReq = http.request(options');
if (patched.includes('run-lb.tanmasports.com')) {
  console.error('FATAL: a production TanMasports URL survived patching — aborting rather than hitting the real backend');
  process.exit(2);
}
// Speed the auto-run tick up so the scheduler path is exercised in-test.
patched = patched.replace(/const AUTO_RUN_TICK_MS = 30 \* 1000;/, 'const AUTO_RUN_TICK_MS = 800;');
// Redirect the state file, or the test would write its fake students into the
// user's real .auto-run-state.json.
const STATE_FILE = path.join(os.tmpdir(), 'autorun-test-state.json');
patched = patched.replace(
  /const AUTO_RUN_STATE_FILE = path\.join\(__dirname, '\.auto-run-state\.json'\);/,
  `const AUTO_RUN_STATE_FILE = '${STATE_FILE.replace(/\\/g, '/')}';`,
);
if (!patched.includes(STATE_FILE.replace(/\\/g, '/'))) {
  console.error('FATAL: could not redirect AUTO_RUN_STATE_FILE — aborting before touching real state');
  process.exit(2);
}
try { fs.unlinkSync(STATE_FILE); } catch {}
fs.writeFileSync(tmp, patched);

// ---- mock TanMasports backend ----
// Only the run-record endpoint exists; anything else 404s, so a request that
// falls through the local routes is visible as a 404 rather than silently ok.
const OK_PATH = '/unirun/save/run/record/new';
const captured = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    captured.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.startsWith(OK_PATH)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ code: 1, msg: 'not found' }));
    }
    res.end(JSON.stringify({ code: 10000, msg: 'ok' }));
  });
});

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  PASS ${name}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

const post = async (p, payload) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
};
const get = async (p) => (await fetch(`http://127.0.0.1:${PORT}${p}`)).json();
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  require(tmp);
  await new Promise((r) => setTimeout(r, 400));

  console.log('--- config + status shape ---');
  let cfg = await post('/api/auto-run/config', {
    studentId: '9001', userId: 555, token: 'tok-abc', enabled: true, gender: '1',
    runStandard: { boyOnceDistanceMin: 2000, boyOnceDistanceMax: 9000 },
    mapId: 'cuit_hkg', windowStart: '08:00', windowEnd: '22:00',
  });
  check('config saved (flat envelope, same shape as /status)',
    cfg.code === 10000 && cfg.configured === true && cfg.config.mapId === 'cuit_hkg',
    JSON.stringify(cfg).slice(0, 140));
  check('plan inside window', cfg.today.hour >= 8 && cfg.today.hour < 22, `hour=${cfg.today.hour}`);
  check('distance in range', cfg.today.distance >= cfg.effective.min && cfg.today.distance <= cfg.effective.max,
    `d=${cfg.today.distance} range=${cfg.effective.min}-${cfg.effective.max}`);
  check('maps exposed', Array.isArray(cfg.maps) && cfg.maps.some((m) => m.id === 'cuit_hkg' && m.name));
  check('effective = school stated range (no boundary padding)', cfg.effective.min === 2000 && cfg.effective.max === 9000,
    JSON.stringify(cfg.effective));
  check('no dryRun left in stored config', cfg.config.dryRun === undefined, String(cfg.config.dryRun));
  check('nothing submitted just by saving', captured.length === 0, `captured=${captured.length}`);

  // Park 9001 so its own scheduler can't add stray requests to the counts below.
  await post('/api/auto-run/config', { studentId: '9001', enabled: false });

  console.log('--- exec-now is gone ---');
  const execResp = await fetch(`http://127.0.0.1:${PORT}/api/auto-run/exec-now`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: '9001' }),
  });
  check('POST /exec-now returns 404', execResp.status === 404, `status=${execResp.status}`);

  console.log('--- slot older than the grace window is skipped, not fired ---');
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  if (nowMin >= 40) {
    const before = captured.length;
    await post('/api/auto-run/config', {
      studentId: '9002', userId: 556, token: 'tok-xyz', enabled: true,
      mapId: 'cuit_hkg', windowStart: hm(nowMin - 40), windowEnd: hm(nowMin - 20),
    });
    await new Promise((r) => setTimeout(r, 2500));
    const st = await get('/api/auto-run/status?studentId=9002');
    check('stale slot not submitted', captured.length === before, `captured=${captured.length - before}`);
    check('stale slot reported as skipped',
      !!st.lastResult && st.lastResult.ok === false && /已过今日执行时间/.test(st.lastResult.msg || ''),
      JSON.stringify(st.lastResult || {}).slice(0, 160));
    check('skipped slot does not consume the day', st.executedToday === false, `executed=${st.executedToday}`);
    const skipTime = st.lastResult.time;
    await new Promise((r) => setTimeout(r, 1800));
    const st2 = await get('/api/auto-run/status?studentId=9002');
    check('skip is recorded once, not every tick', st2.lastResult.time === skipTime,
      `${st2.lastResult.time} vs ${skipTime}`);
    await post('/api/auto-run/config', { studentId: '9002', enabled: false });
  } else {
    console.log('  SKIP (within 40min of midnight — cannot build a stale window)');
  }

  console.log('--- scheduler auto-fire (target inside the grace window) ---');
  const beforeFire = captured.length;
  const endMin = Math.max(0, nowMin - 1);
  const startMin = Math.max(0, nowMin - 6);
  await post('/api/auto-run/config', {
    studentId: '9003', userId: 557, token: 'tok-fire', enabled: true, gender: '1',
    runStandard: { boyOnceDistanceMin: 2000, boyOnceDistanceMax: 9000 },
    mapId: 'cuit_hkg', windowStart: hm(startMin), windowEnd: hm(endMin),
  });
  const preStatus = await get('/api/auto-run/status?studentId=9003');
  check('not executed before tick', preStatus.executedToday === false);
  await new Promise((r) => setTimeout(r, 2500));
  const fireStatus = await get('/api/auto-run/status?studentId=9003');
  check('exactly one request sent', captured.length === beforeFire + 1, `captured=${captured.length - beforeFire}`);
  check('day marked executed', fireStatus.executedToday === true, `executed=${fireStatus.executedToday}`);
  check('result recorded as ok', !!fireStatus.lastResult && fireStatus.lastResult.ok === true,
    JSON.stringify(fireStatus.lastResult || {}).slice(0, 160));

  const c = captured[beforeFire] || { url: '', headers: {}, body: {} };
  check('hit run record endpoint', c.url === '/unirun/save/run/record/new', c.url);
  check('token header forwarded', c.headers.token === 'tok-fire', String(c.headers.token));
  check('sign header present', /^[0-9A-F]{32}/.test(String(c.headers.sign)), String(c.headers.sign).slice(0, 40));
  check('body distance matches plan', c.body.runDistance === fireStatus.today.distance,
    `${c.body.runDistance} vs ${fireStatus.today.distance}`);
  check('body has trackPoints json', typeof c.body.trackPoints === 'string' && c.body.trackPoints.startsWith('['));
  check('body recordDate = today', typeof c.body.recordDate === 'string' && c.body.recordDate.length >= 8, c.body.recordDate);
  check('body userId numeric', c.body.userId === 557, String(c.body.userId));

  console.log('--- success is not repeated on later ticks ---');
  await new Promise((r) => setTimeout(r, 2400));
  check('no second submission', captured.length === beforeFire + 1, `captured=${captured.length - beforeFire}`);

  console.log('--- settings survive a round trip ---');
  const rt = await get('/api/auto-run/status?studentId=9001');
  check('map/window persisted', rt.config.mapId === 'cuit_hkg' && rt.config.windowStart === '08:00' && rt.config.windowEnd === '22:00',
    `${rt.config.mapId} ${rt.config.windowStart}-${rt.config.windowEnd}`);
  check('disabled student stays disabled', rt.config.enabled === false, String(rt.config.enabled));

  console.log('--- user-set distance range ---');
  const RANGE_SID = '9010';
  const rangeBase = {
    studentId: RANGE_SID, userId: 570, token: 'tok-range', enabled: true, gender: '1',
    runStandard: { boyOnceDistanceMin: 2000, boyOnceDistanceMax: 9000 },
    mapId: 'cuit_hkg', windowStart: '08:00', windowEnd: '22:00',
  };

  // (a) no explicit range → full school envelope (back-compat with saved configs)
  let rg = await post('/api/auto-run/config', { ...rangeBase });
  const wideDistance = rg.today.distance;
  const wideTarget = rg.today.targetTimestamp;
  check('no range given → full school envelope',
    rg.effective.min === 2000 && rg.effective.max === 9000, JSON.stringify(rg.effective));
  // The school standard here says boyOnceDistanceMin 2000 / boyOnceDistanceMax
  // 9000. resolveRunBoundsFromStandard() would pad these to 2001 / 10001 for the
  // manual path; auto-run must report the school's own numbers instead.
  check('envelope exposed for the UI to clamp against',
    rg.envelope && rg.envelope.min === 2000 && rg.envelope.max === 9000, JSON.stringify(rg.envelope));

  // (b) narrowing the range re-draws the distance. The narrow window is built to
  // exclude wideDistance by construction, so this cannot pass by luck.
  const narrowMin = wideDistance > 4000 ? 2000 : 8000;
  const narrowMax = narrowMin + 500;
  rg = await post('/api/auto-run/config', {
    ...rangeBase, distanceMin: narrowMin, distanceMax: narrowMax,
  });
  check('explicit range becomes the effective range',
    rg.effective.min === narrowMin && rg.effective.max === narrowMax, JSON.stringify(rg.effective));
  check('distance re-drawn inside the explicit range',
    rg.today.distance >= narrowMin && rg.today.distance <= narrowMax,
    `d=${rg.today.distance} range=${narrowMin}-${narrowMax}`);
  check('distance actually differs from the full-envelope draw',
    rg.today.distance !== wideDistance, `${rg.today.distance} vs wide ${wideDistance}`);
  // The time is drawn from the same seeded rng but before the distance, so
  // changing only the distance range must not move the planned time.
  check('changing the distance range does not move the planned time',
    rg.today.targetTimestamp === wideTarget,
    `${rg.today.targetTimestamp} vs ${wideTarget}`);

  // (c) same calendar day → the plan is stable across reads and across the
  // per-request re-planning that /status does. This is the "distance refreshes
  // daily, not per request" contract.
  const stable1 = await get(`/api/auto-run/status?studentId=${RANGE_SID}`);
  await new Promise((r) => setTimeout(r, 1200));
  const stable2 = await get(`/api/auto-run/status?studentId=${RANGE_SID}`);
  check('same-day distance is stable across reads',
    stable1.today.distance === stable2.today.distance && stable1.today.distance === rg.today.distance,
    `${stable1.today.distance} / ${stable2.today.distance} / ${rg.today.distance}`);
  check('same-day planned time is stable across reads',
    stable1.today.targetTimestamp === stable2.today.targetTimestamp, `${stable1.today.targetTimestamp} vs ${stable2.today.targetTimestamp}`);

  // (d) out-of-envelope input is clamped, not rejected outright
  rg = await post('/api/auto-run/config', { ...rangeBase, distanceMin: 1, distanceMax: 999999 });
  check('below-envelope min clamped up', rg.effective.min === 2000, JSON.stringify(rg.effective));
  check('above-envelope max clamped down', rg.effective.max === 9000, JSON.stringify(rg.effective));
  check('clamped draw stays inside the school envelope',
    rg.today.distance >= 2000 && rg.today.distance <= 9000, `d=${rg.today.distance}`);

  // (e) inverted range falls back to the envelope rather than guessing an end
  rg = await post('/api/auto-run/config', { ...rangeBase, distanceMin: 5000, distanceMax: 3000 });
  check('inverted range falls back to the full envelope',
    rg.effective.min === 2000 && rg.effective.max === 9000, JSON.stringify(rg.effective));

  await post('/api/auto-run/config', { studentId: RANGE_SID, enabled: false });

  console.log('--- persistence file ---');
  check('state file written', fs.existsSync(STATE_FILE));

  console.log('----------------------------------------');
  console.log(`RESULT: ${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`);
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(STATE_FILE); } catch {}
  process.exit(failed === 0 ? 0 : 1);
})();
