<template>
  <div class="app flex flex-col relative overflow-hidden bg-stone-950">
    <div class="app-container">
      <router-view />
    </div>
    <Message ref="messageRef" />
  </div>
</template>

<script setup>
import { ref, provide, onMounted, onUnmounted } from 'vue'
import Message from './components/Message.vue'

const messageRef = ref(null)

// 全局消息方法
const showMessage = (message, type = 'info') => {
  messageRef.value?.show(message, type)
}

// 提供给子组件使用
provide('showMessage', showMessage)

const setViewportHeightVar = () => {
  // visualViewport 是移动端最精确的可视区域（地址栏隐藏/键盘弹出时自动变化）
  const vv = window.visualViewport
  const height = vv?.height || window.innerHeight
  document.documentElement.style.setProperty('--app-vh', `${Math.round(Math.max(300, height))}px`)
}

onMounted(() => {
  setViewportHeightVar()
  window.addEventListener('resize', setViewportHeightVar)
  // visualViewport 变化（移动端地址栏、键盘）实时更新高度
  window.visualViewport?.addEventListener('resize', setViewportHeightVar)
})

onUnmounted(() => {
  window.removeEventListener('resize', setViewportHeightVar)
  window.visualViewport?.removeEventListener('resize', setViewportHeightVar)
})
</script>

<style scoped>
.app {
  width: 100%;
  max-width: 100vw;
  overflow-x: hidden;
  overflow-y: hidden;
  /* 多级兜底：vh 最广泛支持 → dvh 动态视口 → JS 精确值 */
  height: 100vh;
  min-height: 100vh;
  max-height: 100vh;
  height: 100dvh;
  min-height: 100dvh;
  max-height: 100dvh;
  height: var(--app-vh, 100vh);
  min-height: var(--app-vh, 100vh);
  max-height: var(--app-vh, 100vh);
}

.app-container {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0 auto;
  max-width: 480px;
  overflow: hidden;
}
</style>
