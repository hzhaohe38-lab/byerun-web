import { ref, onUnmounted } from 'vue';
import { api } from './useApi';
import { useDataStore } from './useDataStore';
import { getSessionToken } from '@/utils/authStorage';

const STORAGE_KEY = 'unirun.club_auto_sign';
const POLL_INTERVAL = 30 * 1000;
const LEAD_MINUTES = 30;
const AUTO_SIGN_API = '/api/auto-sign';

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
let _countdownTarget = null; // { type: 'sign_in'|'sign_back', ms: timestamp }
const _executedSession = new Map(); // key -> timestamp
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

function isTimeReached(timeStr) {
  const target = buildTodayDate(timeStr);
  return target ? Date.now() >= target.getTime() : false;
}

function msUntilTarget(timeStr) {
  const target = buildTodayDate(timeStr);
  if (!target) return Infinity;
  return target.getTime() - Date.now();
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

function formatShort(d) {
  if (!d) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ enabled: enabled.value, executed: [..._executedSession.entries()] }),
    );
  } catch (e) { /* */ }
}

// ---- cleanup ----

/** Remove executed-session entries older than 48 hours to prevent unbounded growth */
function cleanupExecutedSession() {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  for (const [key, ts] of _executedSession.entries()) {
    if (ts < cutoff) _executedSession.delete(key);
  }
}

// Restore persisted state
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const p = JSON.parse(raw);
    enabled.value = p.enabled === true;
    if (Array.isArray(p.executed)) {
      p.executed.forEach(([k, ts]) => _executedSession.set(k, ts));
    }
    cleanupExecutedSession();
  }
} catch (e) { /* */ }

// ---- backend scheduling helpers ----

async function scheduleTasksOnBackend(tasks) {
  try {
    const token = getSessionToken();
    await fetch(AUTO_SIGN_API + '/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks, studentId: _studentIdRef.value, token }),
    });
  } catch (e) { /* backend unreachable — local polling will still try */ }
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

async function execSignOnBackend(signType, task) {
  try {
    const token = getSessionToken();
    const resp = await fetch(AUTO_SIGN_API + '/exec-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentId: _studentIdRef.value,
        token,
        activityId: Number(task.activityId),
        latitude: String(task.latitude || ''),
        longitude: String(task.longitude || ''),
        signType,
        activityName: task.activityName || '',
      }),
    });
    return await resp.json();
  } catch (e) {
    return null;
  }
}

// ---- exec ----

function addLog(action, title, ok, msg) {
  signLog.value.unshift({
    id: Date.now() + Math.random(),
    action,
    title: title || '未知活动',
    time: new Date().toLocaleString(),
    ok,
    msg: msg || '',
  });
  if (signLog.value.length > 50) signLog.value = signLog.value.slice(0, 50);
}

function canExec() {
  return !!(_studentIdRef?.value && _tokenRef?.value);
}

function setCountdownTarget(type, timeStr, baseDate) {
  let target;
  if (baseDate instanceof Date) {
    const t = parseTimeStr(timeStr);
    if (!t) { _countdownTarget = null; countdownDisplay.value = ''; return; }
    target = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), t.h, t.m, t.s, 0);
  } else {
    target = buildTodayDate(timeStr);
  }
  if (!target) { _countdownTarget = null; countdownDisplay.value = ''; return; }
  const ms = target.getTime();
  if (ms - Date.now() > 24 * 60 * 60 * 1000) {
    _countdownTarget = null;
    countdownDisplay.value = '';
    return;
  }
  _countdownTarget = { type, ms };
}

function clearCountdownTarget() {
  _countdownTarget = null;
  countdownDisplay.value = '';
}

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

function tickCountdown() {
  if (!_countdownTarget) { countdownDisplay.value = ''; return; }
  const remaining = _countdownTarget.ms - Date.now();
  if (remaining <= 0) {
    const label = _countdownTarget.type === 'sign_in' ? '签到' : '签退';
    countdownDisplay.value = `${label}执行中...`;
    return;
  }
  const label = _countdownTarget.type === 'sign_in' ? '签到' : '签退';
  countdownDisplay.value = `将在${formatCountdown(remaining)}后执行${label}`;
}

