// Auto-sign scheduler Service Worker
const DB_NAME = 'unirun-sign';
const DB_VERSION = 1;
const STORE = 'tasks';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 30000;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    r.onsuccess = (e) => resolve(e.target.result);
    r.onerror = (e) => reject(e.target.error);
  });
}

async function saveTask(t) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(t);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function loadAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = (e) => reject(e.target.error);
  });
}

async function deleteTask(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---- messaging ----
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.type) return;
  if (d.type === 'SCHEDULE_SIGN') {
    scheduleSign(d.payload);
  } else if (d.type === 'CANCEL_ALL_SIGNS') {
    cancelAll();
  } else if (d.type === 'CANCEL_SIGN') {
    cancelSign(d.payload);
  }
});

async function scheduleSign(payload) {
  const task = {
    id: 'sign-' + payload.signType + '-' + payload.activityId,
    activityId: payload.activityId,
    signType: payload.signType,
    activityName: payload.activityName || '',
    targetTimestamp: payload.targetTimestamp,
    requestConfig: payload.requestConfig,
  };
  await saveTask(task);
  setTimer(task);
}

async function cancelAll() {
  const tasks = await loadAll();
  for (const t of tasks) {
    clearTimeout(t._timerId);
    await deleteTask(t.id);
  }
}

async function cancelSign(payload) {
  const id = 'sign-' + payload.signType + '-' + payload.activityId;
  const tasks = await loadAll();
  const task = tasks.find(t => t.id === id);
  if (task) {
    clearTimeout(task._timerId);
    await deleteTask(id);
  }
}

function setTimer(task) {
  const delay = Math.max(0, task.targetTimestamp - Date.now());
  task._timerId = setTimeout(() => execute(task, 0), delay);
}

async function execute(task, retryCount) {
  const rc = task.requestConfig;
  try {
    const res = await fetch(rc.url, {
      method: rc.method || 'POST',
      headers: rc.headers || {},
      body: rc.body ? JSON.stringify(rc.body) : undefined,
    });
    const data = await res.json();
    const ok = data?.code === 10000;
    const label = task.signType === '1' ? '签到' : '签退';
    self.registration.showNotification('自动' + label, {
      body: ok
        ? (task.activityName || '活动') + ' ' + label + '成功'
        : label + '失败：' + (data?.msg || data?.message || '未知错误'),
      icon: '/favicon.ico',
    });
    // Notify page if open
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const c of clients) {
      c.postMessage({
        type: 'SIGN_RESULT',
        payload: {
          activityId: task.activityId,
          signType: task.signType,
          success: ok,
          msg: data?.msg || data?.message || '',
          activityName: task.activityName,
        },
      });
    }
    await deleteTask(task.id);
  } catch (err) {
    // Network error — retry with exponential backoff
    if (retryCount < MAX_RETRIES) {
      const delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), 120000);
      // Update task in DB with incremented retry count so it survives SW restart
      task._retryCount = retryCount + 1;
      task._nextRetryAt = Date.now() + delay;
      await saveTask(task);
      task._timerId = setTimeout(() => execute(task, retryCount + 1), delay);
    } else {
      self.registration.showNotification('自动签到失败', {
        body: (task.activityName || '活动') + '：重试多次仍失败，请手动处理',
        icon: '/favicon.ico',
      });
      await deleteTask(task.id);
    }
  }
}

// Restore pending tasks on wake-up
loadAll().then((tasks) => {
  for (const t of tasks) {
    const delay = t.targetTimestamp - Date.now();
    const retryDelay = t._nextRetryAt ? t._nextRetryAt - Date.now() : null;
    // If task was in retry state, use retry schedule; otherwise use original schedule
    const effectiveDelay = retryDelay != null && retryDelay > 0 ? retryDelay : delay;
    const initialRetry = t._retryCount || 0;

    if (effectiveDelay > 30000) {
      setTimerAt(t, effectiveDelay, initialRetry);
    } else {
      // Execute immediately (including past-due tasks, which run with 0ms delay)
      setTimeout(() => execute(t, initialRetry), Math.max(0, effectiveDelay));
    }
  }
});

function setTimerAt(task, delay, retryCount) {
  task._timerId = setTimeout(() => execute(task, retryCount), delay);
}
