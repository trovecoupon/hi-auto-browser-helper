import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: 'harvester/core/index.ts',
      formats: ['es'],
      fileName: () => 'harvester-core.js',
    },
    outDir: 'dist',
    sourcemap: true,
  },
});
