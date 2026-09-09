const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const morgan = require('morgan');
const { createLogger, transports, format } = require('winston');

const path = require('path');
const app = express();
const port = 3000;
const isVercel = process.env.VERCEL === '1';

// ---- Upstash Redis storage (only used when deployed) ----
let kv = null;
if (isVercel) {
  try {
    const { Redis } = require('@upstash/redis');
    kv = Redis.fromEnv();
  } catch (e) {
    console.error('[KV] init failed:', e.message);
  }
}

// Storage abstraction — Map locally, KV on Vercel
let _localTasks = null;
let _localLogs = null;
if (!isVercel) {
  _localTasks = new Map();
  _localLogs = [];
}

const STORAGE_TASKS_KEY = 'auto_sign:tasks';
const STORAGE_LOGS_PREFIX = 'auto_sign:logs:';

async function storageGetAllTasks() {
  if (kv) {
    const raw = await kv.get(STORAGE_TASKS_KEY);
    return raw || {};
  }
  return Object.fromEntries(_localTasks.entries());
}

async function storageSetTask(id, task) {
  if (kv) {
    const all = await storageGetAllTasks();
    all[id] = task;
    await kv.set(STORAGE_TASKS_KEY, all);
  } else {
    _localTasks.set(id, task);
  }
}

async function storageDeleteTask(id) {
  if (kv) {
    const all = await storageGetAllTasks();
    delete all[id];
    await kv.set(STORAGE_TASKS_KEY, all);
  } else {
    _localTasks.delete(id);
  }
}

async function storageDeleteTasksByStudent(studentId) {
  let removed = 0;
  if (kv) {
    const all = await storageGetAllTasks();
    for (const key of Object.keys(all)) {
      if (String(all[key].studentId) === String(studentId)) {
        delete all[key];
        removed++;
      }
    }
    if (removed > 0) await kv.set(STORAGE_TASKS_KEY, all);
  } else {
    for (const [key, task] of _localTasks.entries()) {
      if (String(task.studentId) === String(studentId)) {
        _localTasks.delete(key);
        removed++;
      }
    }
  }
  return removed;
}

async function storageAddLog(studentId, entry) {
  if (kv) {
    const key = STORAGE_LOGS_PREFIX + studentId;
    await kv.lpush(key, JSON.stringify(entry));
    await kv.ltrim(key, 0, 49);
  } else {
    _localLogs.push(entry);
    if (_localLogs.length > 50) _localLogs.splice(0, _localLogs.length - 50);
  }
}

async function storageGetLogs(studentId) {
  if (kv) {
    const key = STORAGE_LOGS_PREFIX + studentId;
    const raw = await kv.lrange(key, 0, 49);
    return (raw || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  }
  return _localLogs.filter((l) => String(l.studentId) === String(studentId)).slice(-50);
}

// 创建 winston 日志记录器
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [
        new transports.Console(),
        ...(isVercel ? [] : [new transports.File({ filename: 'combined.log' })])
    ]
});

// 使用 morgan 中间件记录 HTTP 请求日志
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));

// 设置请求主体大小限制
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });
        res.sendStatus(200);
    } else {
        next();
    }
});

// ============================================================
// Auto-sign Cloud Scheduler
// Replaces Service Worker — runs on server so users can close
// their browser/app and signs still execute at the right time.
// ============================================================

const AUTO_SIGN_APP_KEY = '389885588s0648fa';
const AUTO_SIGN_APP_SECRET = '56E39A1658455588885690425C0FD16055A21676';
const AUTO_SIGN_BACKEND = 'https://run-lb.tanmasports.com/v1';

