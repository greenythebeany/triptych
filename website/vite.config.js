import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { legalPages } from './legal.js';

// The site lives at https://triptych.greenybeany.dev/. An absolute base (not
// './') keeps fonts, media and scripts working on 404.html, which GitHub Pages
// serves for any missing path.
export default defineConfig({
  plugins: [react(), legalPages()],
  base: '/',
  // Appended to media URLs so browsers fetch new screenshots after a deploy.
  // build.js sets BUILD_ID once, so the client and the prerender agree on it.
  define: { __BUILD__: JSON.stringify(process.env.BUILD_ID || Date.now().toString(36)) },
  build: {
    rollupOptions: {
      // /terms/ and /privacy/ are built from docs/legal (see legal.js).
      input: {
        main: resolve(__dirname, 'index.html'),
        terms: resolve(__dirname, 'terms/index.html'),
        privacy: resolve(__dirname, 'privacy/index.html'),
        watch: resolve(__dirname, 'watch/index.html'),
        notFound: resolve(__dirname, '404.html')
      }
    }
  }
});
