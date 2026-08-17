import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the built site works from a project subpath
  // (bpachter.github.io/density-check/) as well as from a domain root.
  base: './',
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: { port: Number(process.env.PORT) || 5310 },
});
