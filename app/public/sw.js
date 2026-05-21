// Auto-sign scheduler Service Worker
const DB_NAME = 'unirun-sign';
const DB_VERSION = 1;
const STORE = 'tasks';

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

function setTimer(task) {
  const delay = Math.max(0, task.targetTimestamp - Date.now());
  task._timerId = setTimeout(async () => {
    await execute(task);
    await deleteTask(task.id);
  }, delay);
}

async function execute(task) {
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
  } catch (err) {
    self.registration.showNotification('自动签到异常', {
      body: (task.activityName || '活动') + '：网络错误，请检查网络后重试',
      icon: '/favicon.ico',
    });
  }
}

// Restore pending tasks on wake-up
loadAll().then((tasks) => {
  for (const t of tasks) {
    const delay = t.targetTimestamp - Date.now();
    if (delay > 30000) {
      setTimer(t);
    } else if (delay > 0) {
      // Within 30s, execute directly
      setTimeout(() => execute(t), delay);
    } else {
      // Past due — clean up
      deleteTask(t.id);
    }
  }
});
