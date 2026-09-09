import { ref, onUnmounted } from 'vue';
import { api } from './useApi';
import { useDataStore } from './useDataStore';
import { getSessionToken } from '@/utils/authStorage';

const STORAGE_KEY = 'unirun.club_auto_sign';
const POLL_INTERVAL = 10 * 1000;
const AUTO_SIGN_API = '/api/auto-sign';

// Polling only happens inside a small window around a target timestamp, so we
// do not hammer the club backend while nothing is about to fire.
const POLL_LEAD = 10 * 1000; // start polling this long before a target fires
const POLL_AFTER = 150 * 1000; // keep polling this long after a target for the result

// ---- module-level state (survives component unmount) ----

const enabled = ref(false);
const status = ref('idle');
const signLog = ref([]);
const lastError = ref('');
const nextScheduledInfo = ref('');
const countdownDisplay = ref('');

let _pollTimer = null;
let _scheduleTimer = null;
let _countdownTimer = null;
let _countdownTarget = null; // { type:'sign_in'|'sign_back', ms }

// Tasks we pushed to the server this session. `executed`/`result` are
// shadowed from the server's /status response on every refresh.
let _scheduled = []; // { signType, activityId, activityName, targetTimestamp, executed, result }
let _lastExec = new Map(); // key -> executed (transition detector for toasts)
let _baselineDone = false;
let _serverLogSig = new Set(); // signatures of server logs already shown
let _idSeq = 1;
let _onSignResult = null; // callback set by component for toast notifications

// Store refs (lazily set by composable in setup context — not at module level)
let _studentIdRef = null;
let _tokenRef = null;
let _schoolIdRef = null;

// ---- time helpers ----

function parseTimeStr(s) {
  if (!s) return null;
  const parts = String(s).trim().split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return { h, m, s: parseInt(parts[2]) || 0 };
}

function buildTodayDate(timeStr) {
  const t = parseTimeStr(timeStr);
  if (!t) return null;
  const d = new Date();
  d.setHours(t.h, t.m, t.s, 0);
  return d;
}

function parseYymmdd(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse mmdd (MM-DD or MMDD) format, prepending current year */
function parseMmdd(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m, day;
  const dash = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (dash) {
    m = parseInt(dash[1]);
    day = parseInt(dash[2]);
  } else {
    const plain = s.match(/^(\d{2})(\d{2})$/);
    if (plain) {
      m = parseInt(plain[1]);
      day = parseInt(plain[2]);
    } else {
      return null;
    }
  }
  if (m < 1 || m > 12 || day < 1 || day > 31) return null;
  const now = new Date();
  let year = now.getFullYear();
  const d = new Date(year, m - 1, day, 0, 0, 0, 0);
  // If the date seems to have passed and is more than 2 months ago, try next year
  if (d.getTime() < Date.now() - 60 * 24 * 60 * 60000) {
    d.setFullYear(year + 1);
  }
  return isNaN(d.getTime()) ? null : d;
}

function formatDateForApi(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- persistence ----

function persistState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: enabled.value }));
  } catch (e) { /* */ }
}

// Restore persisted state
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const p = JSON.parse(raw);
    enabled.value = p.enabled === true;
  }
} catch (e) { /* */ }

// ---- log helpers ----

function addLog(action, title, ok, msg) {
  signLog.value.unshift({
    id: Date.now() + _idSeq++,
    action: action || '系统',
    title: title || '未知活动',
    time: new Date().toLocaleString(),
    ok,
    msg: msg || '',
  });
  if (signLog.value.length > 60) signLog.value = signLog.value.slice(0, 60);
}

function signTypeLabel(signType) {
  return String(signType) === '1' ? '签到' : String(signType) === '2' ? '签退' : '系统';
}

