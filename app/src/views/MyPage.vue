<template>
  <div class="w-full max-w-3xl mx-auto py-2 px-1 space-y-3">
    <section class="rounded-2xl border border-cyan-400/20 bg-cyan-500/5 px-5 py-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <div
            class="h-11 w-11 rounded-full bg-cyan-500/10 text-cyan-300 flex items-center justify-center"
          >
            <i class="ri-user-3-line text-lg"></i>
          </div>
          <div class="min-w-0">
            <p class="text-base font-bold text-cyan-100 truncate">{{ displayName }}</p>
            <p class="text-xs text-cyan-200/70 truncate">{{ registerCode }}</p>
          </div>
        </div>
        <button
          type="button"
          @click="handleLogout"
          class="shrink-0 text-sm cursor-pointer inline-flex items-center gap-2 bg-cyan-500/10 text-cyan-200 px-5 py-2 rounded-full font-semibold border border-cyan-400/20 transition-colors duration-200 hover:bg-red-500/20 hover:text-red-300 hover:border-red-400/30"
        >
          <span>登出</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useDataStore } from '@/composables/useDataStore';

const { userInfo, clearAllData } = useDataStore();

const displayName = computed(() => userInfo.value?.studentName ?? '');
const registerCode = computed(() => userInfo.value?.registerCode ?? '');

const handleLogout = () => {
  try {
    clearAllData();
  } catch (e) {}
  window.location.reload();
};
</script>
