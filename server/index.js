const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const morgan = require('morgan');
const { createLogger, transports, format } = require('winston');

const app = express();
const port = 3000;
const isVercel = process.env.VERCEL === '1';

// ---- Vercel KV / Upstash Redis storage (only used when deployed) ----
let kv = null;
if (isVercel) {
  try {
    const { createClient } = require('@vercel/kv');
    kv = createClient({
      url: process.env.KV_URL || process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
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
  if (kv) {
    const all = await storageGetAllTasks();
    for (const key of Object.keys(all)) {
      if (String(all[key].studentId) === String(studentId)) delete all[key];
    }
    await kv.set(STORAGE_TASKS_KEY, all);
  } else {
    for (const [key, task] of _localTasks.entries()) {
      if (String(task.studentId) === String(studentId)) _localTasks.delete(key);
    }
  }
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
        executed: existing?.executed || false,
        result: existing?.result || null,
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
      await storageDeleteTasksByStudent(studentId);
      removed = 1;
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

// Execute a sign immediately (called by frontend polling or manual trigger)
app.post('/api/auto-sign/exec-now', async (req, res) => {
  setCors(res);
  try {
    const { studentId, token, activityId, latitude, longitude, signType, activityName } = req.body;
    const body = {
      activityId: Number(activityId),
      latitude: String(latitude || ''),
      longitude: String(longitude || ''),
      signType: String(signType),
      studentId: Number(studentId),
    };
    const sign = genSign(null, body);
    const response = await fetch(AUTO_SIGN_BACKEND + '/clubactivity/signInOrSignBack', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        appKey: AUTO_SIGN_APP_KEY,
        sign,
        ...(token ? { token } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    const ok = data?.code === 10000;
    const msg = data?.msg || data?.message || '';
    const label = signType === '1' ? '签到' : '签退';

    await storageAddLog(String(studentId), {
      studentId: String(studentId),
      activityId,
      activityName: activityName || '',
      signType,
      ok,
      msg,
      time: new Date().toISOString(),
    });
    const taskId = `${studentId}-${activityId}-${signType}`;
    if (kv) {
      const all = await storageGetAllTasks();
      if (all[taskId]) { all[taskId].executed = true; all[taskId].result = { ok, msg, time: new Date().toISOString() }; await kv.set(STORAGE_TASKS_KEY, all); }
    } else {
      const task = _localTasks.get(taskId);
      if (task) { task.executed = true; task.result = { ok, msg, time: new Date().toISOString() }; }
    }

    logger.info(`[AutoSign] exec-now ${activityName} ${label}: ${ok ? 'ok' : 'fail'} — ${msg}`);
    res.json({ code: 10000, ok, msg, label });
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
  const now = Date.now();
  const all = await storageGetAllTasks();
  let executed = 0;
  for (const [key, task] of Object.entries(all)) {
    if (task.executed) continue;
    if (now < task.targetTimestamp) continue;
    task.executed = true;
    executed++;
    try {
      const body = {
        activityId: Number(task.activityId),
        latitude: String(task.latitude || ''),
        longitude: String(task.longitude || ''),
        signType: String(task.signType),
        studentId: Number(task.studentId),
      };
      const sign = genSign(null, body);
      const response = await fetch(AUTO_SIGN_BACKEND + '/clubactivity/signInOrSignBack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', appKey: AUTO_SIGN_APP_KEY, sign, ...(task.token ? { token: task.token } : {}) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      const ok = data?.code === 10000;
      task.result = { ok, msg: data?.msg || data?.message || '', time: new Date().toISOString() };
      if (kv) await kv.set(STORAGE_TASKS_KEY, all);
      else _localTasks.set(key, task);
      await storageAddLog(task.studentId, { studentId: task.studentId, activityId: task.activityId, activityName: task.activityName, signType: task.signType, ok, msg: data?.msg || data?.message || '', time: new Date().toISOString() });
      logger.info(`[AutoSign] cron ${task.activityName} ${task.signType === '1' ? '签到' : '签退'} ${ok ? '成功' : '失败'}: ${data?.msg || ''}`);
    } catch (e) {
      task.executed = false;
      if (kv) await kv.set(STORAGE_TASKS_KEY, all);
      else _localTasks.set(key, task);
      logger.error(`[AutoSign] cron error for ${task.activityName}: ${e.message}`);
    }
  }
  res.json({ code: 10000, msg: 'ok', executed });
});

// Local scheduler (only runs in non-Vercel mode)
if (!isVercel) {
  setInterval(async () => {
    const now = Date.now();
    for (const [key, task] of _localTasks.entries()) {
      if (task.executed) continue;
      if (now < task.targetTimestamp) continue;
      task.executed = true;
      try {
        const body = { activityId: Number(task.activityId), latitude: String(task.latitude || ''), longitude: String(task.longitude || ''), signType: String(task.signType), studentId: Number(task.studentId) };
        const sign = genSign(null, body);
        const response = await fetch(AUTO_SIGN_BACKEND + '/clubactivity/signInOrSignBack', {
          method: 'POST', headers: { 'Content-Type': 'application/json', appKey: AUTO_SIGN_APP_KEY, sign, ...(task.token ? { token: task.token } : {}) },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        const ok = data?.code === 10000;
        task.result = { ok, msg: data?.msg || data?.message || '', time: new Date().toISOString() };
        _localLogs.push({ studentId: task.studentId, activityId: task.activityId, activityName: task.activityName, signType: task.signType, ok, msg: data?.msg || data?.message || '', time: new Date().toISOString() });
        if (_localLogs.length > 50) _localLogs.splice(0, _localLogs.length - 50);
        logger.info(`[AutoSign] scheduler ${task.activityName} ${task.signType === '1' ? '签到' : '签退'} ${ok ? '成功' : '失败'}: ${data?.msg || ''}`);
      } catch (e) {
        task.executed = false;
        logger.error(`[AutoSign] scheduler error for ${task.activityName}: ${e.message}`);
      }
    }
  }, 30000);

  setInterval(() => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const [key, task] of _localTasks.entries()) {
      if (task.createdAt < cutoff) _localTasks.delete(key);
    }
  }, 600000);
}

// ---- Serve built frontend (Vue app in public/) ----
app.use(express.static(path.join(__dirname, 'public')));
// SPA fallback for direct navigation (browser refresh on /auth etc.)
app.get('/auth', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================

app.all('*', async (req, res) => {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const backendUrl = 'https://run-lb.tanmasports.com/v1' + url.pathname + url.search;

    logger.info(`Forwarding request to: ${backendUrl}`);

    // Only forward essential headers — strip browser-specific headers
    // that the backend load balancer rejects (405)
    const forwardHeaders = {};
    const allowed = ['content-type', 'appkey', 'sign', 'token'];
    for (const key of allowed) {
      if (req.headers[key]) {
        forwardHeaders[key] = req.headers[key];
      }
    }

    const init = {
        method: req.method,
        headers: forwardHeaders,
        body: req.method === 'GET' ? null : JSON.stringify(req.body)
    };

    try {
        const response = await fetch(backendUrl, init);
        const body = await response.text();

        res.set({
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        });

        res.status(response.status).send(body);
    } catch (error) {
        logger.error(`Error during fetch: ${error.message}`);
        res.status(500).send('Internal Server Error');
    }
});

if (!isVercel) {
  app.listen(port, () => {
      logger.info(`Server is running on http://localhost:${port}`);
  });
}

module.exports = app;