import { defineConfig } from 'vite';

// A relative base makes the build work on a custom domain and under /beat-bounce/ on github.io.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: 'es',
  },
});
