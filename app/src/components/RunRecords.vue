<template>
  <div class="relative w-full box-border">
    <div class="relative flex flex-col">
      <div v-if="records.length > 0 || loading" class="w-full" ref="scrollableListRef">
        <div class="flex flex-col gap-3">
          <div
            v-for="(record, index) in loading ? Array(5).fill(null) : records"
            :key="loading ? index : record.key"
            :class="[
              'rounded-lg overflow-hidden mb-4 transition-shadow p-0 flex flex-col',
              loading
                ? 'bg-stone-900 border border-transparent'
                : record?.runStatus === '1'
                  ? 'bg-cyan-500/5 border border-cyan-400/20'
                  : 'bg-red-500/5 border border-red-400/30',
            ]"
          >
            <div
              :class="['flex justify-between items-center rounded-t-lg px-4 pt-4 pb-2', record?.runStatus === '1' ? 'bg-cyan-500/10 border-b border-cyan-400/15' : 'bg-red-500/10 border-b border-red-400/25']"
            >
              <div :class="['font-semibold text-base', record?.runStatus === '1' ? 'text-cyan-100' : 'text-red-100']">
                <span v-if="!loading">{{ formatCreateTime(record.createTime) }}</span>
                <div
                  v-else
                  class="inline-block bg-slate-300/30 rounded animate-pulse"
                  style="width: 140px; height: 20px"
                ></div>
              </div>
              <div :class="['text-sm flex items-center', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">
                <span
                  v-if="!loading"
                  class="defeated-info"
                  :class="[record.runStatus === '1' ? 'status-success-bg' : 'status-error-bg']"
                  >{{ record.defeatedInfo }}</span
                >
                <div
                  v-else
                  class="inline-block bg-slate-200 rounded-full animate-pulse"
                  style="width: 60px; height: 20px"
                ></div>
              </div>
            </div>
            <div
              :class="['flex justify-between items-center px-4 py-1.5 text-sm', record?.runStatus === '1' ? 'border-b border-cyan-400/10' : 'border-b border-red-400/15']"
            >
              <div :class="['text-sm', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">跑步里程</div>
              <div :class="['text-sm font-medium text-right min-w-[60px]', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">
                <span v-if="!loading">{{ (record.runDistance / 1000).toFixed(2) }}km</span>
                <div
                  v-else
                  class="inline-block bg-slate-200 rounded animate-pulse"
                  style="width: 80px; height: 16px"
                ></div>
              </div>
            </div>
            <div
              :class="['flex justify-between items-center px-4 py-1.5 text-sm', record?.runStatus === '1' ? 'border-b border-cyan-400/10' : 'border-b border-red-400/15']"
            >
              <div :class="['text-sm', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">跑步时长</div>
              <div :class="['text-sm font-medium text-right min-w-[60px]', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">
                <span v-if="!loading">{{ record.runTime }}分钟</span>
                <div
                  v-else
                  class="inline-block bg-slate-200 rounded animate-pulse"
                  style="width: 80px; height: 16px"
                ></div>
              </div>
            </div>
            <div class="flex justify-between items-center px-4 py-1.5 text-sm">
              <div :class="['text-sm', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">平均配速</div>
              <div :class="['text-sm font-medium text-right min-w-[60px]', record?.runStatus === '1' ? 'text-cyan-200' : 'text-red-200']">
                <span v-if="!loading">{{
                  formatPaceDetail(record.runTime, record.runDistance)
                }}</span>
                <div
                  v-else
                  class="inline-block bg-slate-200 rounded animate-pulse"
                  style="width: 80px; height: 16px"
                ></div>
              </div>
            </div>
          </div>
          <div class="py-1 text-center">
            <button
              class="bg-transparent text-blue-500 text-sm px-4 py-2 disabled:opacity-50 cursor-pointer"
              @click="loadMoreRecords"
              :disabled="isLoading"
            >
              {{ isLoading ? '加载中...' : '加载更多' }}
            </button>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="flex items-center justify-center py-10 w-full">
        <h3 class="text-gray-400 text-base">暂无跑步记录</h3>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, inject, onUnmounted, watch } from 'vue';
import { useRunRecords } from '@/composables/useRunRecords';
import { useDataStore } from '@/composables/useDataStore';

// 注入全局消息方法
const showMessage = inject('showMessage');

const { userInfo, runInfo, runStandard, activityInfo, loading: profileLoading } = useDataStore();

// 使用 composable 管理记录逻辑
const {
  records,
  loading,
  pagination,
  isLoading,
  fetchRecords,
  loadMoreRecords,
  formatCreateTime,
  formatPaceDetail,
} = useRunRecords({ onMessage: showMessage });

// 生命周期
onMounted(() => {
  // 首次加载
  fetchRecords();
});

// 当全局加载状态结束后刷新记录
watch(
  () => profileLoading.value,
  (v, oldV) => {
    if (oldV === true && v === false) {
      fetchRecords();
    }
  },
);
</script>

<style scoped>
.defeated-info {
  font-size: 12px;
  font-weight: 500;
  border-radius: 12px;
  padding: 2px 12px;
  display: inline-block;
  min-width: 48px;
  text-align: center;
  line-height: 1.6;
  background: #b0b0b0;
  color: #fff;
}

.status-success-bg {
  background: rgba(6, 182, 212, 0.15);
  border: 1px solid rgba(6, 182, 212, 0.3);
  color: #67e8f9;
}

.status-error-bg {
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.45);
  color: #fca5a5;
}

.status-invalid-bg {
  background: #b0b0b0;
  color: #fff;
}
</style>