function genSign(query, body) {
  let signStr = "";
  if (query !== null) {
    const keys = Object.keys(query).sort();
    for (const key of keys) {
      const value = query[key] === null ? "" : String(query[key]);
      if (value !== "") signStr += key + value;
    }
  }
  signStr += AUTO_SIGN_APP_KEY;
  signStr += AUTO_SIGN_APP_SECRET;
  if (body !== null) signStr += JSON.stringify(body);

  let replaced = false;
  for (const ch of [" ", "~", "!", "(", ")", "'"]) {
    if (signStr.includes(ch)) {
      signStr = signStr.replace(new RegExp(ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), "g"), "");
      replaced = true;
    }
  }
  if (replaced) signStr = encodeURIComponent(signStr);

  let sign = crypto.createHash('md5').update(signStr).digest('hex').toUpperCase();
  if (replaced) sign += "encodeutf8";
  return sign;
}

function setCors(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  });
}

// ============================================================
// Auto-sign execution engine
// The server is the ONLY executor of 签到/签退. Tasks are stored
// here and a scheduler (30s tick local / cron on Vercel) fires them.
// Every attempt is preceded by a JIT idempotency check against the
// authoritative getSignInTf state, so even if multiple entry points
// (manual UI sign, re-scheduled tasks, exec-now) race, only one real
// sign request is ever sent per signType.
// ============================================================

const AUTO_SIGN_UA = 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)';
const MAX_SIGN_ATTEMPTS = 8;
const STALE_TOLERANCE_MS = 15 * 60 * 1000; // overdue by more than this → treat as residual

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStrOf(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function taskKeyOf(studentId, activityId, signType) {
  return `${studentId}-${activityId}-${signType}`;
}

function signTypeLabel(signType) {
  return signType === '1' ? '签到' : '签退';
}

function isSignDone(tf, signType) {
  return signType === '1'
    ? String(tf?.signInStatus ?? '') === '1'
    : String(tf?.signBackStatus ?? '') === '1';
}

function authHeaders(query, body, token) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': AUTO_SIGN_UA,
    appKey: AUTO_SIGN_APP_KEY,
    sign: genSign(query, body),
  };
  if (token) headers.token = token;
  return headers;
}

async function fetchSignTask(studentId, token) {
  const query = { studentId: Number(studentId) };
  const resp = await fetch(
    AUTO_SIGN_BACKEND + '/clubactivity/getSignInTf?studentId=' + Number(studentId),
    { headers: authHeaders(query, null, token) },
  );
  const data = await resp.json();
  return { ok: Number(data?.code) === 10000, task: data?.response || null };
}

function storageWriteTask(key, task) {
  if (kv) {
    return storageGetAllTasks().then((all) => {
      all[key] = task;
      return kv.set(STORAGE_TASKS_KEY, all);
    });
  }
  _localTasks.set(key, task);
  return Promise.resolve();
}

function storagePushSignLog(task, extra) {
  return storageAddLog(String(task.studentId), {
    studentId: String(task.studentId),
    activityId: task.activityId,
    activityName: task.activityName || '',
    signType: task.signType || '',
    action: extra.action || signTypeLabel(task.signType),
    ok: !!extra.ok,
    msg: extra.msg || '',
    time: new Date().toISOString(),
  });
}

/**
 * Attempt a single sign task. Returns an outcome:
 *  - { kind:'already' }  JIT shows this signType is already done → no request sent
 *  - { kind:'drop' }     activity gone / changed / stale-residual → caller removes task
 *  - { kind:'signed' }   a real signInOrSignBack request was sent
 *  - throws              transient network failure → caller retries with backoff
 */
