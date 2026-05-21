import { ref, onUnmounted } from 'vue';
import { api } from './useApi';
import { useDataStore } from './useDataStore';
import { genSign } from '@/utils/sign';
import { appConfig } from '@/utils/config';
import { getSessionToken } from '@/utils/authStorage';

const SW_PATH = '/sw.js';

const STORAGE_KEY = 'unirun.club_auto_sign';
const POLL_INTERVAL = 30 * 1000;
const LEAD_MINUTES = 30;

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

// ---- composable ----

export function useClubAutoSign() {
  const { studentId, token, schoolId } = useDataStore();

  const enabled = ref(false);
  const status = ref('idle');
  const signLog = ref([]);
  const lastError = ref('');
  const nextScheduledInfo = ref('');

  let pollTimer = null;
  let scheduleTimer = null;
  const executedInSession = new Set();

  // Restore persisted state
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      enabled.value = p.enabled === true;
      if (Array.isArray(p.executed)) p.executed.forEach((k) => executedInSession.add(k));
    }
  } catch (e) { /* */ }

  function persistState() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled: enabled.value, executed: [...executedInSession] }),
      );
    } catch (e) { /* */ }
  }

  function clearTimers() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
  }

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
    return !!(studentId?.value && token?.value);
  }

  // ---- Service Worker ----

  let swRegistration = null;
  let swReady = false;

  async function registerSw() {
    if (swReady || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    try {
      swRegistration = await navigator.serviceWorker.register(SW_PATH);
      swReady = true;
      // Request notification permission (needed for SW to show sign results)
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      // Listen for messages from SW
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'SIGN_RESULT') {
          const p = event.data.payload;
          addLog(p.signType === '1' ? '签到' : '签退', p.activityName || '', p.success, p.msg);
          if (p.success && p.signType === '2') status.value = 'completed';
          if (p.success && p.signType === '1') status.value = 'signed_in';
        }
      });
    } catch (e) {
      // SW not supported, in-page timer works fine
    }
  }

  function sendToSw(info) {
    if (!swReady || !swRegistration?.active) return;
    swRegistration.active.postMessage(info);
  }

  function cancelSwTasks() {
    if (!swReady) return;
    sendToSw({ type: 'CANCEL_ALL_SIGNS' });
  }

  function scheduleSwSign(item, signTimeMs) {
    const aid = Number(item.clubActivityId || item.activityId || 0);
    if (!aid) return;
    const rc = computeRequestConfig(aid, item.latitude || '', item.longitude || '', '1', studentId.value);
    sendToSw({
      type: 'SCHEDULE_SIGN',
      payload: {
        activityId: aid,
        signType: '1',
        activityName: item.activityName || '',
        targetTimestamp: signTimeMs,
        requestConfig: rc,
      },
    });
  }

  function computeRequestConfig(activityId, latitude, longitude, signType, studentIdVal) {
    const body = {
      activityId: Number(activityId),
      latitude: String(latitude || ''),
      longitude: String(longitude || ''),
      signType,
      studentId: studentIdVal,
    };
    const sign = genSign(null, body);
    const token = getSessionToken();
    return {
      url: appConfig.api.baseUrl + appConfig.api.endpoints.clubSignAction,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        appKey: appConfig.auth.appKey,
        sign,
        ...(token ? { token } : {}),
      },
      body,
    };
  }

  // ---- exec ----

  async function execSign(signType, task) {
    const aid = Number(task.activityId);
    const key = `${signType}-${aid}`;
    if (executedInSession.has(key)) return { skipped: true };
    executedInSession.add(key);
    persistState();

    const label = signType === '1' ? '签到' : '签退';
    const name = task.activityName || aid;

    try {
      const resp = await api.signInOrSignBack({
        activityId: aid,
        latitude: String(task.latitude || ''),
        longitude: String(task.longitude || ''),
        signType,
        studentId: studentId.value,
      });
      const d = resp?.data;
      const ok = d?.code === 10000;
      addLog(label, name, ok, d?.msg || d?.message || '');
      return { success: ok, msg: d?.msg || d?.message };
    } catch (e) {
      // Network error — don't mark executed, allow retry
      executedInSession.delete(key);
      persistState();
      addLog(label, name, false, e.message);
      return { success: false, msg: e.message, networkError: true };
    }
  }

  /** Check today's sign task and execute if time is right */
  async function checkAndExec() {
    if (!canExec()) return;

    try {
      const resp = await api.queryClubSignStatus(studentId.value);
      const d = resp?.data;
      if (d?.code !== 10000) {
        return;
      }

      const task = d.response;
      // Valid today's task must have activityId AND signInTime
      if (!task || !task.activityId || !task.signInTime) {
        await scheduleFuture();
        return;
      }

      const aid = Number(task.activityId);
      const inDone = String(task.signInStatus ?? '') === '1';
      const outDone = String(task.signBackStatus ?? '') === '1';

      // Server confirms both done
      if (inDone && outDone) {
        status.value = 'completed';
        executedInSession.add(`1-${aid}`);
        executedInSession.add(`2-${aid}`);
        persistState();
        addLog('检查', task.activityName || aid, true, '今日签到已完成');
        return;
      }

      // -- Sign-in --
      if (!inDone && !executedInSession.has(`1-${aid}`)) {
        if (isTimeReached(task.signInTime)) {
          const r = await execSign('1', task);
          if (r.success) status.value = 'signed_in';
          else if (r.networkError) status.value = 'monitoring';
          else status.value = 'error';
        } else {
          status.value = 'monitoring';
          addLog('检查', task.activityName || aid, true, `等待签到(${task.signInTime})`);
        }
        return;
      }

      // -- Sign-out --
      if (inDone && !outDone && !executedInSession.has(`2-${aid}`)) {
        const outTime = task.signBackTime || task.signBackLimitTime;
        if (!outTime || isTimeReached(outTime)) {
          const r = await execSign('2', task);
          status.value = r.success ? 'completed' : 'error';
        } else {
          status.value = 'signed_in';
        }
        return;
      }

      status.value = 'completed';
    } catch (e) {
      console.error('[AutoSign] check error:', e);
      status.value = 'error';
      lastError.value = e.message;
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
    if (!schoolId?.value) {
      console.warn('[AutoSign] no schoolId available');
      return [];
    }
    const results = [];
    const today = new Date();
    console.log('[AutoSign] fetchRegisteredFromClubInfo starting, schoolId:', schoolId.value);

    for (let i = 0; i < 14; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dateStr = formatDateForApi(date);
      try {
        const resp = await api.queryClubInfo({
          queryTime: dateStr,
          schoolId: schoolId.value,
          studentId: studentId.value,
          pageNo: 1,
          pageSize: 20,
        });
        const d = resp?.data;
        console.log(`[AutoSign] queryClubInfo ${dateStr}: code=${d?.code}, hasResponse=`, !!d?.response);
        if (d?.code !== 10000) continue;
        const dayList = extractList(d.response);
        console.log(`[AutoSign] ${dateStr} items:`, dayList.length, dayList.length > 0 ? Object.keys(dayList[0]) : 'empty', dayList.map(item => ({ id: item.activityId || item.clubActivityId, name: item.activityName, optStatus: item.optionStatus, yymmdd: item.yymmdd, mmdd: item.mmdd, startTime: item.startTime })));
        for (const item of dayList) {
          if (String(item.optionStatus) === '1') {
            console.log(`[AutoSign] FOUND registered activity on ${dateStr}:`, item.activityName, item.activityId, 'yymmdd:', item.yymmdd, 'startTime:', item.startTime);
            results.push(item);
          }
        }
      } catch (e) {
        console.warn(`[AutoSign] queryClubInfo ${dateStr} error:`, e);
      }
    }
    console.log('[AutoSign] fetchRegisteredFromClubInfo results:', results.length, results.map(r => ({ name: r.activityName, date: r.yymmdd, time: r.startTime })));
    return results;
  }

  /** Find next future registered activity and schedule wake-up */
  async function scheduleFuture() {
    try {
      let list = [];

      // 1) Try queryMyPendingClub (user's registered activities)
      try {
        const resp = await api.queryMyPendingClub(studentId.value, 1, 20);
        const d = resp?.data;
        console.log('[AutoSign] queryMyPendingClub: code=', d?.code, 'hasResponse=', !!d?.response);
        if (d?.code === 10000) {
          list = extractList(d.response);
          console.log('[AutoSign] queryMyPendingClub items:', list.length, list.length > 0 ? Object.keys(list[0]) : 'empty', list.map(item => ({ id: item.activityId, name: item.activityName, optStatus: item.optionStatus, yymmdd: item.yymmdd, mmdd: item.mmdd, startTime: item.startTime })));
        }
      } catch (e) {
        console.warn('[AutoSign] queryMyPendingClub failed, trying fallback', e);
      }

      // 2) If empty, try queryClubInfo for upcoming dates (registered activities)
      if (list.length === 0) {
        console.log('[AutoSign] queryMyPendingClub empty, trying queryClubInfo fallback');
        list = await fetchRegisteredFromClubInfo();
      }

      if (list.length === 0) {
        console.log('[AutoSign] no activities found from any source');
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
        if (!date) {
          console.log('[AutoSign] skip item - no valid date:', item.activityName, 'date fields:', { yymmdd: item.yymmdd, activityDate: item.activityDate, date: item.date, scheduleDate: item.scheduleDate, mmdd: item.mmdd });
          continue;
        }
        const timeStr = item.startTime || item.activityStartTime || item.start || item.beginTime || '';
        const st = parseTimeStr(timeStr);
        if (!st) {
          console.log('[AutoSign] skip item - no valid time:', item.activityName, 'time fields:', { startTime: item.startTime, activityStartTime: item.activityStartTime, start: item.start, beginTime: item.beginTime });
          continue;
        }
        foundAny = true;

        const monitorStart = new Date(date);
        monitorStart.setHours(st.h, st.m, 0, 0);
        monitorStart.setMinutes(monitorStart.getMinutes() - LEAD_MINUTES);
        const ms = monitorStart.getTime() - now;
        console.log('[AutoSign] item:', item.activityName, 'date:', date, 'time:', timeStr, 'ms to monitor:', ms);
        if (ms <= 0) {
          console.log('[AutoSign] skip item - already past monitor time');
          continue;
        }

        if (ms < bestMs) {
          bestMs = ms;
          bestInfo = `${date.getMonth() + 1}-${date.getDate()} ${timeStr}`;
          bestItem = { item, signTimeMs: monitorStart.getTime() + LEAD_MINUTES * 60000 };
        }
      }

      console.log('[AutoSign] schedule result: foundAny=', foundAny, 'bestMs=', bestMs, 'bestInfo=', bestInfo);

      if (bestMs < Infinity) {
        nextScheduledInfo.value = bestInfo;
        status.value = 'scheduled';
        addLog('系统', '已计划', true, `将在 ${bestInfo} 自动签到`);
        clearTimers();
        scheduleTimer = setTimeout(() => {
          scheduleTimer = null;
          startPolling();
          checkAndExec();
        }, bestMs);

        // Also send to Service Worker for background execution
        if (bestItem) {
          scheduleSwSign(bestItem.item, bestItem.signTimeMs);
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

  function formatDateForApi(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function startPolling() {
    if (pollTimer) return;
    status.value = 'monitoring';
    pollTimer = setInterval(checkAndExec, POLL_INTERVAL);
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
    status.value = 'monitoring'; // show active state immediately, refine via API

    // Register Service Worker for background scheduling
    registerSw();

    // 1) Check if there's a today task with times
    try {
      const resp = await api.queryClubSignStatus(studentId.value);
      const d = resp?.data;
      if (d?.code === 10000) {
        const task = d.response;
        if (task?.activityId && task?.signInTime) {
          const ms = msUntilTarget(task.signInTime);
          const leadMs = Math.max(0, ms - LEAD_MINUTES * 60000);

          if (leadMs > 0) {
            // Sign-in is still ahead — wait until LEAD_MINUTES before
            status.value = 'scheduled';
            nextScheduledInfo.value = `今天 ${task.signInTime}`;
            scheduleTimer = setTimeout(() => {
              scheduleTimer = null;
              startPolling();
              checkAndExec();
            }, leadMs);
          } else {
            // Already in the window — start monitoring now
            startPolling();
            checkAndExec();
          }
          return;
        }
      }
    } catch (e) { /* fall through */ }

    // 2) No active task today — look for future activities
    await scheduleFuture();
  }

  function stop() {
    enabled.value = false;
    clearTimers();
    cancelSwTasks();
    status.value = 'idle';
    nextScheduledInfo.value = '';
    persistState();
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
    executedInSession.clear();
    persistState();
  }

  // Auto-restart if was enabled before page refresh
  if (enabled.value) {
    setTimeout(() => {
      if (enabled.value) start();
    }, 100);
  }

  onUnmounted(clearTimers);

  return {
    enabled,
    status,
    signLog,
    lastError,
    nextScheduledInfo,
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
