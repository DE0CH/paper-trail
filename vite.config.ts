import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // pdf.js side data, shipped with the app so CJK-encoded PDFs (CID
    // fonts need the cMaps), PDFs using the 14 standard fonts, and
    // image-compressed (scanned) PDFs render fully offline: the wasm
    // directory holds pdf.js's CCITT fax/JBIG2/JPEG 2000/ICC decoders,
    // without which every scanned page paints blank.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/wasm/*', dest: 'pdfjs/wasm', rename: { stripBase: true } },
      ],
    }),
  ],
  build: {
    outDir: 'dist-web',
    // pdf.js is large; keep the report quiet, we don't code-split it.
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: 'index.html',
      },
    },
  },
  server: {
    port: 5173,
  },
});
