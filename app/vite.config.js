import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(() => {
  return {
    plugins: [tailwindcss(), vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    optimizeDeps: {
      include: ['leaflet'],
    },
    server: {
      hot: true,
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: 'all',
      cors: true,
      proxy: {
        '/auth': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/clubactivity': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/unirun': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/api/auto-sign': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        '/api/auto-run': {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
