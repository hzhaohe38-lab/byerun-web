<template>
  <div class="h-full min-h-0 flex flex-col bg-transparent overflow-hidden">
    <AppHeader ref="appHeaderRef" :scrolled="headerCompact" />

    <div class="flex-1 flex flex-col min-h-0 w-full mx-auto p-0 relative bg-transparent">
      <main
        ref="mainScrollRef"
        class="main-scroll-area relative overflow-y-auto w-full box-border px-4"
        :style="{
          paddingTop: `${headerHeight}px`,
          paddingBottom: `${bottomBarOverlayHeight + BOTTOM_BAR_CLEARANCE_GAP}px`,
        }"
        @scroll.passive="handleMainScroll"
      >
        <keep-alive>
          <RunRecords v-if="activeKey === 'records'" :key="'records'" />
          <Club v-else-if="activeKey === 'club'" :key="'club'" />
          <SubmitRun
            v-else-if="activeKey === 'submit'"
            :key="'submit'"
            @submitted="handleRunSubmitted"
          />
          <MyPage v-else-if="activeKey === 'my'" :key="'my'" />
        </keep-alive>
      </main>
    </div>

    <BottomTabBar
      ref="bottomBarRef"
      :active="activeKey"
      @update:active="setActiveKey"
    />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch, provide, inject } from 'vue';
import RunRecords from '@/components/RunRecords.vue';
import Club from '@/components/Club.vue';
import SubmitRun from '@/components/SubmitRun.vue';
import AppHeader from '@/components/layout/AppHeader.vue';
import BottomTabBar from '@/components/layout/BottomTabBar.vue';
import MyPage from '@/views/MyPage.vue';
import { useDataStore } from '@/composables/useDataStore';
import { useApiRequestGate } from '@/composables/useApiRequestGate';
import { getViewportMetrics } from '@/utils/viewport';

const { fetchUserData, activeTab, userInfo } = useDataStore();
const { waitForIdle } = useApiRequestGate();
const rootShowMessage = inject('showMessage', null);

const appHeaderRef = ref(null);
const bottomBarRef = ref(null);
const mainScrollRef = ref(null);
const HEADER_RESERVED_SPACE = 56;
const DEFAULT_BOTTOM_BAR_OVERLAY_HEIGHT = 96;
const BOTTOM_BAR_CLEARANCE_GAP = 12;
const headerHeight = ref(HEADER_RESERVED_SPACE);
const bottomBarOverlayHeight = ref(DEFAULT_BOTTOM_BAR_OVERLAY_HEIGHT);
const headerCompact = ref(false);
// Persisted `activeTab` may hold a value that no longer has a tab (e.g. a stale
// 'chat' from before the message page was removed). Anything outside this list
// would match no branch in <keep-alive> and render a blank main area.
const VALID_TABS = ['club', 'records', 'submit', 'my'];
const resolveValidTab = (key) => (VALID_TABS.includes(key) ? key : 'submit');
const activeKey = ref(resolveValidTab(activeTab.value));
let homeMeasureFrame = 0;

function updateHeaderCompact(top) {
  const next = Number(top) > 6;
  if (next === headerCompact.value) return false;
  headerCompact.value = next;
  return true;
}

function handleMainScroll(event) {
  const top = event?.target?.scrollTop || 0;
  updateHeaderCompact(top);
}

function setActiveKey(key) {
  if (!key || key === activeKey.value) return;
  activeKey.value = resolveValidTab(key);
  activeTab.value = activeKey.value;
}

function measureHeights() {
  const bottomEl = bottomBarRef.value && (bottomBarRef.value.$el || bottomBarRef.value);
  headerHeight.value = HEADER_RESERVED_SPACE;

  if (bottomEl?.getBoundingClientRect) {
    const rect = bottomEl.getBoundingClientRect();
    const { visibleBottom } = getViewportMetrics();
    const overlayHeight = Math.max(0, Math.ceil(visibleBottom - rect.top));
    bottomBarOverlayHeight.value = overlayHeight || DEFAULT_BOTTOM_BAR_OVERLAY_HEIGHT;
  }
}

function scheduleMeasureHeights() {
  if (homeMeasureFrame) cancelAnimationFrame(homeMeasureFrame);
  homeMeasureFrame = requestAnimationFrame(() => {
    measureHeights();
    homeMeasureFrame = 0;
  });
}

function showMessage(message, type = 'info') {
  if (appHeaderRef.value?.show) {
    appHeaderRef.value.show(message, type);
    return;
  }

  if (typeof rootShowMessage === 'function') {
    rootShowMessage(message, type);
  }
}

async function refreshUserData(options = { background: true }) {
  if (!userInfo.value) return true;

  const result = await fetchUserData(options);
  if (result?.ok) return true;

  if (result?.reason === 'network_error') {
    showMessage('用户数据刷新失败', 'warning');
    return false;
  }

  showMessage(result?.message || '登录状态校验失败', 'error');
  return false;
}

async function initializePage() {
  await refreshUserData({ background: false });
  await waitForIdle();
}

async function handleRunSubmitted() {
  await refreshUserData({ background: true });
}

provide('showMessage', showMessage);

watch(
  activeKey,
  async () => {
    await nextTick();
    updateHeaderCompact(mainScrollRef.value?.scrollTop || 0);
    scheduleMeasureHeights();
  },
  { flush: 'post' },
);

onMounted(() => {
  initializePage().catch(() => {
    showMessage('用户数据刷新失败', 'warning');
  });

  scheduleMeasureHeights();
  window.addEventListener('resize', scheduleMeasureHeights);
  window.addEventListener('orientationchange', scheduleMeasureHeights);
  window.visualViewport?.addEventListener('resize', scheduleMeasureHeights);
  window.visualViewport?.addEventListener('scroll', scheduleMeasureHeights);

  nextTick(() => {
    updateHeaderCompact(mainScrollRef.value?.scrollTop || 0);
  });
});

onUnmounted(() => {
  window.removeEventListener('resize', scheduleMeasureHeights);
  window.removeEventListener('orientationchange', scheduleMeasureHeights);
  window.visualViewport?.removeEventListener('resize', scheduleMeasureHeights);
  window.visualViewport?.removeEventListener('scroll', scheduleMeasureHeights);

  if (homeMeasureFrame) {
    cancelAnimationFrame(homeMeasureFrame);
    homeMeasureFrame = 0;
  }
});
</script>

<style scoped>
.main-scroll-area {
  flex: 1 1 auto;
  min-height: 0;
  -webkit-overflow-scrolling: touch;
}
</style>