async function attemptDueTask(task, opts = {}) {
  const mode = opts.mode || 'scheduled'; // 'scheduled' | 'force'
  const stale = !!opts.stale;
  const signType = String(task.signType || '');
  if (signType !== '1' && signType !== '2') return { kind: 'drop', msg: '未知签到类型' };

  let statusOk = false;
  let tf = null;
  try {
    const r = await fetchSignTask(task.studentId, task.token);
    statusOk = r.ok;
    tf = r.task;
  } catch (e) {
    statusOk = false; // JIT unavailable — best-effort: proceed to sign below
  }

  if (statusOk) {
    const tfId = Number(tf?.activityId);
    if (isSignDone(tf, signType)) {
      return { kind: 'already', ok: true, msg: '该' + signTypeLabel(signType) + '已由其他入口完成' };
    }
    if (stale) {
      return { kind: 'drop', msg: '已逾期超过容忍窗口，取消补签' };
    }
    if (mode === 'scheduled') {
      if (!tfId) return { kind: 'drop', msg: '当前无待执行的活动' };
      if (Number(task.activityId) && tfId !== Number(task.activityId)) {
        return { kind: 'drop', msg: '活动已变更，跳过旧任务' };
      }
    }
  }

  const body = {
    activityId: Number(task.activityId),
    latitude: String(task.latitude || ''),
    longitude: String(task.longitude || ''),
    signType,
    studentId: Number(task.studentId),
  };
  const response = await fetch(AUTO_SIGN_BACKEND + '/clubactivity/signInOrSignBack', {
    method: 'POST',
    headers: authHeaders(null, body, task.token),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { kind: 'signed', ok: Number(data?.code) === 10000, msg: data?.msg || data?.message || '' };
}

/**
 * Persist an outcome on a task. Returns true when the task reached a
 * terminal state (executed or dropped), false when it should be retried later.
 */
async function settleTask(task, outcome) {
  const key = taskKeyOf(task.studentId, task.activityId, task.signType) || task.id;
  const label = signTypeLabel(task.signType);
  const time = new Date().toISOString();

  switch (outcome.kind) {
    case 'drop':
      await storageDeleteTask(key);
      await storagePushSignLog(task, { action: label, ok: true, msg: outcome.msg || '任务已清理' });
      logger.info(`[AutoSign] drop ${task.activityName || key}: ${outcome.msg || ''}`);
      return true;
    case 'already':
      task.executed = true;
      task.attempts = 0;
      task.result = { ok: true, action: 'already', msg: outcome.msg || '', time };
      await storageWriteTask(key, task);
      await storagePushSignLog(task, { action: label, ok: true, msg: outcome.msg || '已由其他入口完成' });
      logger.info(`[AutoSign] ${task.activityName || key} ${label} already done — skip`);
      return true;
    case 'signed':
      task.executed = true;
      task.attempts = 0;
      task.result = { ok: outcome.ok, action: 'signed', msg: outcome.msg || '', time };
      await storageWriteTask(key, task);
      await storagePushSignLog(task, {
        action: label,
        ok: outcome.ok,
        msg: outcome.msg || (outcome.ok ? '执行成功' : '执行失败'),
      });
      logger.info(`[AutoSign] scheduler ${task.activityName || key} ${label} ${outcome.ok ? '成功' : '失败'}: ${outcome.msg || ''}`);
      return true;
    case 'error':
    default:
      task.attempts = Number(task.attempts || 0) + 1;
      if (task.attempts >= MAX_SIGN_ATTEMPTS) {
        task.executed = true;
        task.result = { ok: false, action: 'error', msg: outcome.msg || '执行异常', time };
        await storageWriteTask(key, task);
        await storagePushSignLog(task, { action: label, ok: false, msg: `连续失败已放弃：${outcome.msg || ''}` });
        logger.error(`[AutoSign] give up ${task.activityName || key} ${label}: ${outcome.msg || ''}`);
        return true;
      }
      await storageWriteTask(key, task);
      logger.warn(`[AutoSign] retry later ${task.activityName || key} ${label} (${task.attempts}/${MAX_SIGN_ATTEMPTS}): ${outcome.msg || ''}`);
      return false;
  }
}

let _schedulerRunning = false;
const _signingNow = new Set();

/** Run every due, unexecuted task. Returns number of tasks finished this pass. */
async function runDueTasks() {
  if (_schedulerRunning) return 0; // previous tick still awaiting a slow backend
  _schedulerRunning = true;
  let finished = 0;
  try {
    const now = Date.now();
    const all = await storageGetAllTasks();
    for (const [key, task] of Object.entries(all)) {
      if (!task || task.executed) continue;
      const target = Number(task.targetTimestamp || 0);
      if (!target || now < target) continue;
      if (_signingNow.has(key)) continue;

      _signingNow.add(key);
      const stale = now - target > STALE_TOLERANCE_MS;
      let outcome;
      try {
        outcome = await attemptDueTask(task, { mode: 'scheduled', stale });
      } catch (e) {
        outcome = { kind: 'error', msg: e && e.message ? e.message : '请求异常' };
      }
      try {
        if (await settleTask(task, outcome)) finished++;
      } catch (e) {
        logger.error(`[AutoSign] persist failed for ${task.activityName || key}: ${e && e.message}`);
      }
      _signingNow.delete(key);
    }
    return finished;
  } finally {
    _signingNow.clear();
    _schedulerRunning = false;
  }
}

// --- API Routes ---

// Schedule one or more sign tasks
app.post('/api/auto-sign/schedule', async (req, res) => {
  setCors(res);
  try {
    const { tasks, studentId, token } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.json({ code: 1, msg: 'no tasks' });
    }
    let count = 0;
    for (const t of tasks) {
      const id = `${studentId}-${t.activityId}-${t.signType}`;
      const all = await storageGetAllTasks();
      const existing = all[id];
      const newDate = dateStrOf(t.targetTimestamp);
      // Only keep the previous executed/results marker when re-scheduling the
      // SAME activity on the SAME day; otherwise (cross-day reuse of the key)
      // reset it so the old day's completion cannot pollute today's task.
      const sameDay = !!existing && existing.date === newDate;
      all[id] = {
        id,
        studentId: String(studentId),
        token,
        activityId: t.activityId,
        activityName: t.activityName || '',
        signType: t.signType,
        signTime: t.signTime || '',
        targetTimestamp: t.targetTimestamp,
        latitude: t.latitude || '',
        longitude: t.longitude || '',
        date: newDate,
        executed: sameDay ? !!existing.executed : false,
        result: sameDay && existing.executed ? existing.result || null : null,
        attempts: sameDay ? Number(existing.attempts || 0) : 0,
        createdAt: Date.now(),
      };
      if (kv) await kv.set(STORAGE_TASKS_KEY, all);
      else _localTasks.set(id, all[id]);
      count++;
    }
    logger.info(`[AutoSign] scheduled ${count} tasks for student ${studentId}`);
    res.json({ code: 10000, msg: 'scheduled', count });
  } catch (e) {
    res.status(500).json({ code: 1, msg: e.message });
  }
});

// Cancel tasks (by studentId, or specific activity+signType)
app.post('/api/auto-sign/cancel', async (req, res) => {
  setCors(res);
  try {
    const { studentId, activityId, signType } = req.body;
    let removed = 0;
    if (activityId && signType && studentId) {
      const id = `${studentId}-${activityId}-${signType}`;
      if (kv) {
        const all = await storageGetAllTasks();
        if (all[id]) { delete all[id]; await kv.set(STORAGE_TASKS_KEY, all); removed++; }
      } else {
        if (_localTasks.delete(id)) removed++;
      }
    } else if (studentId) {
      removed = await storageDeleteTasksByStudent(studentId);
    }
    if (removed > 0) logger.info(`[AutoSign] cancelled tasks for student ${studentId}`);
    res.json({ code: 10000, msg: 'cancelled', removed });
  } catch (e) {
    res.status(500).json({ code: 1, msg: e.message });
  }
});

// Get execution status and recent logs for a student
app.get('/api/auto-sign/status', async (req, res) => {
  setCors(res);
  try {
    const { studentId } = req.query;
    const all = await storageGetAllTasks();
    const tasks = [];
    for (const task of Object.values(all)) {
      if (String(task.studentId) === String(studentId)) {
        tasks.push({
          activityId: task.activityId,
          activityName: task.activityName,
          signType: task.signType,
          signTime: task.signTime,
          targetTimestamp: task.targetTimestamp,
          executed: task.executed,
          result: task.result,
        });
      }
    }
    const logs = await storageGetLogs(studentId);
    res.json({ code: 10000, tasks, logs });
  } catch (e) {
    res.status(500).json({ code: 1, msg: e.message });
  }
});

// Manually force a sign now. Kept for backward-compat / manual tooling — the
// new frontend no longer calls it. Guards via stored `executed` + JIT check so
// repeated calls are no-ops.
app.post('/api/auto-sign/exec-now', async (req, res) => {
  setCors(res);
  try {
    const { studentId, token, activityId, latitude, longitude, signType, activityName } = req.body;
    const sid = String(studentId);
    const st = String(signType || '');
    const key = taskKeyOf(sid, activityId, st);
    const all = await storageGetAllTasks();
    let task = all[key] ? { ...all[key] } : null;

    if (task && task.executed) {
      return res.json({
        code: 10000,
        ok: true,
        already: true,
        msg: '该任务已执行，无需重复执行',
        label: signTypeLabel(st),
      });
    }

    if (!task) {
      task = {
        id: key,
        studentId: sid,
        token: token || '',
        activityId,
        activityName: activityName || '',
        signType: st,
        signTime: '',
        targetTimestamp: Date.now(),
        latitude: latitude || '',
        longitude: longitude || '',
        executed: false,
        result: null,
        attempts: 0,
      };
    } else {
      task.token = token || task.token;
      task.latitude = latitude ?? task.latitude;
      task.longitude = longitude ?? task.longitude;
    }

    let outcome;
    try {
      outcome = await attemptDueTask(task, { mode: 'force', stale: false });
    } catch (e) {
      outcome = { kind: 'error', msg: e && e.message ? e.message : '请求异常' };
    }
    await settleTask(task, outcome);

    const ok =
      outcome.kind === 'already' ? true : outcome.kind === 'signed' ? !!outcome.ok : false;
    logger.info(`[AutoSign] exec-now ${activityName || key} ${signTypeLabel(st)}: ${outcome.kind} — ${outcome.msg || ''}`);
    res.json({
      code: 10000,
      ok,
      already: outcome.kind === 'already',
      msg: outcome.msg || (outcome.kind === 'already' ? '已由其他入口完成' : ''),
      label: signTypeLabel(st),
    });
  } catch (e) {
    logger.error(`[AutoSign] exec-now error: ${e.message}`);
    res.status(500).json({ code: 1, msg: e.message });
  }
});

// Vercel Cron handler — called every minute from cron job
app.get('/api/auto-sign/cron', async (req, res) => {
  if (isVercel && req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ code: 1, msg: 'unauthorized' });
  }
  try {
    const executed = await runDueTasks();
    res.json({ code: 10000, msg: 'ok', executed });
  } catch (e) {
    res.status(500).json({ code: 1, msg: e.message });
  }
});

