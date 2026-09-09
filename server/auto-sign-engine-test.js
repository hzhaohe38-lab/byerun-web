/**
 * Auto-sign execution engine self-test (no real TanMasports, no port 3000).
 *
 * Loads a copy of server/index.js whose AUTO_SIGN_BACKEND points at a local
 * mock and whose listen port is an ephemeral free port. It then drives the real
 * HTTP routes + scheduler engine (runDueTasks via /cron) to verify:
 *
 *   A) a due task signs exactly ONCE
 *   B) JIT getSignInTf shows "already done" -> NO sign request sent
 *   C) same-key schedule on a DIFFERENT day resets the executed marker
 *   D) /exec-now is idempotent (2nd call = no-op)
 *   E) an overdue (>15min) task is dropped, not late-signed
 *
 * Run:  node server/auto-sign-engine-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SRC = path.join(__dirname, 'index.js');
// Must live beside server/index.js so its require('express') resolves from
// server/node_modules. Removed immediately after require.
const COPY = path.join(__dirname, '.__under_test_index.js');

// ---------- tiny assertion helpers ----------
let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}
function section(name) {
  console.log(`\n== ${name} ==`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ---------- local mock TanMasports backend ----------
function buildBackend() {
  const signHits = []; // { studentId, activityId, signType }
  const tfMap = {
    555: { activityId: 9001, activityName: '体育A', signInStatus: 0, signBackStatus: 0 },
    556: { activityId: 9002, activityName: '体育B', signInStatus: 1, signBackStatus: 0 }, // sign-in ALREADY done
    557: { activityId: 9003, activityName: '体育C', signInStatus: 0, signBackStatus: 0 },
    558: { activityId: 9005, activityName: '体育E', signInStatus: 0, signBackStatus: 0 },
    559: { activityId: 9007, activityName: '体育F', signInStatus: 1, signBackStatus: 0 }, // sign-out pending
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname.endsWith('/getSignInTf')) {
        const sid = Number(url.searchParams.get('studentId'));
        const tf = tfMap[sid];
        res.end(JSON.stringify({ code: 10000, response: tf || {} }));
        return;
      }
      if (url.pathname.endsWith('/signInOrSignBack')) {
        let b = null;
        try { b = JSON.parse(body); } catch (e) { /* ignore */ }
        if (b) signHits.push({ studentId: Number(b.studentId), activityId: Number(b.activityId), signType: String(b.signType) });
        res.end(JSON.stringify({ code: 10000, msg: 'mock ok' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 1, msg: 'mock 404 ' + url.pathname }));
    });
  });
  return { server, signHits };
}

function countHits(hits, sid, aid, signType) {
  return hits.filter(
    (h) => h.studentId === sid && h.activityId === aid && h.signType === String(signType),
  ).length;
}

function jbody(data) {
  return JSON.stringify(data);
}

