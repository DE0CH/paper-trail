import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // pdf.js side data, shipped with the app so CJK-encoded PDFs (CID
    // fonts need the cMaps) and PDFs using the 14 standard fonts render
    // fully offline.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts', rename: { stripBase: true } },
      ],
    }),
  ],
  build: {
    outDir: 'dist-web',
    // pdf.js is large; keep the report quiet, we don't code-split it.
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
  },
});