function startCountdownTimer() {
  if (_countdownTimer) return;
  tickCountdown();
  _countdownTimer = setInterval(tickCountdown, 1000);
}

function stopCountdownTimer() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  _countdownTarget = null;
  countdownDisplay.value = '';
}

async function execSign(signType, task) {
  const aid = Number(task.activityId);
  const key = `${signType}-${aid}`;
  if (_executedSession.has(key)) return { skipped: true };
  _executedSession.set(key, Date.now());
  persistState();

  const label = signType === '1' ? '签到' : '签退';
  const name = task.activityName || aid;

  try {
    const result = await execSignOnBackend(signType, task);
    if (!result) {
      _executedSession.delete(key);
      persistState();
      addLog(label, name, false, '后端通信失败');
      return { success: false, msg: '后端通信失败', networkError: true };
    }
    const ok = result.ok === true;
    if (!ok) {
      _executedSession.delete(key);
      persistState();
    }
    addLog(label, name, ok, result.msg || '');
    if (_onSignResult) {
      const msg = `${name} ${label}${ok ? '成功' : '失败'}${result.msg ? '：' + result.msg : ''}`;
      _onSignResult(ok, msg);
    }
    return { success: ok, msg: result.msg || '' };
  } catch (e) {
    _executedSession.delete(key);
    persistState();
    addLog(label, name, false, e.message);
    return { success: false, msg: e.message, networkError: true };
  }
}

/** Check today's sign task and execute if time is right */
async function checkAndExec() {
  if (!canExec()) return;

  try {
    const resp = await api.queryClubSignStatus(_studentIdRef.value);
    const d = resp?.data;
    if (d?.code !== 10000) {
      clearCountdownTarget();
      return;
    }

    const task = d.response;
    if (status.value === 'completed' && !task) return;
    if (!task || !task.activityId || !task.signInTime) {
      clearCountdownTarget();
      await scheduleFuture();
      return;
    }

    const aid = Number(task.activityId);
    const inDone = String(task.signInStatus ?? '') === '1';
    const outDone = String(task.signBackStatus ?? '') === '1';

    // Server confirms both done
    if (inDone && outDone) {
      status.value = 'completed';
      _executedSession.set(`1-${aid}`, Date.now());
      _executedSession.set(`2-${aid}`, Date.now());
      persistState();
      clearCountdownTarget();
      addLog('检查', task.activityName || aid, true, '今日签到签退已完成');
      return;
    }

    // -- Sign-in --
    if (!inDone && !_executedSession.has(`1-${aid}`)) {
      if (isTimeReached(task.signInTime)) {
        const r = await execSign('1', task);
        if (!r.success) { status.value = 'error'; clearCountdownTarget(); return; }
      } else {
        addLog('检查', task.activityName || aid, true, `等待签到(${task.signInTime})`);
      }
    }

    // -- Sign-out --
    if (inDone && !outDone && !_executedSession.has(`2-${aid}`)) {
      const outTime = task.signBackTime || task.signBackLimitTime;
      if (!outTime || isTimeReached(outTime)) {
        const r = await execSign('2', task);
        if (!r.success) { status.value = 'error'; clearCountdownTarget(); return; }
      }
    }

    // -- Set countdown for the next pending action --
    if (!inDone) {
      setCountdownTarget('sign_in', task.signInTime);
    } else if (!outDone) {
      const outTime = task.signBackTime || task.signBackLimitTime;
      if (outTime) setCountdownTarget('sign_back', outTime);
      else clearCountdownTarget();
    } else {
      clearCountdownTarget();
    }

    status.value = 'scheduled';
  } catch (e) {
    console.error('[AutoSign] check error:', e);
    status.value = 'error';
    lastError.value = e.message;
    clearCountdownTarget();
  }
}

