// Production build: the client bundle, then a server render of the same App
// written into dist/index.html (so the page is complete before any script
// runs), then the sitemap.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

process.env.BUILD_ID = Date.now().toString(36);
const dist = resolve(import.meta.dirname, 'dist');
const ssr = resolve(import.meta.dirname, '.ssr');

await build();
await build({ build: { ssr: 'src/entry-server.jsx', outDir: ssr, emptyOutDir: true }, logLevel: 'warn' });

const { render } = await import(pathToFileURL(resolve(ssr, 'entry-server.js')).href);
const page = resolve(dist, 'index.html');
const html = readFileSync(page, 'utf8');
if (!html.includes('<!--app-->')) throw new Error('dist/index.html has no <!--app--> placeholder');
writeFileSync(page, html.replace('<!--app-->', render()));
rmSync(ssr, { recursive: true, force: true });

const SITE = 'https://greenybeany.dev/triptych/';
const today = new Date().toISOString().slice(0, 10);
const urls = ['', 'watch/', 'terms/', 'privacy/'].map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`);
writeFileSync(resolve(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
console.log('prerendered index.html, wrote sitemap.xml');