// Local scheduler (only runs in non-Vercel mode) — server is the single executor.
// Adaptive cadence: idle 30s to stay battery-friendly, but when a pending task is
// about to become due (or is already due and being retried) it tightens to 5s so a
// sign lands at most ~5s after its targetTimestamp instead of up to 30s late.
if (!isVercel) {
  const IDLE_TICK_MS = 30 * 1000;
  const FAST_TICK_MS = 5 * 1000;
  const FAST_LEAD_MS = 2 * 60 * 1000;

  function nextTickDelay() {
    const now = Date.now();
    let nearest = Infinity;
    for (const task of _localTasks.values()) {
      if (!task || task.executed) continue;
      const target = Number(task.targetTimestamp || 0);
      if (!target) continue;
      const left = target - now;
      if (left <= 0) return FAST_TICK_MS; // due now (or retry) → go fast
      if (left < nearest) nearest = left;
    }
    // Far from every due time → slow idle. Within 2 min of one → fast.
    return nearest === Infinity || nearest > FAST_LEAD_MS ? IDLE_TICK_MS : FAST_TICK_MS;
  }

  function schedulerLoop() {
    setTimeout(async () => {
      try {
        await runDueTasks();
      } catch (e) {
        logger.error(`[AutoSign] scheduler run error: ${e && e.message}`);
      }
      schedulerLoop();
    }, nextTickDelay());
  }
  schedulerLoop();

  // Housekeeping every 10min: drop long-done executed markers and any task
  // record older than 7 days (covers multi-day-ahead schedules without ever
  // deleting a pending task before its target time).
  setInterval(() => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const [key, task] of _localTasks.entries()) {
      if (!task) { _localTasks.delete(key); continue; }
      const resultTime = task.result && task.result.time ? new Date(task.result.time).getTime() : 0;
      const doneLongAgo = !!task.executed && !!resultTime && resultTime < cutoff;
      const createdLongAgo = Date.now() - Number(task.createdAt || 0) > 7 * 24 * 60 * 60 * 1000;
      if (doneLongAgo || createdLongAgo) _localTasks.delete(key);
    }
  }, 600000);
}

