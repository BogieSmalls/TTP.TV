import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  base: '/overlay/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        timer: resolve(__dirname, 'src/timer.html'),
        footer: resolve(__dirname, 'src/footer.html'),
      },
    },
  },
  server: {
    port: 3001,
  },
});