async function run() {
  const mockPort = await freePort();
  const appPort = await freePort();
  const { server: backend, signHits } = buildBackend();
  await new Promise((r) => backend.listen(mockPort, '127.0.0.1', r));

  // Build the copy of the server under test.
  let src = fs.readFileSync(SRC, 'utf8');
  src = src.replace(`const port = 3000;`, `const port = ${appPort};`);
  src = src.replace(
    `const AUTO_SIGN_BACKEND = 'https://run-lb.tanmasports.com/v1';`,
    `const AUTO_SIGN_BACKEND = 'http://127.0.0.1:${mockPort}/v1';`,
  );
  // Silence morgan + point the file transport at a temp log so the live
  // server/combined.log the user watches stays clean.
  src = src.replace(
    `app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));`,
    `app.use((req, res, next) => next());`,
  );
  src = src.replace(
    `filename: 'combined.log'`,
    `filename: ${JSON.stringify(path.join(os.tmpdir(), 'unirun_engine_test_combined.log'))}`,
  );
  fs.writeFileSync(COPY, src);

  // Load it (VERCEL unset -> local Map storage; listens on appPort).
  let app;
  try {
    app = require(COPY);
  } finally {
    try { fs.unlinkSync(COPY); } catch (e) { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  const base = `http://127.0.0.1:${appPort}`;

  const api = async (pathStr, opts = {}) => {
    const resp = await fetch(base + pathStr, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return resp.json();
  };

  // ---------- Scenario A: single execution for a due task ----------
  section('A) scheduler fires a due sign-in exactly once');
  const past = Date.now() - 1000; // due now, well inside stale tolerance
  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '555',
      token: 'tok555',
      tasks: [
        {
          activityId: 9001,
          activityName: '体育A',
          signType: '1',
          signTime: '18:00:01',
          targetTimestamp: past,
          latitude: '30.1',
          longitude: '104.0',
        },
      ],
    },
  });
  let st = await api('/api/auto-sign/status?studentId=555');
  ok('task scheduled & pending', Array.isArray(st.tasks) && st.tasks.length === 1 && st.tasks[0].executed === false, st.tasks);

  await api('/api/auto-sign/cron', { headers: { 'x-vercel-cron': '1' } });
  ok('one real signInOrSignBack sent', countHits(signHits, 555, 9001, '1') === 1, signHits);

  st = await api('/api/auto-sign/status?studentId=555');
  ok('task marked executed ok', Array.isArray(st.tasks) && st.tasks[0].executed === true && st.tasks[0].result?.ok === true, st.tasks);

  await api('/api/auto-sign/cron', { headers: { 'x-vercel-cron': '1' } });
  ok('second tick does NOT re-sign', countHits(signHits, 555, 9001, '1') === 1, signHits);

  // ---------- Scenario B: JIT shows already done -> no request ----------
  section('B) JIT idempotency: already signed in -> no sign request');
  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '556',
      token: 'tok556',
      tasks: [{ activityId: 9002, activityName: '体育B', signType: '1', signTime: '18:00:01', targetTimestamp: past }],
    },
  });
  await api('/api/auto-sign/cron', { headers: { 'x-vercel-cron': '1' } });
  ok('no sign request sent (already done via getSignInTf)', countHits(signHits, 556, 9002, '1') === 0, signHits);
  st = await api('/api/auto-sign/status?studentId=556');
  ok('task settled as executed/already', Array.isArray(st.tasks) && st.tasks[0].executed === true && st.tasks[0].result?.action === 'already', st.tasks);

  // ---------- Scenario C: same-key different-day resets executed ----------
  section('C) cross-day schedule resets executed marker');
  const keyDay1 = Date.now() - 1000; // today, already due so the tick executes it
  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '557',
      token: 'tok557',
      tasks: [{ activityId: 9003, activityName: '体育C', signType: '1', signTime: '18:00:01', targetTimestamp: keyDay1 }],
    },
  });
  await api('/api/auto-sign/cron', { headers: { 'x-vercel-cron': '1' } }); // execute it (mock says not signed)
  ok('day-1 task executed', countHits(signHits, 557, 9003, '1') === 1);

  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '557',
      token: 'tok557',
      tasks: [{ activityId: 9003, activityName: '体育C', signType: '1', signTime: '18:00:01', targetTimestamp: Date.now() + 30 * 1000 }],
    },
  });
  st = await api('/api/auto-sign/status?studentId=557');
  ok('same-day re-schedule keeps executed=true', Array.isArray(st.tasks) && st.tasks[0].executed === true, st.tasks);

  const nextDay = Date.now() + 26 * 60 * 60 * 1000; // tomorrow
  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '557',
      token: 'tok557',
      tasks: [{ activityId: 9003, activityName: '体育C', signType: '1', signTime: '18:00:01', targetTimestamp: nextDay }],
    },
  });
  st = await api('/api/auto-sign/status?studentId=557');
  ok('different-day re-schedule resets executed=false', Array.isArray(st.tasks) && st.tasks[0].executed === false && st.tasks[0].result === null, st.tasks);

  // ---------- Scenario D: /exec-now idempotency ----------
  section('D) /exec-now is idempotent');
  const now = Date.now();
  await api('/api/auto-sign/exec-now', {
    method: 'POST',
    body: { studentId: '558', token: 'tok558', activityId: 9005, latitude: '30.2', longitude: '104.1', signType: '1' },
  });
  ok('first exec-now signed', countHits(signHits, 558, 9005, '1') === 1, signHits);
  const again = await api('/api/auto-sign/exec-now', {
    method: 'POST',
    body: { studentId: '558', token: 'tok558', activityId: 9005, latitude: '30.2', longitude: '104.1', signType: '1' },
  });
  ok('second exec-now is a no-op (already)', again.already === true && countHits(signHits, 558, 9005, '1') === 1, { again, hits: countHits(signHits, 558, 9005, '1') });

  // ---------- Scenario E: overdue task dropped ----------
  section('E) overdue (>15min) task is dropped, not late-signed');
  const overdue = Date.now() - 20 * 60 * 1000;
  await api('/api/auto-sign/schedule', {
    method: 'POST',
    body: {
      studentId: '559',
      token: 'tok559',
      tasks: [{ activityId: 9007, activityName: '体育F', signType: '2', signTime: '18:20:00', targetTimestamp: overdue }],
    },
  });
  await api('/api/auto-sign/cron', { headers: { 'x-vercel-cron': '1' } });
  ok('no late sign request sent', countHits(signHits, 559, 9007, '2') === 0, signHits);
  st = await api('/api/auto-sign/status?studentId=559');
  ok('overdue task removed from store', Array.isArray(st.tasks) && st.tasks.length === 0, st.tasks);

  // ---------- summary ----------
  console.log(`\n${'-'.repeat(40)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  backend.close();
  app.listen && app.close && app.close();
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
