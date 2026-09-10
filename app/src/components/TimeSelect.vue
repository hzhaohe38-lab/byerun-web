<template>
  <div class="flex-1 flex items-center bg-cyan-500/10 border border-cyan-400/20 rounded-md px-3 py-2 min-w-0">
    <select
      :value="modelValue.h"
      @change="setHour"
      class="w-full bg-transparent text-center text-sm font-mono text-cyan-200 outline-none appearance-none"
    >
      <option v-for="h in hours" :key="h" :value="h">{{ pad2(h) }}</option>
    </select>
    <span class="text-cyan-500/40 font-bold">:</span>
    <select
      :value="modelValue.m"
      @change="setMinute"
      class="w-full bg-transparent text-center text-sm font-mono text-cyan-200 outline-none appearance-none"
    >
      <option v-for="m in minutes" :key="m" :value="m">{{ pad2(m) }}</option>
    </select>
    <span v-if="label" class="text-[9px] text-cyan-500/50 pr-1 italic">{{ label }}</span>
  </div>
</template>

<script setup>
const props = defineProps({
  modelValue: { type: Object, required: true },
  label: { type: String, default: '' },
});
const emit = defineEmits(['update:modelValue']);

const hours = Array.from({ length: 24 }, (_, i) => i);
const minutes = Array.from({ length: 60 }, (_, i) => i);

const pad2 = (n) => String(n).padStart(2, '0');

const setHour = (event) => {
  emit('update:modelValue', { ...props.modelValue, h: Number(event.target.value) });
};

const setMinute = (event) => {
  emit('update:modelValue', { ...props.modelValue, m: Number(event.target.value) });
};
</script>

<style scoped>
select {
  -webkit-appearance: none;
  -moz-appearance: none;
  background: transparent;
}

option {
  background-color: #042f2e;
  color: #2dd4bf;
}
</style>