function mergeServerLogs(logs) {
  if (!Array.isArray(logs)) return;
  for (const l of logs) {
    const sig = `${l.time}|${l.signType}|${l.action}|${l.ok}|${l.msg}`;
    if (_serverLogSig.has(sig)) continue;
    _serverLogSig.add(sig);
    const timeText = l.time ? new Date(l.time).toLocaleString() : new Date().toLocaleString();
    signLog.value.unshift({
      id: Date.now() + _idSeq++,
      action: l.action || signTypeLabel(l.signType),
      title: l.activityName || '活动',
      time: timeText,
      ok: !!l.ok,
      msg: l.msg || '',
    });
  }
  if (signLog.value.length > 60) signLog.value = signLog.value.slice(0, 60);
}

function resetLogDedup() {
  _serverLogSig.clear();
}

// ---- capability ----

function canExec() {
  return !!(_studentIdRef?.value && _tokenRef?.value);
}

function keyOf(signType, activityId) {
  return `${signType}-${activityId}`;
}

function shadowFromServer(tasks) {
  if (!Array.isArray(tasks)) return;
  const byKey = new Map();
  for (const t of tasks) {
    byKey.set(`${t.signType}-${t.activityId}`, t);
  }
  for (const s of _scheduled) {
    const serverTask = byKey.get(keyOf(s.signType, s.activityId));
    s.executed = serverTask ? !!serverTask.executed : s.executed;
    s.result = serverTask && serverTask.executed ? serverTask.result || null : null;
    if (serverTask) {
      s.targetTimestamp = Number(serverTask.targetTimestamp || s.targetTimestamp || 0);
    }
  }
}

// ---- backend communication (schedule + read-only status) ----

async function postSchedule(tasks) {
  try {
    const token = getSessionToken();
    const resp = await fetch(AUTO_SIGN_API + '/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks, studentId: _studentIdRef.value, token }),
    });
    const data = await resp.json().catch(() => null);
    return data && (Number(data.code) === 10000 || data.code === 10000) ? data : null;
  } catch (e) {
    return null;
  }
}

async function cancelTasksOnBackend() {
  try {
    await fetch(AUTO_SIGN_API + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId: _studentIdRef?.value }),
    });
  } catch (e) { /* */ }
}

async function fetchServerStatus() {
  try {
    const resp = await fetch(
      AUTO_SIGN_API + '/status?studentId=' + encodeURIComponent(String(_studentIdRef.value)),
    );
    return await resp.json();
  } catch (e) {
    return null;
  }
}

async function fetchTodayTask() {
  try {
    const resp = await api.queryClubSignStatus(_studentIdRef.value);
    const d = resp?.data;
    if (Number(d?.code) !== 10000) return null;
    const task = d.response;
    if (!task || !Number(task.activityId)) return null;
    return task;
  } catch (e) {
    return null;
  }
}

// ---- countdown (display only — the server does the actual sign) ----

function formatCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}小时`);
  if (m > 0) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join('');
}

function setCountdownTarget(type, ms) {
  if (!type || !Number.isFinite(ms)) {
    _countdownTarget = null;
    countdownDisplay.value = '';
    return;
  }
  _countdownTarget = { type, ms };
  tickCountdown();
}

function clearCountdownTarget() {
  _countdownTarget = null;
  countdownDisplay.value = '';
}

function tickCountdown() {
  if (!_countdownTarget) {
    countdownDisplay.value = '';
    return;
  }
  const label = _countdownTarget.type === 'sign_in' ? '签到' : '签退';
  const remaining = _countdownTarget.ms - Date.now();
  if (remaining <= 0) {
    countdownDisplay.value = `${label}执行中...`;
    return;
  }
  countdownDisplay.value = `将在${formatCountdown(remaining)}后执行${label}`;
}

function startCountdownTimer() {
  if (_countdownTimer) return;
  tickCountdown();
  _countdownTimer = setInterval(tickCountdown, 1000);
}

function stopCountdownTimer() {
  if (_countdownTimer) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
  _countdownTarget = null;
  countdownDisplay.value = '';
}

// ---- polling / wake scheduling (drives checkAndExec near fire times) ----

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => checkAndExec(), POLL_INTERVAL);
}

function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function clearScheduleTimer() {
  if (_scheduleTimer) {
    clearTimeout(_scheduleTimer);
    _scheduleTimer = null;
  }
}

function pendingTasks() {
  return _scheduled.filter((s) => !s.executed);
}

function windowFor(task, now) {
  const d = now - Number(task.targetTimestamp || 0);
  return d >= -POLL_LEAD && d <= POLL_AFTER;
}

function restartPolling() {
  const now = Date.now();
  if (enabled.value && pendingTasks().some((s) => windowFor(s, now))) {
    startPolling();
  } else {
    stopPolling();
  }
}

function scheduleNextWake() {
  clearScheduleTimer();
  const now = Date.now();
  let best = null;
  for (const s of pendingTasks()) {
    const target = Number(s.targetTimestamp || 0);
    if (!target) continue;
    const d = target - now;
    if (d <= -POLL_LEAD) continue; // already past lead (polling window or stale) — handled elsewhere
    if (d < best || best === null) best = d;
  }
  if (best === null) return;
  const wakeDelay = Math.max(0, best - POLL_LEAD);
  _scheduleTimer = setTimeout(() => {
    _scheduleTimer = null;
    startPolling();
    checkAndExec();
  }, wakeDelay);
}

// ---- execution-result detection (server reports back; we only toast) ----

function detectExecutions() {
  let changed = false;
  for (const s of _scheduled) {
    const key = keyOf(s.signType, s.activityId);
    const was = _lastExec.get(key);
    const nowState = !!s.executed;
    if (was === undefined) {
      _lastExec.set(key, nowState);
      continue;
    }
    if (!was && nowState) {
      _lastExec.set(key, true);
      changed = true;
      const label = signTypeLabel(s.signType);
      const ok = !!(s.result && s.result.ok);
      const msg = (s.result && s.result.msg) || '';
      const title = s.activityName || `活动${s.activityId}`;
      if (_onSignResult) {
        _onSignResult(ok, `${title} ${label}${ok ? '成功' : '失败'}${msg ? '：' + msg : ''}`);
      }
      if (!ok) {
        lastError.value = msg || '执行失败';
      }
    }
  }
  return changed;
}

// ---- display recompute from authoritative state ----

function firstExecutedFailure() {
  for (const s of _scheduled) {
    if (s.executed && s.result && !s.result.ok) return s;
  }
  return null;
}

/**
 * Whether a getSignInTf result actually drives sign timing. If the activity
 * exists but its next needed action has no concrete time (e.g. signInTime empty
 * for an upcoming activity whose window is defined by the activity start),
 * treat it as NOT today-controller so we fall back to scheduling from the
 * registered-future list (which carries a real start time).
 */
function isTodayDriving(today) {
  if (!today || !Number(today.activityId)) return false;
  const inDone = String(today.signInStatus ?? '') === '1';
  const outDone = String(today.signBackStatus ?? '') === '1';
  if (inDone && outDone) return true;
  if (!inDone) return !!buildTodayDate(today.signInTime);
  return !!buildTodayDate(today.signBackTime || today.signBackLimitTime);
}

function recomputeDisplay(today) {
  // A server-executed sign that failed → surface it and stop the countdown.
  const failed = firstExecutedFailure();
  if (failed) {
    status.value = 'error';
    lastError.value = (failed.result && failed.result.msg) || '服务端执行失败';
    nextScheduledInfo.value = '';
    clearCountdownTarget();
    stopPolling();
    return;
  }

  const todayActive = isTodayDriving(today);

  // 1) Authoritative "today task" from getSignInTf drives the common case.
  if (todayActive) {
    const inDone = String(today.signInStatus ?? '') === '1';
    const outDone = String(today.signBackStatus ?? '') === '1';

    if (inDone && outDone) {
      status.value = 'completed';
      nextScheduledInfo.value = '';
      clearCountdownTarget();
      stopPolling();
      return;
    }

    status.value = 'scheduled';

    if (!inDone) {
      const t = buildTodayDate(today.signInTime);
      if (t) {
        nextScheduledInfo.value = `今天 ${today.signInTime} 签到`;
        setCountdownTarget('sign_in', t.getTime());
        return;
      }
    } else {
      const outTime = today.signBackTime || today.signBackLimitTime;
      if (outTime) {
        const t = buildTodayDate(outTime);
        if (t) {
          nextScheduledInfo.value = `今天 ${outTime} 签退`;
          setCountdownTarget('sign_back', t.getTime());
          return;
        }
      }
    }

    // No actionable timing (e.g. signed in but no sign-back time configured).
    nextScheduledInfo.value = inDone ? '已签到，等待签退' : '等待签到';
    clearCountdownTarget();
    return;
  }

  // 2) No active today task — show the closest scheduled future execution.
  const pend = pendingTasks()
    .map((s) => ({ s, target: Number(s.targetTimestamp || 0) }))
    .filter((x) => x.target > 0)
    .sort((a, b) => a.target - b.target)[0];

  if (pend) {
    status.value = 'scheduled';
    const d = new Date(pend.target);
    const pad = (n) => String(n).padStart(2, '0');
    nextScheduledInfo.value = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${signTypeLabel(pend.s.signType)}`;
    setCountdownTarget(pend.s.signType === '1' ? 'sign_in' : 'sign_back', pend.target);
    return;
  }

  // 3) Nothing actionable.
  status.value = 'scheduled';
  nextScheduledInfo.value = '暂无活动';
  clearCountdownTarget();
  stopPolling();
}

