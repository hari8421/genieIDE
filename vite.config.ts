import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = Number(process.env.GENIE_PORT ?? 8787);

// Extra hosts the dev server may answer for (comma separated). Vite 5 has no
// built-in env var for this, so the allowed host(s) for a tunnel or preview are
// passed explicitly instead of hard-coding a hostname in this file.
const allowedHosts = (process.env.GENIE_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.GENIE_WEB_PORT ?? 5173),
    ...(allowedHosts.length ? { allowedHosts } : {}),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