/** Try to extract an array from various API response shapes */
function extractList(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const keys = ['records', 'list', 'rows', 'items', 'activityList'];
  for (const key of keys) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

/** Try queryClubInfo for future dates to find registered activities */
async function fetchRegisteredFromClubInfo() {
  if (!_schoolIdRef?.value) {
    console.warn('[AutoSign] no schoolId available');
    return [];
  }
  const results = [];
  const today = new Date();

  // Fetch all 14 days concurrently
  const promises = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = formatDateForApi(date);
    promises.push(
      api.queryClubInfo({
        queryTime: dateStr,
        schoolId: _schoolIdRef.value,
        studentId: _studentIdRef.value,
        pageNo: 1,
        pageSize: 20,
      })
        .then((resp) => ({ resp, dateStr }))
        .catch((e) => {
          console.warn(`[AutoSign] queryClubInfo ${dateStr} error:`, e);
          return null;
        }),
    );
  }

  const settled = await Promise.allSettled(promises);
  for (const result of settled) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { resp, dateStr } = result.value;
    const d = resp?.data;
    if (d?.code !== 10000) continue;
    const dayList = extractList(d.response);
    for (const item of dayList) {
      if (String(item.optionStatus) === '1') {
        results.push(item);
      }
    }
  }
  return results;
}

/** Find next future registered activity and schedule wake-up */
async function scheduleFuture() {
  try {
    let list = [];

    // 1) Try queryMyPendingClub (user's registered activities)
    try {
      const resp = await api.queryMyPendingClub(_studentIdRef.value, 1, 20);
      const d = resp?.data;
      if (d?.code === 10000) {
        list = extractList(d.response);
      }
    } catch (e) {
      console.warn('[AutoSign] queryMyPendingClub failed, trying fallback', e);
    }

    // 2) If empty, try queryClubInfo for upcoming dates
    if (list.length === 0) {
      list = await fetchRegisteredFromClubInfo();
    }

    if (list.length === 0) {
      nextScheduledInfo.value = '暂无活动';
      addLog('系统', '空闲', true, '当前没有已报名的活动');
      return;
    }

    const now = Date.now();
    let bestMs = Infinity;
    let bestInfo = '';
    let bestItem = null;
    let foundAny = false;

    for (const item of list) {
      const date = parseYymmdd(item.yymmdd || item.activityDate || item.date || item.scheduleDate || '')
        || parseMmdd(item.mmdd || '');
      if (!date) continue;
      const timeStr = item.startTime || item.activityStartTime || item.start || item.beginTime || '';
      const st = parseTimeStr(timeStr);
      if (!st) continue;
      foundAny = true;

      const monitorStart = new Date(date);
      monitorStart.setHours(st.h, st.m, 0, 0);
      monitorStart.setMinutes(monitorStart.getMinutes() - LEAD_MINUTES);
      const ms = monitorStart.getTime() - now;
      if (ms <= 0) continue;

      if (ms < bestMs) {
        bestMs = ms;
        bestInfo = `${date.getMonth() + 1}-${date.getDate()} ${timeStr}`;
        bestItem = { item, date, signTimeMs: monitorStart.getTime() + LEAD_MINUTES * 60000 };
      }
    }

    if (bestMs < Infinity) {
      nextScheduledInfo.value = bestInfo;
      status.value = 'scheduled';
      addLog('系统', '已计划', true, `将在 ${bestInfo} 自动签到`);
      clearTimers();
      _scheduleTimer = setTimeout(() => {
        _scheduleTimer = null;
        startPolling();
        checkAndExec();
      }, bestMs);

      if (bestItem) {
        const startTimeStr = bestItem.item.startTime || bestItem.item.activityStartTime || '';
        if (startTimeStr) {
          setCountdownTarget('sign_in', startTimeStr, bestItem.date);
          startCountdownTimer();
        }

        const item = bestItem.item;
        const aid = Number(item.clubActivityId || item.activityId || 0);
        if (aid) {
          const tasks = [{
            activityId: aid,
            activityName: item.activityName || '',
            signType: '1',
            signTime: item.startTime || '',
            targetTimestamp: bestItem.signTimeMs,
            latitude: String(item.latitude || ''),
            longitude: String(item.longitude || ''),
          }];
          const outTime = item.signBackTime || item.signBackLimitTime || item.endTime;
          if (outTime) {
            const t = parseTimeStr(outTime);
            if (t) {
              const outTarget = new Date(bestItem.date.getFullYear(), bestItem.date.getMonth(), bestItem.date.getDate(), t.h, t.m, t.s || 0, 0);
              tasks.push({
                activityId: aid,
                activityName: item.activityName || '',
                signType: '2',
                signTime: outTime,
                targetTimestamp: outTarget.getTime(),
                latitude: String(item.latitude || ''),
                longitude: String(item.longitude || ''),
              });
            }
          }
          scheduleTasksOnBackend(tasks);
        }
      }
    } else {
      nextScheduledInfo.value = foundAny ? '等签到时间' : '暂无活动';
      addLog('系统', foundAny ? '等待中' : '空闲', true, foundAny ? '已报名活动，等待签到时间' : '当前没有已报名的活动');
    }
  } catch (e) {
    console.error('[AutoSign] schedule future error:', e);
    nextScheduledInfo.value = '查询失败';
    addLog('系统', '错误', false, '查询已报名活动失败');
  }
}