/** Read server state + authoritative status, then update UI. Never executes a sign. */
async function checkAndExec(manual = false) {
  if (!enabled.value || !canExec()) return;

  let today = null;
  try {
    today = await fetchTodayTask();
  } catch (e) { /* fall through — status/authority below still runs */ }

  const server = await fetchServerStatus();
  if (server && Array.isArray(server.tasks)) {
    shadowFromServer(server.tasks);
  }
  if (server && Array.isArray(server.logs)) {
    mergeServerLogs(server.logs);
  }

  if (!_baselineDone) {
    // first read after (re)enabling — record baseline, don't toast history
    for (const s of _scheduled) _lastExec.set(keyOf(s.signType, s.activityId), !!s.executed);
    _baselineDone = true;
  } else {
    detectExecutions();
  }

  recomputeDisplay(today);
  restartPolling();
  scheduleNextWake();

  if (today && Number(today.activityId)) ensureNextActionsScheduled(today);

  if (manual) logManualCheck();
}

/**
 * Day-of self-heal: if the authoritative getSignInTf today-task exposes a next
 * action (e.g. sign-back time that only appears on the activity day) that we
 * never scheduled for the server, push it so the server can execute it. This
 * prevents the "signed in but no auto sign-out" gap when the activity's times
 * are only known day-of. Scheduling is idempotent server-side (keyed + dated).
 */
function ensureNextActionsScheduled(today) {
  if (!isTodayDriving(today)) return;
  const aid = Number(today.activityId);
  const name = today.activityName || `活动${aid}`;
  const inDone = String(today.signInStatus ?? '') === '1';
  const outDone = String(today.signBackStatus ?? '') === '1';
  const have = new Set(_scheduled.map((s) => `${s.signType}-${s.activityId}`));
  const add = [];

  if (!inDone && !have.has(`1-${aid}`)) {
    const t = buildTodayDate(today.signInTime);
    if (t) {
      add.push(normalizeTaskInput(aid, name, '1', today.signInTime, t.getTime(), today.latitude, today.longitude));
    }
  }
  if (!outDone && !have.has(`2-${aid}`)) {
    const outTxt = today.signBackTime || today.signBackLimitTime;
    const t = outTxt ? buildTodayDate(outTxt) : null;
    if (t) {
      add.push(normalizeTaskInput(aid, name, '2', outTxt, t.getTime(), today.latitude, today.longitude));
    }
  }
  if (add.length === 0) return;

  postSchedule(add).then((res) => {
    if (!res) return;
    for (const a of add) _scheduled.push({ ...a, executed: false, result: null });
    const names = add.map((a) => signTypeLabel(a.signType)).join('、');
    addLog('系统', name, true, `已补排${names}（服务端执行）`);
  });
}

