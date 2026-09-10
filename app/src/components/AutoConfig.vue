<template>
  <div class="w-full">
    <div v-if="pinging" class="py-8 flex flex-col items-center justify-center space-y-3">
      <i class="fa-brands fa-connectdevelop text-cyan-300 text-3xl animate-bounce"></i>
      <p class="text-[10px] text-cyan-500/60 font-black tracking-[0.3em] uppercase">连接服务中</p>
    </div>

    <div v-else-if="initError" class="py-8 flex flex-col items-center justify-center space-y-3">
      <i class="fa-solid fa-bomb text-red-400 text-3xl animate-pulse"></i>
      <div class="text-center px-6">
        <p class="text-cyan-200 text-xs font-bold">连接失败</p>
        <p class="text-cyan-500/50 text-[10px] mt-1 line-clamp-2">{{ initError }}</p>
      </div>
      <button
        type="button"
        @click="init"
        class="px-4 py-1.5 text-cyan-200 text-[11px] border border-dashed border-cyan-400/20 rounded-full hover:bg-cyan-500/10 transition-colors"
      >
        重新尝试
      </button>
    </div>

    <div v-else class="space-y-4">
      <div class="flex justify-between items-start gap-3">
        <h2 class="text-sm font-semibold text-cyan-200">定时跑步</h2>
        <div class="flex items-center gap-1.5 justify-end shrink-0">
          <span :class="['text-[10px] font-black px-2 py-1 rounded-md border tracking-wide', enabledLabelClass]">
            {{ enabledLabelText }}
          </span>
          <span :class="['text-[10px] font-black px-2 py-1 rounded-md border tracking-wide', statusLabelClass]">
            {{ statusLabelText }}
          </span>
        </div>
      </div>

      <div class="space-y-3">
        <div>
          <div class="flex items-baseline justify-between gap-2 mb-1.5">
            <label class="block text-sm text-cyan-200 font-medium shrink-0">学校地图</label>
            <span class="text-[10px] text-cyan-500/50 font-mono truncate">{{ planLabel }}</span>
          </div>
          <div
            class="route-dropdown bg-cyan-950/60 border border-cyan-400/15 rounded-md p-2 cursor-pointer relative w-full box-border"
            @click="mapsLoaded ? (showMapList = !showMapList) : null"
          >
            <div class="flex items-center justify-between text-sm text-cyan-200" :class="{ disabled: !mapsLoaded }">
              <span v-if="!mapsLoaded">加载地图中...</span>
              <span v-else>{{ currentMapName }}</span>
              <div v-if="mapsLoaded" class="dropdown-arrow" :class="{ active: showMapList }"></div>
            </div>
            <div v-show="showMapList && mapsLoaded" class="route-options">
              <div
                v-for="map in maps"
                :key="map.id"
                class="route-option"
                :class="{ selected: String(form.mapId) === String(map.id) }"
                @click.stop="selectMap(map)"
              >
                {{ map.name }}
              </div>
              <div v-if="!maps.length" class="route-option disabled">无可用地图</div>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm text-cyan-200 mb-1.5 font-medium">随机时间窗</label>
          <div class="flex items-center gap-2">
            <TimeSelect v-model="timeStart" label="起" />
            <span class="text-cyan-500/40 font-bold">—</span>
            <TimeSelect v-model="timeEnd" label="止" />
          </div>
          <p class="text-[9px] text-cyan-500/50 ml-1 pt-1.5">
            将在合理范围内随机抽取里程，并自动采用合理配速
          </p>
        </div>

        <div @click="form.enabled = !form.enabled" class="flex items-center justify-between p-1 cursor-pointer group">
          <span class="text-[11px] font-bold text-gray-500 group-hover:text-cyan-200 transition-colors">开启定时</span>
          <div :class="['w-9 h-5 rounded-full transition-all relative', form.enabled ? 'bg-cyan-400' : 'bg-cyan-500/20']">
            <div
              :class="[
                'absolute top-1 w-3 h-3 rounded-full transition-all',
                form.enabled ? 'left-5 bg-cyan-950' : 'left-1 bg-cyan-300/70',
              ]"
            ></div>
          </div>
        </div>

        <p class="text-[9px] leading-relaxed ml-1 text-orange-300/80">
          开启后到点会自动提交，记录会写进你的跑步成绩。
        </p>

        <div v-if="status.configured && lastResult" class="border-t border-dashed border-cyan-400/15 pt-2 space-y-0.5">
          <p class="text-[10px] text-cyan-500/50 uppercase tracking-widest font-black ml-1">最近一次</p>
          <p :class="['text-[10px] ml-1 break-all', lastResult.ok ? 'text-emerald-400/90' : 'text-red-400/90']">
            {{ lastResult.msg || '—' }}
          </p>
        </div>
      </div>

      <button
        type="button"
        @click="handleSave"
        :disabled="submitting"
        class="w-full p-2 text-cyan-100 bg-cyan-500/10 border border-cyan-400/20 rounded-full hover:bg-cyan-500/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <i v-if="submitting" class="fa-solid fa-circle-notch fa-spin"></i>
        <i v-else class="fa-solid fa-floppy-disk"></i>
        <span>{{ submitting ? '保存中...' : '保存配置' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, inject, onMounted, onUnmounted } from 'vue';
import { useDataStore } from '@/composables/useDataStore';
import TimeSelect from '@/components/TimeSelect.vue';

defineProps({
  inline: { type: Boolean, default: true },
});
const emit = defineEmits(['saved']);
const showMessage = inject('showMessage', (msg) => alert(msg));

const { token, userId, studentId, schoolId, runStandard, userInfo, submitRunRoute } = useDataStore();

const API_ROOT = '/api/auto-run';
const DEFAULT_WINDOW = { h: 8, m: 0 };
const DEFAULT_WINDOW_END = { h: 22, m: 0 };
const STATUS_POLL_MS = 15000;

const pinging = ref(true);
const initError = ref(null);
const submitting = ref(false);
const showMapList = ref(false);

const maps = ref([]);
const status = ref({ configured: false });
const form = reactive({
  mapId: '',
  enabled: false,
});

const timeStart = ref({ ...DEFAULT_WINDOW });
const timeEnd = ref({ ...DEFAULT_WINDOW_END });

let pollTimer = null;

const mapsLoaded = computed(() => maps.value.length > 0);

const pad2 = (n) => String(n).padStart(2, '0');
const toHm = ({ h, m }) => `${pad2(h)}:${pad2(m)}`;
const toMinutes = ({ h, m }) => h * 60 + m;

const parseHm = (value, fallback) => {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { ...fallback };
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return { ...fallback };
  return { h, m };
};

const apiFetch = async (path, options = {}) => {
  const resp = await fetch(`${API_ROOT}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await resp.json();
  } catch (e) {
    payload = null;
  }
  if (!resp.ok) {
    throw new Error(payload?.msg || `服务端返回 ${resp.status}`);
  }
  return payload || {};
};

const currentMapName = computed(() => {
  const selected = maps.value.find((m) => String(m.id) === String(form.mapId));
  return selected ? selected.name : '—';
});

const planLabel = computed(() => {
  if (!status.value.configured) return '尚未排程';
  const today = status.value.today || {};
  if (!status.value.config?.enabled) return '定时已关闭';
  return `今日 ${pad2(today.hour || 0)}:${pad2(today.minute || 0)} · 约 ${today.distance || 0}m`;
});

const enabledLabelText = computed(() => (form.enabled ? '已启用' : '未启用'));
const enabledLabelClass = computed(() =>
  form.enabled
    ? 'text-cyan-300 border-cyan-500/30 bg-cyan-500/10'
    : 'text-gray-500 border-stone-600/40 bg-stone-700/20',
);

const lastResult = computed(() => status.value.lastResult || null);
const statusLabelText = computed(() =>
  status.value.executedToday ? '已完成' : status.value.configured ? '待执行' : '未配置',
);
const statusLabelClass = computed(() =>
  status.value.executedToday
    ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
    : 'text-orange-300 border-orange-500/30 bg-orange-500/10',
);

// fillForm is opt-in: the 15s poll must never write the form, or it would
// silently revert edits the user hasn't saved yet.
const applyStatus = (payload, { fillForm = false } = {}) => {
  if (!payload || payload.code !== 10000) return;
  status.value = payload;
  maps.value = Array.isArray(payload.maps) ? payload.maps : [];
  if (!fillForm) return;

  const cfg = payload.config;
  if (payload.configured && cfg) {
    form.mapId = cfg.mapId;
    form.enabled = !!cfg.enabled;
    Object.assign(timeStart.value, parseHm(cfg.windowStart, DEFAULT_WINDOW));
    Object.assign(timeEnd.value, parseHm(cfg.windowEnd, DEFAULT_WINDOW_END));
    return;
  }

  // Not configured yet — seed sensible defaults.
  // Prefer the map the user already runs on manually; the backend's map list is
  // alphabetical, so maps[0] would otherwise be an unrelated school.
  const lastRoute = String(submitRunRoute.value || '').trim();
  form.mapId = maps.value.some((m) => m.id === lastRoute) ? lastRoute : maps.value[0]?.id || '';
  form.enabled = false;
  Object.assign(timeStart.value, DEFAULT_WINDOW);
  Object.assign(timeEnd.value, DEFAULT_WINDOW_END);
};

const refreshStatus = async () => {
  if (!studentId.value) return;
  const payload = await apiFetch(`/status?studentId=${encodeURIComponent(studentId.value)}`);
  applyStatus(payload);
};

const init = async () => {
  pinging.value = true;
  initError.value = null;

  try {
    if (!studentId.value || !token.value) throw new Error('未登录，无法读取学号或登录凭证');
    const payload = await apiFetch(`/status?studentId=${encodeURIComponent(studentId.value)}`);
    applyStatus(payload, { fillForm: true });
  } catch (err) {
    console.error('AutoRun init error:', err);
    initError.value = err.message || 'Unknown error';
  } finally {
    pinging.value = false;
  }
};

const buildPayload = () => ({
  studentId: studentId.value,
  userId: userId.value,
  token: token.value,
  schoolId: schoolId.value,
  gender: userInfo.value?.gender ?? userInfo.value?.sex ?? '',
  runStandard: runStandard.value || {},
  mapId: form.mapId,
  windowStart: toHm(timeStart.value),
  windowEnd: toHm(timeEnd.value),
  enabled: form.enabled,
});

const handleSave = async () => {
  if (!form.mapId) {
    showMessage('请选择学校地图', 'error');
    return;
  }
  if (toMinutes(timeStart.value) >= toMinutes(timeEnd.value)) {
    showMessage('结束时间需晚于开始时间', 'error');
    return;
  }

  submitting.value = true;
  try {
    const resp = await apiFetch('/config', {
      method: 'POST',
      body: JSON.stringify(buildPayload()),
    });
    applyStatus(resp, { fillForm: true });
    // SubmitRun owns the save toast (its @saved handler); don't double up.
    emit('saved');
  } catch (err) {
    showMessage(err.message || '保存失败', 'error');
  } finally {
    submitting.value = false;
  }
};

const selectMap = (map) => {
  form.mapId = map.id;
  showMapList.value = false;
};

onMounted(() => {
  init();
  // Keep the "最近一次 / 今日计划" readout fresh — the server executes
  // independently of this page, so the panel only ever polls.
  pollTimer = setInterval(() => {
    if (!pinging.value && !initError.value && !submitting.value) {
      refreshStatus().catch(() => {});
    }
  }, STATUS_POLL_MS);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.route-dropdown {
  position: relative;
  user-select: none;
  box-sizing: border-box;
  overflow: visible;
}

.dropdown-arrow {
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 6px solid #22d3ee;
  margin-left: 8px;
  transition: transform 0.2s;
}

.dropdown-arrow.active {
  transform: rotate(180deg);
}

.route-options {
  position: absolute;
  left: 0;
  right: 0;
  top: 110%;
  border-radius: 8px;
  z-index: 9999;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  padding: 4px 0;
  max-height: 200px;
  overflow-y: auto;
}

.route-option {
  padding: 8px 16px;
  font-size: 13px;
  background: #042f2e;
  color: #2dd4bf;
  cursor: pointer;
  transition: all 0.2s;
}

.route-option.selected,
.route-option:hover {
  background: #042f2e;
  color: #2dd4bf;
}

.route-option.disabled {
  opacity: 0.5;
  cursor: default;
}

.route-options::-webkit-scrollbar {
  width: 4px;
}

.route-options::-webkit-scrollbar-thumb {
  background: #115e59;
  border-radius: 10px;
}

.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