function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(checkAndExec, POLL_INTERVAL);
}

/** Main entry — decide what to do now */
async function start() {
  if (!canExec()) {
    enabled.value = false;
    persistState();
    return;
  }

  enabled.value = true;
  clearTimers();
  persistState();

  // 1) Check if there's a today task with times
  try {
    const resp = await api.queryClubSignStatus(_studentIdRef.value);
    const d = resp?.data;
    if (d?.code === 10000) {
      const task = d.response;
      if (task?.activityId && task?.signInTime) {
        // Schedule today's sign-in on backend
        const todayTasks = [{
          activityId: Number(task.activityId),
          activityName: task.activityName || '',
          signType: '1',
          signTime: task.signInTime,
          targetTimestamp: buildTodayDate(task.signInTime).getTime(),
          latitude: String(task.latitude || ''),
          longitude: String(task.longitude || ''),
        }];
        const outTime = task.signBackTime || task.signBackLimitTime;
        if (outTime) {
          todayTasks.push({
            activityId: Number(task.activityId),
            activityName: task.activityName || '',
            signType: '2',
            signTime: outTime,
            targetTimestamp: buildTodayDate(outTime).getTime(),
            latitude: String(task.latitude || ''),
            longitude: String(task.longitude || ''),
          });
        }
        scheduleTasksOnBackend(todayTasks);
        setCountdownTarget('sign_in', task.signInTime);

        const ms = msUntilTarget(task.signInTime);
        const leadMs = Math.max(0, ms - LEAD_MINUTES * 60000);

        if (leadMs > 0) {
          status.value = 'scheduled';
          nextScheduledInfo.value = `今天 ${task.signInTime}`;
          _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            startPolling();
            checkAndExec();
          }, leadMs);
        } else {
          startPolling();
          checkAndExec();
        }
        startCountdownTimer();
        return;
      }
    }
  } catch (e) { /* fall through */ }

  // 2) No active task today — look for future activities
  status.value = 'scheduled';
  await scheduleFuture();
  startCountdownTimer();
}

function stop() {
  enabled.value = false;
  clearTimers();
  cancelTasksOnBackend();
  status.value = 'idle';
  nextScheduledInfo.value = '';
  persistState();
}

function clearTimers() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_scheduleTimer) {
    clearTimeout(_scheduleTimer);
    _scheduleTimer = null;
  }
  stopCountdownTimer();
}

function toggle() {
  if (enabled.value) stop();
  else start();
}

/** Recalculate schedule (call after register/unregister) */
async function refresh() {
  if (!enabled.value) return;
  clearTimers();
  await start();
}

function clearLogs() {
  signLog.value = [];
}

function resetExecuted() {
  _executedSession.clear();
  persistState();
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

  // Auto-restart if was enabled before page refresh
  if (enabled.value) {
    setTimeout(() => {
      if (enabled.value) start();
    }, 100);
  }

  startCountdownTimer();

  onUnmounted(() => {
    // Only detach UI callback — timers keep running for background monitoring
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
