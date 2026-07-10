import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist-web',
    // pdf.js is large; keep the report quiet, we don't code-split it.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
  },
});
