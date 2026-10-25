import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A classic script can open under file:// without a module loader or a server.
export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/offline',
    lib: {
      entry: 'src/main.tsx',
      name: 'SpaceMap',
      formats: ['iife'],
      fileName: () => 'app.js',
      cssFileName: 'app',
    },
    cssCodeSplit: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