// ============================================================
// Serve built frontend (local dev only — on Vercel, static files
// are served by Vercel's infrastructure)
// ============================================================
if (!isVercel) {
  const distPath = path.join(__dirname, '..', 'app', 'dist');
  app.use(express.static(distPath));
  // SPA fallback — serve index.html for Vue Router paths like /club
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') ||
        req.path.startsWith('/clubactivity/') || req.path.startsWith('/unirun/')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ============================================================
// Proxy all unmatched requests to the TanMasports backend
// Uses Node.js built-in https module and HTTP/1.1
// ============================================================
app.all('*', async (req, res) => {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const backendUrl = 'https://run-lb.tanmasports.com/v1' + url.pathname + url.search;
    const backend = new URL(backendUrl);

    logger.info(`Forwarding request to: ${backendUrl}`);

    // Collect headers to forward — essential ones from original request
    // plus a mobile-app User-Agent.
    const forwardHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; SM-S918B Build/UP1A.230905.011)',
      'Accept': 'application/json',
    };
    const passthrough = ['content-type', 'appkey', 'sign', 'token', 'user-agent', 'accept', 'accept-language', 'accept-encoding'];
    for (const key of passthrough) {
      const val = req.headers[key.toLowerCase()] || req.headers[key];
      if (val) forwardHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
    }

    const body = req.method === 'GET' ? null : JSON.stringify(req.body);
    const bodyBuffer = body ? Buffer.from(body, 'utf-8') : null;

    const options = {
      hostname: backend.hostname,
      port: 443,
      path: backend.pathname + backend.search,
      method: req.method,
      headers: {
        ...forwardHeaders,
        'Content-Length': bodyBuffer ? bodyBuffer.length : 0,
      },
      rejectUnauthorized: true,
    };

    try {
      const proxyReq = https.request(options, (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        responseHeaders['Access-Control-Allow-Headers'] = '*';
        delete responseHeaders['set-cookie'];

        let responseBody = '';
        proxyRes.on('data', (chunk) => { responseBody += chunk.toString(); });
        proxyRes.on('end', () => {
          res.writeHead(proxyRes.statusCode || 500, responseHeaders);
          res.end(responseBody);
          logger.info(`Proxy ${req.originalUrl} → ${proxyRes.statusCode}`);
        });
      });

      proxyReq.on('error', (error) => {
        logger.error(`Proxy error for ${req.originalUrl}: ${error.message}`);
        if (!res.headersSent) {
          res.status(500).json({ code: 1, msg: 'Proxy error: ' + error.message });
        }
      });

      if (bodyBuffer) proxyReq.write(bodyBuffer);
      proxyReq.end();
    } catch (error) {
      logger.error(`Error during proxy to ${backendUrl}: ${error.message}`);
      res.status(500).send('Internal Server Error');
    }
});

if (!isVercel) {
  app.listen(port, () => {
      logger.info(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;