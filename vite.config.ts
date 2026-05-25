import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

// Version is sourced solely from .env (SYSTEM_VERSION) — see app's docs.
// We do NOT fall back to package.json because keeping versions in sync
// across two files invites drift. If SYSTEM_VERSION is missing or empty
// at build time we surface "dev" so the failure is visible in the UI
// rather than silently using a stale number.
export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const version = (env.SYSTEM_VERSION || '').trim() || 'dev';
  return {
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  };
});