/** Give visible feedback when the user clicks "手动检查签到状态". */
function logManualCheck() {
  const failed = firstExecutedFailure();
  if (failed) {
    addLog('检查', failed.activityName || '活动', false, (failed.result && failed.result.msg) || '执行失败');
    return;
  }
  if (status.value === 'completed') {
    addLog('检查', '状态', true, '签到签退均已完成');
    return;
  }
  if (status.value === 'error') {
    addLog('检查', '状态', false, lastError.value || '自动签到异常');
    return;
  }
  const next = pendingTasks()
    .filter((s) => Number(s.targetTimestamp) > 0)
    .sort((a, b) => a.targetTimestamp - b.targetTimestamp)[0];
  if (next) {
    const label = signTypeLabel(next.signType);
    const d = new Date(next.targetTimestamp);
    const pad = (n) => String(n).padStart(2, '0');
    addLog(
      '检查',
      next.activityName || `活动${next.activityId}`,
      true,
      `等待 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${label}`,
    );
    return;
  }
  addLog('检查', '状态', true, nextScheduledInfo.value || '暂无待执行任务');
}

// ---- scheduling plans ----

function normalizeTaskInput(aid, name, signType, signTime, targetTimestamp, latitude, longitude) {
  return {
    activityId: Number(aid),
    activityName: name || '',
    signType: String(signType),
    signTime: signTime || '',
    targetTimestamp: Math.round(Number(targetTimestamp) || 0),
    latitude: String(latitude || ''),
    longitude: String(longitude || ''),
  };
}

/** Build + register server tasks for today's active sign task (from getSignInTf). */
async function planToday(today) {
  const aid = Number(today.activityId);
  const inDone = String(today.signInStatus ?? '') === '1';
  const outDone = String(today.signBackStatus ?? '') === '1';
  const tasks = [];

  if (!inDone && today.signInTime) {
    const d = buildTodayDate(today.signInTime);
    if (d) {
      tasks.push(
        normalizeTaskInput(aid, today.activityName, '1', today.signInTime, d.getTime(), today.latitude, today.longitude),
      );
    }
  }
  if (!outDone) {
    const outTime = today.signBackTime || today.signBackLimitTime;
    if (outTime) {
      const d = buildTodayDate(outTime);
      if (d) {
        tasks.push(
          normalizeTaskInput(aid, today.activityName, '2', outTime, d.getTime(), today.latitude, today.longitude),
        );
      }
    }
  }
  if (tasks.length === 0) return true;

  const res = await postSchedule(tasks);
  if (!res) {
    status.value = 'error';
    lastError.value = '排程发送失败，请检查服务端是否在运行';
    addLog('系统', today.activityName || aid, false, '排程发送失败');
    _scheduled = [];
    return false;
  }

  _scheduled = tasks.map((t) => ({ ...t, executed: false, result: null }));
  const name = today.activityName || aid;
  const label = tasks.length === 2 ? '签到与签退' : signTypeLabel(tasks[0].signType);
  addLog('系统', name, true, `已排程今天${label}（服务端执行）`);
  return true;
}

/** Try queryMyPendingClub / queryClubInfo to find the nearest registered future activity. */
async function extractFutureList() {
  let list = [];
  try {
    const resp = await api.queryMyPendingClub(_studentIdRef.value, 1, 20);
    const d = resp?.data;
    if (Number(d?.code) === 10000) {
      list = extractList(d.response);
    }
  } catch (e) { /* try fallback */ }

  if (list.length === 0) {
    list = await fetchRegisteredFromClubInfo();
  }
  return list;
}

/** Find + schedule the closest future (non-today) registered activity. */
async function planFuture() {
  let list = [];
  try {
    list = await extractFutureList();
  } catch (e) {
    status.value = 'error';
    lastError.value = e.message || '查询失败';
    addLog('系统', '错误', false, '查询已报名活动失败');
    return;
  }

  if (list.length === 0) {
    status.value = 'scheduled';
    nextScheduledInfo.value = '暂无活动';
    addLog('系统', '空闲', true, '当前没有已报名的活动');
    return;
  }

  const now = Date.now();
  let bestItem = null;
  let bestDate = null;
  let bestSignInMs = Infinity;

  for (const item of list) {
    const date =
      parseYymmdd(item.yymmdd || item.activityDate || item.date || item.scheduleDate || '') ||
      parseMmdd(item.mmdd || '');
    if (!date) continue;
    const timeStr = item.startTime || item.activityStartTime || item.start || item.beginTime || '';
    const st = parseTimeStr(timeStr);
    if (!st) continue;

    const startAt = new Date(date);
    startAt.setHours(st.h, st.m, st.s || 0, 0);
    const ms = startAt.getTime();
    if (ms < now - 60 * 60 * 1000) continue; // started over an hour ago — not schedulable
    if (ms < bestSignInMs) {
      bestSignInMs = ms;
      bestItem = item;
      bestDate = date;
    }
  }

  if (!bestItem) {
    status.value = 'scheduled';
    nextScheduledInfo.value = '暂无待执行活动';
    addLog('系统', '空闲', true, '暂无需要自动执行的活动');
    return;
  }

  const aid = Number(bestItem.clubActivityId || bestItem.activityId || bestItem.configurationId || 0);
  if (!aid) {
    status.value = 'scheduled';
    nextScheduledInfo.value = '暂无待执行活动';
    return;
  }

  const name = bestItem.activityName || '';
  const lat = bestItem.latitude || bestItem.lat || '';
  const lng = bestItem.longitude || bestItem.lng || '';
  const startTimeStr = bestItem.startTime || bestItem.activityStartTime || '';
  const tasks = [];

  if (startTimeStr) {
    const t = parseTimeStr(startTimeStr);
    const d = bestDate instanceof Date ? new Date(bestDate) : parseYymmdd(String(bestDate));
    if (t && d) {
      d.setHours(t.h, t.m, t.s || 0, 0);
      tasks.push(normalizeTaskInput(aid, name, '1', startTimeStr, d.getTime(), lat, lng));
    }
  }

  // Fixed-duration club slots often leave signBackTime/signBackLimitTime empty;
  // the sign-out then anchors to the activity endTime (start + fixed interval).
  const outTime = bestItem.signBackTime || bestItem.signBackLimitTime || bestItem.endTime || bestItem.activityEndTime || '';
  if (outTime) {
    const t = parseTimeStr(outTime);
    const d = bestDate instanceof Date ? new Date(bestDate) : parseYymmdd(String(bestDate));
    if (t && d) {
      d.setHours(t.h, t.m, t.s || 0, 0);
      tasks.push(normalizeTaskInput(aid, name, '2', outTime, d.getTime(), lat, lng));
    }
  }

  // Guard: sign-out must land strictly after sign-in, otherwise drop it.
  if (tasks.length === 2 && tasks[1].targetTimestamp <= tasks[0].targetTimestamp) {
    tasks.pop();
  }

  if (tasks.length === 0) {
    status.value = 'scheduled';
    nextScheduledInfo.value = '暂无待执行活动';
    return;
  }

  const res = await postSchedule(tasks);
  if (!res) {
    status.value = 'error';
    lastError.value = '排程发送失败，请检查服务端是否在运行';
    addLog('系统', name || aid, false, '排程发送失败');
    _scheduled = [];
    return false;
  }

  _scheduled = tasks.map((t) => ({ ...t, executed: false, result: null }));
  const next = tasks.sort((a, b) => a.targetTimestamp - b.targetTimestamp)[0];
  const label = signTypeLabel(next.signType);
  const d = new Date(next.targetTimestamp);
  const pad = (n) => String(n).padStart(2, '0');
  nextScheduledInfo.value = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${label}`;
  addLog('系统', name || aid, true, `已排程 ${nextScheduledInfo.value}（服务端执行）`);
  return true;
}

/** Try queryClubInfo for upcoming dates to find registered activities. */
async function fetchRegisteredFromClubInfo() {
  if (!_schoolIdRef?.value) {
    return [];
  }
  const results = [];
  const today = new Date();
  const promises = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = formatDateForApi(date);
    promises.push(
      api
        .queryClubInfo({
          queryTime: dateStr,
          schoolId: _schoolIdRef.value,
          studentId: _studentIdRef.value,
          pageNo: 1,
          pageSize: 20,
        })
        .then((resp) => ({ resp, dateStr }))
        .catch(() => null),
    );
  }
  const settled = await Promise.allSettled(promises);
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { resp } = result.value;
    const d = resp?.data;
    if (Number(d?.code) !== 10000) continue;
    for (const item of extractList(d.response)) {
      if (String(item.optionStatus) === '1') results.push(item);
    }
  }
  return results;
}

/** Extract an array from various API response shapes */
function extractList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const keys = ['records', 'list', 'rows', 'items', 'activityList'];
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

// ---- main entry ----

async function start() {
  if (!canExec()) {
    enabled.value = false;
    persistState();
    return;
  }

  enabled.value = true;
  persistState();
  clearTimers();
  _scheduled = [];
  _lastExec.clear();
  _baselineDone = false;
  lastError.value = '';

  // 1) If there is an active today sign task with a concrete time, plan/schedule it.
  const today = await fetchTodayTask();

  let planned = true;
  if (isTodayDriving(today)) {
    planned = (await planToday(today)) !== false;
  } else {
    // 2) Otherwise look for a registered future activity (has a real start time).
    planned = (await planFuture()) !== false;
  }

  if (!planned) {
    // The server did not accept the schedule — show error, no fake countdown.
    status.value = 'error';
    clearCountdownTarget();
    stopPolling();
    return;
  }

  status.value = status.value === 'error' ? status.value : 'scheduled';
  startCountdownTimer();
  // Sync display with whatever the server already reports, and set the next wake.
  await checkAndExec();
}

function stop() {
  enabled.value = false;
  clearTimers();
  cancelTasksOnBackend();
  status.value = 'idle';
  nextScheduledInfo.value = '';
  _scheduled = [];
  _lastExec.clear();
  _baselineDone = false;
  persistState();
}

function clearTimers() {
  stopPolling();
  clearScheduleTimer();
  stopCountdownTimer();
}

function toggle() {
  if (enabled.value) stop();
  else start();
}

/** Recalculate schedule (call after register/unregister / manual sign). */
async function refresh() {
  if (!enabled.value) return;
  clearTimers();
  await start();
}

function clearLogs() {
  signLog.value = [];
  // keep _serverLogSig so cleared logs do not instantly reappear from the server
}

function resetExecuted() {
  // No local execution state anymore — just resync the display from the server.
  _lastExec.clear();
  _baselineDone = false;
  checkAndExec();
}

// ---- composable ----

export function useClubAutoSign(options = {}) {
  // Lazy-init store refs (must be inside setup context for Pinia)
  if (!_studentIdRef) {
    const { studentId, token, schoolId } = useDataStore();
    _studentIdRef = studentId;
    _tokenRef = token;
    _schoolIdRef = schoolId;
  }

  const { onSignResult } = options;
  _onSignResult = onSignResult || null;

  // Auto-restart if it was enabled before the page refreshed
  if (enabled.value) {
    setTimeout(() => {
      if (enabled.value) start();
    }, 100);
  }

  startCountdownTimer();

  onUnmounted(() => {
    // Only detach the UI callback — state/timers keep running for monitoring
    _onSignResult = null;
  });

  return {
    enabled,
    status,
    signLog,
    lastError,
    nextScheduledInfo,
    countdownDisplay,
    start,
    stop,
    toggle,
    refresh,
    checkAndExec,
    clearLogs,
    resetExecuted,
  };
}

// ---- status display helpers ----

const STATUS_LABEL = {
  idle: '未启用',
  scheduled: '已计划',
  monitoring: '监控中',
  signed_in: '已签到',
  completed: '已完成',
  error: '异常',
};

const STATUS_CLASS = {
  idle: 'border-white/10 bg-white/5 text-gray-300',
  scheduled: 'border-blue-400/30 bg-blue-500/10 text-blue-200',
  monitoring: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200',
  signed_in: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
  completed: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200',
  error: 'border-rose-400/30 bg-rose-500/10 text-rose-200',
};

export function autoSignLabel(s) {
  return STATUS_LABEL[s] || s;
}

export function autoSignClass(s) {
  return STATUS_CLASS[s] || STATUS_CLASS.idle;
}
